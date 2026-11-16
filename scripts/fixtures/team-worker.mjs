// Offline subprocess fixture: production loop/client, scripted decisions, and a
// shared SQLite world. No Minecraft connection or model API is used.
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTeamClient } from '../../src/building/team-client.js';
import { createBuildingLoop } from '../../src/building/loop-agent.js';
import { createLazyBuildingModel } from '../../src/building/model.js';
import { extractNativeActions } from '../../src/building/native-actions.js';

const name = process.env.TEST_AGENT_NAME;
const spatial = process.env.TEST_SPATIAL === '1';
const scoped = process.env.TEST_SCOPED === '1';
const cooperative = process.env.TEST_COOPERATIVE === '1';
const concurrent = spatial || scoped || cooperative;
const db = new DatabaseSync(process.env.TEST_WORLD);
db.exec('PRAGMA busy_timeout=5000;');
const read = db.prepare('SELECT position, block FROM blocks');
const put = db.prepare('INSERT INTO blocks(position,block) VALUES (?,?) ON CONFLICT(position) DO UPDATE SET block=excluded.block');
const record = db.prepare('INSERT INTO operations(agent,position) VALUES (?,?)');
let blocks = new Map();
const refresh = () => { blocks = new Map(read.all().map(row => [row.position, row.block])); };
const world = {
    snapshot() { refresh(); return { dimension: 'overworld', position: [0, 0, 4], gameMode: 'creative' }; },
    read: pos => blocks.get(pos.join(',')) ?? (pos[1] < 0 ? 'stone' : 'air'),
    async prepare() { refresh(); },
    async place(cell) {
        if (process.env.TEST_CRASH_AGENT === name) process.exit(19);
        if (concurrent && !db.prepare('SELECT 1 FROM activity WHERE agent=?').get(name)) {
            db.prepare('INSERT INTO activity(agent,started) VALUES (?,?)').run(name, Date.now());
            const deadline = Date.now() + 8000;
            while (db.prepare('SELECT count(*) AS n FROM activity').get().n < 2) {
                if (Date.now() > deadline) throw new Error('Parallel worker barrier timed out: construction is serialized');
                await new Promise(resolve => setTimeout(resolve, 30));
            }
        }
        await new Promise(resolve => setTimeout(resolve, 80));
        put.run(cell.pos.join(','), cell.block); record.run(name, cell.pos.join(','));
        refresh(); return 'placed';
    },
    async digBlock(pos) { put.run(pos.join(','), 'air'); refresh(); return 'removed'; }
};
const plan = done => ({ action: 'update_plan', steps: [{ id: 'build', title: 'Complete assigned construction',
    success: 'All required cells match the blueprint', status: done ? 'done' : 'running', evidence: done ? 'Observed all assigned cells matching' : '' }] });
