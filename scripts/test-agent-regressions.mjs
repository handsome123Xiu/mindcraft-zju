import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileBlueprint, prepareAssignment } from '../src/building/blueprint.js';
import { createBuildingTools } from '../src/building/tools.js';
import { inspectPart } from '../src/building/checklist.js';
import { createLazyBuildingModel } from '../src/building/model.js';
import { DeepSeekResponses } from '../src/models/deepseek_responses.js';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { createBlueprintSkill } from '../src/building/planner.js';
import { createTeamClient } from '../src/building/team-client.js';
import { createTeamRuntime } from '../src/building/team-runtime.js';
import { TEAM_PRESETS } from '../src/building/team-state.js';

const shapes = [0, 12].map(x => ({ kind: 'box', part: String(x), min: [x,0,0], max: [x+4,1,4], block: 'white_wool' }));
const blueprint = compileBlueprint({ shapes }, [0,0,0]);
const assignment = { version: 1, dimension: 'overworld', blueprint };
assert(!prepareAssignment(assignment).expected.some(cell => cell.pos[0] === 8), 'the gap between cakes is not clearance');
const hollow = compileBlueprint({ shapes: [{ kind: 'shell', min: [0,0,0], max: [2,2,2], block: 'stone' },
    { kind: 'opening', min: [1,0,0], max: [1,1,0] }] }, [0,0,0]);
assert(hollow.clearance.some(pos => pos.join() === '1,1,1'), 'interior air is still verified');
assert(hollow.clearance.some(pos => pos.join() === '1,0,0'), 'openings are still verified');
assert.throws(() => prepareAssignment({ ...assignment, blueprint: { ...blueprint, clearance: [[0,0,0]] } }), /冲突/);

const blocks = new Map();
const world = {
    snapshot: () => ({ dimension: 'overworld', position: [0,0,6], gameMode: 'creative' }),
    read: pos => blocks.has(pos.join()) ? blocks.get(pos.join()) : pos[1] < 0 ? 'stone' : 'air',
    async prepare() {},
    async place(cell) { blocks.set(cell.pos.join(), cell.block); return 'placed'; },
    async digBlock(pos) { blocks.set(pos.join(), 'air'); return 'removed'; }
};
const job = { request: 'two cakes', origin: [0,0,0], dimension: 'overworld', placed: {}, removed: {}, events: [],
    assignmentVersion: 0, plan: { requirements: [{ id: 'goal', description: 'two cakes' }], steps: [] }, observation: {} };
let published = 0;
const tools = createBuildingTools({ world, job, checkpoint: async () => {},
    team: { runtime: true, self: 'lead', spec: () => TEAM_PRESETS.centralized(['lead','a','b']), publish: async () => { published++; return { assignmentVersion: 1 }; } },
    design: async () => ({ blueprint, shapes, summary: 'two cakes', coverage: [{ requirementId: 'goal', evidence: 'two separate volumes' }] }) });
blocks.set('0,0,0', 'sandstone');
await assert.rejects(tools.useSkill('design_blueprint', {}), error => error.code === 'SITE_CONFLICT' && error.expected.conflictCount === 1);
assert.equal(published, 0);
assert.equal(job.assignment, undefined, 'failed preflight must not publish/mutate assignment');
assert.equal(blocks.get('0,0,0'), 'sandstone');
blocks.set('0,0,0', null);
await assert.rejects(tools.useSkill('design_blueprint', {}), error => error.code === 'SITE_CONFLICT');
blocks.delete('0,0,0'); blocks.set('8,0,0', 'sandstone');
await tools.useSkill('design_blueprint', {});
assert.equal(published, 1, 'an existing structure in the gap is preserved');
assert.equal((await tools.call('get_tool_help', { name: 'design_blueprint' })).name, 'design_blueprint');
blocks.set('0,0,0', 'sandstone');
const repair = inspectPart(job, world, 'part-1').suggestions.actions[0];
assert.equal(repair.name, 'dig_block'); assert.equal(repair.args.expectedBlock, 'sandstone');
assert(!inspectPart(job, world, 'part-1').suggestions.actions.some(a => a.name === 'place_block' && a.args.position.join() === '0,0,0'));
const localTools = createBuildingTools({ world, job, checkpoint: async () => {} });
await localTools.call(repair.name, repair.args);
assert.equal(world.read([0,0,0]), 'air');
assert(inspectPart(job, world, 'part-1').suggestions.actions.some(a => a.name.startsWith('place_')));

