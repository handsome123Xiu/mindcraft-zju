import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createTeamRuntime } from '../src/building/team-runtime.js';
import { TEAM_PRESETS, queryClaims } from '../src/building/team-state.js';
import { compileBlueprint } from '../src/building/blueprint.js';
import { createTeamSupervisor } from '../console/team-supervisor.js';
import { createBuildingTools } from '../src/building/tools.js';

const spec = TEAM_PRESETS.centralized(['lead', 'alpha', 'beta']);
// Manual strategy remains covered independently of the automatic preset.
spec.rules.assignment = 'lead-assigns';
spec.edges = spec.edges.filter(edge => edge.type === 'delegate');
const assignment = { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes: [
    { kind: 'point', part: 'a', at: [0, 0, 0], block: 'stone' },
    { kind: 'point', part: 'b', at: [2, 0, 0], block: 'stone' }
] }, [0, 0, 0]) };
const open = runtime => {
    const sessions = Object.fromEntries(['lead', 'alpha', 'beta'].map(name => [name, runtime.connect(name)]));
    const call = (name, method, args = {}) => runtime.request(name, sessions[name], method, args);
    for (const name of Object.keys(sessions)) call(name, 'heartbeat', { status: 'idle', canAcceptTask: true });
    call('lead', 'open_run', { id: 'run', request: 'Build', owner: 'tester', origin: [0, 0, 0], dimension: 'overworld' });
    call('lead', 'publish', { runId: 'run', previousVersion: 0, assignment, design: { origin: [0, 0, 0] } });
    return { sessions, call };
};
const delegate = (key, recipient, partIds, dependsOn = []) => ({ runId: 'run', blueprintVersion: 1, key, recipient, partIds, dependsOn, description: 'Build ' + key, success: 'Matches blueprint' });
const scoped = task => ({ runId: task.runId, taskId: task.id, token: task.token, blueprintVersion: task.blueprintVersion });

// Graph permissions, dependency order, idempotency, lease fencing, and evidence.
{
    const runtime = createTeamRuntime({ spec });
    try {
        const { call, sessions } = open(runtime);
        assert.throws(() => call('alpha', 'delegate', delegate('bad', 'beta', ['part-1'])), /连线/);
        assert.throws(() => call('alpha', 'message', { runId: 'run', recipient: 'beta', text: 'hello' }), /连线/);
        const first = call('lead', 'delegate', delegate('first', 'alpha', ['part-1']));
        assert.equal(call('lead', 'delegate', delegate('first', 'alpha', ['part-1'])).taskId, first.taskId);
        assert.throws(() => call('lead', 'delegate', delegate('first', 'beta', ['part-1'])), /不同委托/);
        call('lead', 'delegate', delegate('second', 'beta', ['part-2'], [first.taskId]));
        assert.equal(call('beta', 'take_task'), null, 'dependency prevents premature work');
        const taken = call('alpha', 'take_task');
        const scope = scoped(taken.task);
        call('lead', 'pause_run', { runId: 'run' });
        assert.throws(() => call('alpha', 'assert_write', { ...scope, partId: 'part-1', positions: [[0, 0, 0]] }), /暂停/);
        assert.equal(call('beta', 'take_task'), null);
        call('lead', 'resume_run', { runId: 'run' });
        assert.equal(call('alpha', 'assert_write', { ...scope, partId: 'part-1', positions: [[0, 0, 0]] }).status, 'allowed');
        assert.equal(call('alpha', 'take_task'), null, 'a task is delivered only once per attempt');
        assert.throws(() => call('lead', 'publish', { runId: 'run', previousVersion: 1, assignment }), /现有子任务/);
        assert.throws(() => call('alpha', 'assert_write', { ...scope, partId: 'part-2', positions: [[2, 0, 0]] }), /范围/);
        assert.throws(() => call('alpha', 'assert_write', { ...scope, blueprintVersion: 0, partId: 'part-1', positions: [[0, 0, 0]] }), /旧蓝图/);
        assert.throws(() => call('alpha', 'task_result', { ...scope, status: 'completed', summary: 'done' }), /证据/);
        runtime.disconnect('alpha', sessions.alpha);
        const takeover = call('beta', 'take_task');
        assert.equal(takeover.task.id, taken.task.id);
        assert.equal(takeover.task.attempt, 2);
        sessions.alpha = runtime.connect('alpha');
        assert.throws(() => call('alpha', 'assert_write', { ...scope, partId: 'part-1', positions: [[0, 0, 0]] }), /失效/);
        const complete = { ...scoped(takeover.task), status: 'completed', summary: 'verified', evidence: [{ partId: 'part-1', total: 1, remaining: 0 }] };
        call('beta', 'task_result', complete);
        call('beta', 'task_result', complete); // lost response/retry is idempotent
        assert(call('lead', 'inbox').some(m => m.kind === 'task_result' && m.payload.taskId === first.taskId));
        const next = call('beta', 'take_task');
        assert.deepEqual(next.task.partIds, ['part-2']);
        assert.throws(() => call('lead', 'finish_run', { runId: 'run' }), /未完成/);
        call('beta', 'task_result', { ...scoped(next.task), status: 'completed', summary: 'verified', evidence: [{ partId: 'part-2', total: 1, remaining: 0 }] });
        call('lead', 'finish_run', { runId: 'run' });
    } finally { runtime.close(); }
}