const scriptedAdapter = {
    modelName: 'offline-team-fixture',
    async sendRequest(turns, instructions, stop, options) {
        if (options.purpose === 'blueprint') return JSON.stringify({ summary: 'Two foundations and a dependent upper block',
            coverage: [{ requirementId: 'goal', evidence: 'Two foundations and the supported upper block' }],
            shapes: spatial ? [
                { kind: 'box', part: 'bottom', min: [0, 0, 0], max: [3, 0, 2], block: 'white_concrete' },
                { kind: 'box', part: 'middle', min: [1, 1, 1], max: [2, 1, 1], block: 'pink_concrete' },
                { kind: 'point', part: 'candle', at: [1, 2, 1], block: 'red_concrete' }
            ] : [
                { kind: 'point', part: scoped || cooperative ? 'structure' : 'west', at: [0, 0, 0], block: 'stone' },
                { kind: 'point', part: scoped || cooperative ? 'structure' : 'east', at: [2, 0, 0], block: 'stone' },
                { kind: 'point', part: scoped || cooperative ? 'structure' : 'upper', at: [0, 1, 0], block: 'stone' }
            ] });
        const context = JSON.parse(turns[0].content); if (process.env.TEST_DUMP_LEAD === name) console.error("LEADCTX tasks=" + JSON.stringify(context.team.tasks) + " feed=" + JSON.stringify(context.team.feed));
        if (!instructions.includes('Call the provided native functions directly') || instructions.includes('ACTIONS (fields')) {
            throw new Error('Production startup lost the native decision protocol');
        }
        let action = decide(context);
        const functionName = action.action === 'tool' || action.action === 'skill' ? action.name : action.action;
        if (!options.nativeFunctions.some(fn => fn.name === functionName)) {
            action = { action: 'tool', name: 'get_tool_help', args: { name: functionName } };
        }
        const { action: kind, name: toolName, args, ...fields } = action;
        return extractNativeActions({ status: 'completed', output: [{ type: 'function_call',
            name: kind === 'tool' || kind === 'skill' ? toolName : kind,
            arguments: JSON.stringify(kind === 'tool' || kind === 'skill' ? args : fields)
        }] }, options.nativeFunctions);
    }
};
const model = createLazyBuildingModel({ api: 'deepseek_responses', model: 'offline-team-fixture' }, () => scriptedAdapter);
function decide(context) {
    if (context.coordinationOnly) {
        const proposal = context.team.proposals.find(p => p.to === name && p.status === 'proposed');
        if (proposal) return { action: 'tool', name: 'respond_task_share', args: { proposalId: proposal.id, accept: true } };
        return { action: 'end_turn' };
    }
    if (!context.plan.steps.length) return plan(false);
    if (name === 'lead') {
        if (!context.blueprint && !context.observation) return { action: 'tool', name: 'observe_environment',
            args: { region: { min: [0,-1,0], max: [3,3,2] } } };
        if (!context.blueprint) return { action: 'skill', name: 'design_blueprint', args: {} };
        const tasks = context.team.tasks ?? [];
        if (spatial && !tasks.length) return { action: 'tool', name: 'prepare_parallel_build', args: {} };
        if (scoped) for (const [recipient, positions] of [['alpha', [[0,0,0], [0,1,0]]], ['beta', [[2,0,0]]]]) {
            if (!tasks.some(t => t.key === recipient)) return { action: 'tool', name: 'delegate_task', args: {
                key: recipient, recipient, partIds: ['part-1'], scope: { positions }, description: 'Build assigned cells of shared module', success: 'Assigned cells match blueprint'
            } };
        }
        if (cooperative && !tasks.length) return { action: 'tool', name: 'delegate_task', args: {
            key: 'module', recipient: 'alpha', partIds: ['part-1'], description: 'Build full module with help as needed', success: 'All three module cells match'
        } };
        for (let i = 0; !spatial && !scoped && !cooperative && i < 3; i++) if (!tasks.some(t => t.key === 'part-' + (i + 1))) return {
            action: 'tool', name: 'delegate_task', args: { key: 'part-' + (i + 1), recipient: i === 1 ? 'beta' : 'alpha',
                partIds: ['part-' + (i + 1)], description: 'Build part ' + (i + 1), success: 'Part matches the blueprint',
                dependsOn: i === 2 ? tasks.filter(t => t.key !== 'part-3').map(t => t.id) : [] }
        };
        if (tasks.some(t => t.status !== 'completed')) return process.env.TEST_POLLING_LEAD === '1' ?
            { action: 'tool', name: 'list_tasks', args: {} } : { action: 'wait_for_team', reason: 'Workers are constructing the shared blueprint' };
        if (context.plan.steps.some(step => step.status !== 'done')) return plan(true);
        return { action: 'finish', summary: 'Team construction verified', requirementReview: [{ requirementId: 'goal', satisfied: true, evidence: 'All three required blocks were inspected in the shared world' }] };
    }
    if (cooperative && name === 'alpha') {
        const proposal = context.team.proposals.find(p => p.from === name);
        if (!proposal) return { action: 'tool', name: 'propose_task_share', args: { key: 'help', recipient: 'beta', partIds: ['part-1'],
            scope: { positions: [[2,0,0]] }, description: 'Build the independent foundation cell', success: 'One cell matches stone' } };
        if (proposal.status === 'proposed') return { action: 'wait_for_team', reason: 'Waiting for teammate agreement' };
        if (proposal.status === 'accepted') return { action: 'tool', name: 'commit_task_share', args: { proposalId: proposal.id } };
    }
    const next = context.constructionChecklist.parts.find(p => p.status !== 'verified');
    if (next) {
        const last = context.recentEvents.at(-1);
        if (last?.name === 'inspect_part' && last.output.suggestions?.actions.length) return last.output.suggestions.actions[0];
        return { action: 'tool', name: 'inspect_part', args: { partId: next.id } };
    }
    if (context.team.assignment.helpers.some(task => task.status !== 'completed')) return { action: 'wait_for_team', reason: 'Waiting for shared work' };
    if (context.plan.steps.some(step => step.status !== 'done')) return plan(true);
    return { action: 'complete_task', summary: 'Assigned parts verified' };
}
process.on('message', message => {
    if (message?.type === 'team_transcript') console.log(JSON.stringify({ transcript: message }));
});
const client = createTeamClient({ name, spec: JSON.parse(process.env.MINDCRAFT_TEAM_SPEC) });
const controller = createBuildingLoop({ world, model, team: client, peers: client.peers, agentName: name,
    sendMessage: async () => ({ status: 'sent' }), maxModelRequests: 40,
    async save(id, type, value) {
        const directory = join(process.cwd(), 'bots', name, 'builds');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, id + '.' + type + '.json'), JSON.stringify(value));
    }, report(event, data) {
        if (concurrent && name !== 'lead' && event === 'result' && data.status === 'completed') db.prepare('UPDATE activity SET ended=? WHERE agent=?').run(Date.now(), name);
        if (event === 'result') console.log(JSON.stringify({ name, event, status: data.status, reason: data.reason }));
    }
});
client.attach(controller);
if (name === 'lead') await controller.start({ request: 'Build two foundations and an upper block together', owner: 'tester', origin: [0, 0, 0], dimension: 'overworld' });
process.once('disconnect', () => { client.close(); db.close(); process.exit(0); });