// Startup wrapper -> real loop -> real Responses transport (mock HTTP), including
// an invalid native response and budget exhaustion followed by one design retry.
const directory = await mkdtemp(join(tmpdir(), 'mindcraft-regressions-'));
const previousCwd = process.cwd(), previousFetch = globalThis.fetch;
try {
    process.chdir(directory); blocks.clear();
    const config = { api: 'deepseek_responses', model: 'deepseek-flash' };
    let created = 0, designs = 0, decisions = 0;
    const adapter = Object.assign(Object.create(DeepSeekResponses.prototype), { provider: 'DeepSeek',
        modelName: config.model, key: 'fake', url: 'https://example.invalid/responses',
        params: { max_output_tokens: 4096, reasoning: { effort: 'high' } } });
    const model = createLazyBuildingModel(config, () => { created++; return adapter; });
    assert.equal(model.decisionProtocol, 'native_functions'); assert.equal(created, 0);
    const plan = done => ({ steps: [{ id: 'build', title: 'Build', success: 'both cells verified',
        status: done ? 'done' : 'running', evidence: done ? 'observed both stone cells' : '' }] });
    const calls = [ ['batch', {}], ['update_plan', plan(false)],
        ['observe_environment', { region: { min: [0,-1,0], max: [1,1,0] } }], ['design_blueprint', {}],
        ['inspect_part', { partId: 'part-1' }],
        ['place_row', { start: [0,0,0], end: [1,0,0], block: 'stone', partId: 'part-1', assignmentVersion: 1 }],
        ['update_plan', plan(true)], ['finish', { summary: 'verified', requirementReview: [{ requirementId: 'goal', satisfied: true, evidence: 'two stone cells verified' }] }] ];
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        let data;
        if (body.tools) {
            assert(body.instructions.includes('Call the provided native functions directly'));
            assert(!body.instructions.includes('ACTIONS (fields'));
            assert.equal(body.reasoning.effort, 'none');
            if (decisions === 1) assert(body.input[0].content.includes('call the provided native function directly'));
            const [name, args] = calls[decisions++];
            if (name !== 'batch') assert(body.tools.some(fn => fn.name === name), name + ' must be offered');
            data = { status: 'completed', output: [{ type: 'function_call', name, arguments: JSON.stringify(args) }] };
        } else {
            designs++;
            assert.equal(body.max_output_tokens, 8192);
            if (designs === 1) data = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 8192 } };
            else {
                assert.equal(body.reasoning.effort, 'none');
                data = { status: 'completed', output_text: JSON.stringify({ summary: 'platform', coverage: [{ requirementId: 'goal', evidence: 'two cells' }],
                    shapes: [{ kind: 'box', min: [0,0,0], max: [1,0,0], block: 'stone' }] }) };
            }
        }
        return { ok: true, status: 200, json: async () => data };
    };
    const controller = createBuildingLoop({ model, world, save: async () => {} });
    const result = await controller.start({ request: 'Build two stone cells', origin: [0,0,0], dimension: 'overworld', owner: 'tester' });
    assert.equal(result.status, 'completed', result.reason);
    assert.equal(result.verified, 2); assert.equal(designs, 2); assert.equal(created, 1);
    assert.equal(adapter.params.reasoning.effort, 'high', 'per-request recovery must not mutate profile');
    let retries = 0;
    await assert.rejects(createBlueprintSkill({ async sendRequest() { retries++; throw Object.assign(new Error('truncated'), { code: 'API_INCOMPLETE', incompleteReason: 'max_output_tokens' }); } })({ request: 'x', origin: [0,0,0] }), /truncated/);
    assert.equal(retries, 2, 'design retries are bounded');

    adapter.url = 'https://api.deepseek.com/responses';
    adapter.params.reasoning = { effort: 'none' };
    const conflict = { shapes: [{ kind: 'point', at: [0,0,0], block: 'stone' },
        { kind: 'point', at: [0,0,0], block: 'glass' }] };
    const rejectedDraft = JSON.stringify(conflict);
    let attempts = 0;
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.text.format, { type: 'json_object' });
        assert.equal(body.reasoning.effort, attempts === 0 ? 'none' : 'low');
        if (attempts++ > 0) {
            const { blueprintRepair } = JSON.parse(body.input[1].content);
            assert.equal(blueprintRepair.field, 'shapes[1].block');
            assert.equal(blueprintRepair.rejectedDraft, rejectedDraft);
        }
        return { ok: true, status: 200, json: async () => ({ status: 'completed', output_text: rejectedDraft }) };
    };
    await assert.rejects(createBlueprintSkill(model)({ request: 'x', origin: [0,0,0] }),
        error => error.code === 'INVALID_BLUEPRINT_GEOMETRY' && error.field === 'shapes[1].block');
    assert.equal(attempts, 3, 'repeated geometry rejection stops after two repairs');
    assert.deepEqual(adapter.params.reasoning, { effort: 'none' }, 'repair must not change the profile');
} finally { globalThis.fetch = previousFetch; process.chdir(previousCwd); await rm(directory, { recursive: true, force: true }); }