// Tool layer cannot bypass a lease by omitting partId, or certify missing cells.
{
    const runtime = createTeamRuntime({ spec });
    try {
        const { call } = open(runtime);
        call('lead', 'delegate', delegate('part', 'alpha', ['part-1']));
        const { task, run } = call('alpha', 'take_task');
        const job = { origin: [0, 0, 0], dimension: 'overworld', owner: 'tester', assignment: run.assignment,
            assignmentVersion: 1, design: run.design, teamTask: task, teamRunId: run.id, placed: {}, removed: {} };
        const team = { runtime: true, self: 'alpha', spec: () => spec,
            queryClaims: () => call('alpha', 'claims', { runId: run.id }),
            assertWrite: (job, partId, positions) => call('alpha', 'assert_write', { ...scoped(task), partId, positions }) };
        let placed = 0;
        const tools = createBuildingTools({ job, team, world: { snapshot: () => ({ dimension: 'overworld' }), read: () => 'air', async place() { placed++; } } });
        await assert.rejects(tools.call('place_block', { position: [0, 0, 0], block: 'stone' }), /partId/);
        await assert.rejects(tools.call('dig_block', { position: [2, 0, 0], expectedBlock: 'stone', partId: 'part-1' }), /超出/);
        assert.throws(() => tools.inspectTask(), /验收/);
        assert.equal(placed, 0);
    } finally { runtime.close(); }
}