// A child that exhausts its model/progress budget must not keep renewing a
// running task forever. Manual/team pauses still retain resumable ownership.
const spec = TEAM_PRESETS.centralized(['lead','a','b']);
const runtime = createTeamRuntime({ spec });
const sessions = Object.fromEntries(Object.keys(spec.agents).map(name => [name, runtime.connect(name)]));
const call = (name, method, args = {}) => runtime.request(name, sessions[name], method, args);
const channel = new EventEmitter(); channel.connected = true;
channel.send = (message, callback) => {
    try { const result = call('a', message.method, message.args); queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, result })); callback?.(); }
    catch (error) { queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, error: error.message })); callback?.(); }
};
const client = createTeamClient({ name: 'a', spec, channel, onError: error => { throw error; } });
try {
    call('lead', 'open_run', { id: 'run', request: 'cakes', owner: 'tester', origin: [0,0,0], dimension: 'overworld' });
    call('lead', 'publish', { runId: 'run', previousVersion: 0, assignment, design: { origin: [0,0,0] } });
    call('lead', 'delegate', { runId: 'run', blueprintVersion: 1, key: 'cake', recipient: 'a', partIds: ['part-1'], description: 'cake', success: 'verified' });
    const taken = call('a', 'take_task');
    const child = { teamRunId: 'run', assignmentVersion: 1, teamTask: taken.task };
    await client.settle(child, { status: 'paused', stopRequested: true });
    assert.equal(runtime.snapshot().tasks[0].status, 'running');
    await client.settle(child, { status: 'paused', reason: 'no progress' });
    assert.equal(runtime.snapshot().tasks[0].status, 'blocked');
    assert(call('lead', 'inbox').some(event => event.kind === 'task_result'));
    const task = runtime.snapshot().tasks[0];
    call('lead', 'reassign', { runId: 'run', taskId: task.id, recipient: 'b' });
    assert(call('b', 'take_task'), 'released failed task can be taken by another worker');
} finally { client.close(); runtime.close(); }
console.log('Agent regressions passed: startup native protocol, bounded design recovery, clear site publication, replacement guidance and failed-task recovery.');