// Durable queue survives supervisor restart with a new execution token.
const directory = await mkdtemp(join(tmpdir(), 'mindcraft-team-test-'));
try {
    const claimDir = join(directory, 'claims');
    await queryClaims(claimDir);
    const competitors = ['alpha', 'beta'].map(name => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/claim-worker.mjs', import.meta.url)), claimDir, name],
            { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
        const ready = new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
        const exited = new Promise(resolve => child.once('exit', resolve));
        return { child, ready, exited };
    });
    await Promise.all(competitors.map(c => c.ready));
    const claimed = await Promise.all(competitors.map(({ child }) => new Promise(resolve => { child.once('message', resolve); child.send('go'); })));
    await Promise.all(competitors.map(c => c.exited));
    assert.deepEqual(claimed.map(r => r.status).sort(), ['claimed', 'conflict'], 'cross-process claim must have exactly one winner');
    const path = join(directory, 'restart.sqlite');
    let runtime = createTeamRuntime({ spec, path });
    const { call } = open(runtime);
    call('lead', 'delegate', delegate('restart', 'alpha', ['part-1']));
    const before = call('alpha', 'take_task');
    runtime.close();
    runtime = createTeamRuntime({ spec, path, pauseOnRestore: true });
    const session = runtime.connect('alpha');
    assert.equal(runtime.request('alpha', session, 'take_task'), null, 'restored workers wait for explicit coordinator resume');
    const leadSession = runtime.connect('lead');
    runtime.request('lead', leadSession, 'resume_run', { runId: 'run' });
    const after = runtime.request('alpha', session, 'take_task');
    assert.equal(after.task.id, before.task.id);
    assert.notEqual(after.task.token, before.task.token);
    runtime.close();

    // Real child processes use the production supervisor, IPC client, task
    // runtime, model loop, blueprint skill and physical-operation tool layer.
    for (const scenario of ['normal', 'takeover', 'spatial', 'scoped', 'cooperative', 'polling']) {
    const crashAgent = scenario === 'takeover' ? 'alpha' : null;
    const spatial = scenario === 'spatial';
    const scopedWork = scenario === 'scoped' || scenario === 'polling', cooperative = scenario === 'cooperative';
    const scenarioDir = join(directory, scenario);
    await mkdir(scenarioDir);
    const worldPath = join(scenarioDir, 'world.sqlite');
    const worldDb = new DatabaseSync(worldPath);
    worldDb.exec('PRAGMA journal_mode=WAL; CREATE TABLE blocks(position TEXT PRIMARY KEY, block TEXT); CREATE TABLE operations(agent TEXT, position TEXT); CREATE TABLE activity(agent TEXT PRIMARY KEY, started INTEGER, ended INTEGER)');
    await writeFile(join(scenarioDir, 'profile.json'), JSON.stringify({ model: { api: cooperative ? 'deepseek_responses' : 'course_responses', model: 'offline' } }));
    const logs = [];
    const supervisor = createTeamSupervisor({ root: scenarioDir, log: line => logs.push(line),
        launch(executable, args, options) {
            const name = args[args.indexOf('--name') + 1];
            return spawn(executable, [fileURLToPath(new URL('./fixtures/team-worker.mjs', import.meta.url))], {
                ...options, env: { ...options.env, TEST_AGENT_NAME: name, TEST_WORLD: worldPath, TEST_CRASH_AGENT: crashAgent ?? '',
                    TEST_SPATIAL: spatial ? '1' : '', TEST_SCOPED: scopedWork ? '1' : '', TEST_COOPERATIVE: cooperative ? '1' : '', TEST_POLLING_LEAD: scenario === 'polling' ? '1' : '' }
            });
        }
    });
    try {
        await supervisor.start({ spec: spatial || scopedWork || cooperative ? TEAM_PRESETS.centralized(['lead', 'alpha', 'beta']) : spec, settings: { port: 25565, profiles: ['./profile.json'] } });
        const deadline = Date.now() + 20000;
        let snapshot;
        do {
            await new Promise(resolve => setTimeout(resolve, 100));
            snapshot = supervisor.snapshot();
        } while (!snapshot.runs.some(run => run.status === 'completed') && Date.now() < deadline);
        assert(snapshot.runs.some(run => run.status === 'completed'), 'team did not finish:\n' + logs.join('\n') + '\n' + JSON.stringify(snapshot.tasks));
        assert.equal(snapshot.tasks.length, spatial || scopedWork || cooperative ? 2 : 3);
        assert(snapshot.tasks.every(task => task.status === 'completed'));
        const expected = spatial ? [...Array.from({ length: 4 }, (_, x) => Array.from({ length: 3 }, (_, z) => `${x},0,${z}`)).flat(), '1,1,1', '2,1,1', '1,2,1'].sort() : ['0,0,0', '0,1,0', '2,0,0'];
        assert.deepEqual(worldDb.prepare('SELECT position FROM blocks ORDER BY position').all().map(r => r.position), expected);
        if (spatial || scopedWork || cooperative) {
            assert(snapshot.tasks.every(task => task.dependsOn.length === 0));
            const activity = worldDb.prepare('SELECT * FROM activity').all();
            assert.equal(activity.length, 2);
            assert(Math.max(...activity.map(row => row.started)) < Math.min(...activity.map(row => row.ended)), 'both workers must enter construction before either finishes');
            if (scopedWork || cooperative) assert(snapshot.tasks.every(task => task.partIds.join() === 'part-1'), 'workers must share the same unchanged module');
            if (cooperative) assert(snapshot.proposals.some(p => p.status === 'committed'), 'work must be negotiated before sharing');
        }
        assert.deepEqual(worldDb.prepare('SELECT DISTINCT agent FROM operations ORDER BY agent').all().map(r => r.agent), crashAgent ? ['beta'] : ['alpha', 'beta']);
        if (crashAgent) assert(snapshot.tasks.some(task => task.attempt === 2 && task.to === 'beta'));
        const root = snapshot.runs[0];
        let saved;
        for (let attempt = 0; attempt < 50; attempt++) {
            try { saved = JSON.parse(await readFile(join(scenarioDir, 'bots', 'lead', 'builds', root.id + '.state.json'), 'utf8')); }
            catch { /* checkpoint may be in flight */ }
            if (saved?.status === 'completed') break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(saved.status, 'completed');
        assert.equal(saved.result.structuralVerification, 'machine_verified');
        if (scenario === 'polling') assert(saved.modelRequests < 30, 'polling coordinator must suspend and finish within budget');
        else assert(saved.events.some(event => event.name === 'wait_for_team'));
    } finally { await supervisor.stop(); supervisor.close(); worldDb.close(); }
    }
} finally { await rm(directory, { recursive: true, force: true }); }

console.log('Team runtime checks passed: cross-process claim exclusion, graph enforcement, durable delegation, dependencies, idempotency, fenced takeover, scoped construction, and real three-process building with worker-crash recovery.');
