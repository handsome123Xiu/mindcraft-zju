import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamRuntime } from '../src/building/team-runtime.js';
import { createTeamClient } from '../src/building/team-client.js';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { createTeamSupervisor } from '../console/team-supervisor.js';
import { TEAM_PRESETS } from '../src/building/team-state.js';
import { compileBlueprint } from '../src/building/blueprint.js';

const spec = TEAM_PRESETS.centralized(['lead', 'a', 'b']);
const assignment = { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes: [
    { kind: 'point', at: [0,0,0], block: 'stone' }, { kind: 'point', at: [2,0,0], block: 'stone' }
] }, [0,0,0]) };
const runtime = createTeamRuntime({ spec });
const sessions = Object.fromEntries(Object.keys(spec.agents).map(name => [name, runtime.connect(name)]));
const call = (name, method, args = {}) => runtime.request(name, sessions[name], method, args);
const channel = new EventEmitter(); channel.connected = true;
channel.send = (message, callback) => {
    try { const result = call('lead', message.method, message.args); queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, result })); callback?.(); }
    catch (error) { queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, error: error.message })); callback?.(); }
};
const errors = [];
const client = createTeamClient({ name: 'lead', spec, channel, onError: error => errors.push(error.message) });
let taken;
const saved = new Map();
const controller = createBuildingLoop({ team: client, agentName: 'lead',
    world: { snapshot: () => ({ dimension: 'overworld', position: [0,0,0] }), read: () => 'air' },
    save: async (id, type, value) => saved.set(id + ':' + type, structuredClone(value)),
    model: { async sendRequest(turns, instructions, stop, options) {
        const runId = options.runId;
        call('lead', 'publish', { runId, previousVersion: 0, assignment, design: { origin: [0,0,0] } });
        for (const [index, recipient] of ['a', 'b'].entries()) call('lead', 'delegate', { runId, blueprintVersion: 1,
            key: recipient, recipient, partIds: ['part-' + (index + 1)], description: 'build', success: 'verified' });
        taken = call('a', 'take_task');
        assert.throws(() => call('a', 'fail_run', { runId, reason: 'not coordinator' }), /协调者/);
        return JSON.stringify({ action: 'blocked', reason: 'cannot complete this test' });
    } }
});
try {
    const input = { request: 'test one', origin: [0,0,0], dimension: 'overworld', owner: 'tester' };
    const first = await controller.start(input);
    assert.equal(first.status, 'failed');
    assert.equal(runtime.snapshot().runs[0].status, 'failed');
    assert(runtime.snapshot().tasks.every(task => task.status === 'cancelled'));
    assert.equal(Object.keys(runtime.snapshot().claims).length, 0);
    assert.equal(saved.get(first.runId + ':state').status, 'failed');
    assert(call('a', 'inbox').some(event => event.kind === 'control' && event.payload.action === 'cancel'));
    assert.throws(() => call('a', 'assert_write', { runId: first.runId, taskId: taken.task.id, token: taken.task.token,
        blueprintVersion: 1, partId: 'part-1', positions: [[0,0,0]] }), /已结束/);
    assert.equal(call('a', 'task_result', { runId: first.runId, taskId: taken.task.id, token: taken.task.token,
        blueprintVersion: 1, status: 'cancelled', summary: 'stopped after coordinator failure' }).status, 'cancelled',
    'worker cancellation acknowledgement must not fail after the run is closed');
    assert.equal(call('lead', 'fail_run', { runId: first.runId, reason: 'retry' }).status, 'failed');
    assert.throws(() => controller.resume(), /没有可恢复/);
    const second = await controller.receiveMessage({ ...input, request: 'test two' });
    assert.equal(second.status, 'failed'); assert.notEqual(first.runId, second.runId);
    assert.equal(runtime.snapshot().runs.length, 2, 'new user task must start a new run after failure');
    call('lead', 'open_run', { id: 'manual', ...input });
    await client.settle({ teamRunId: 'manual' }, { status: 'paused', stopRequested: true });
    assert.equal(runtime.snapshot().runs.at(-1).status, 'active', 'manual pause is resumable');
    await client.settle({ teamRunId: 'manual' }, { status: 'waiting_user' });
    assert.equal(runtime.snapshot().runs.at(-1).status, 'active');
    assert.deepEqual(errors, []);
} finally { client.close(); runtime.close(); }

// Reproduce the topology error with a persisted old run, including a saved
// blocked result that restore had relabeled as paused. No game/API processes.
const directory = await mkdtemp(join(tmpdir(), 'mindcraft-lifecycle-'));
try {
    for (const scenario of ['blocked', 'auto-paused', 'manual-paused', 'missing']) {
        const root = join(directory, scenario);
        await mkdir(join(root, 'bots', 'lead', 'builds'), { recursive: true });
        await writeFile(join(root, 'profile.json'), JSON.stringify({ model: { api: 'deepseek_responses', model: 'offline' } }));
        const old = createTeamRuntime({ spec, path: join(root, 'bots', 'team-runtime.sqlite') });
        const session = old.connect('lead');
        old.request('lead', session, 'open_run', { id: 'old', request: 'old test', origin: [0,0,0], dimension: 'overworld', owner: 'tester' });
        old.close();
        if (scenario !== 'missing') await writeFile(join(root, 'bots', 'lead', 'builds', 'old.state.json'), JSON.stringify({ status: 'paused',
            result: { status: scenario === 'blocked' ? 'blocked' : 'paused', stopRequested: scenario === 'manual-paused' } }));
        const launched = [];
        const supervisor = createTeamSupervisor({ root, launch(executable, args) {
            launched.push(args);
            const child = new EventEmitter(); child.pid = 999999; child.exitCode = null;
            child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
            queueMicrotask(() => child.emit('spawn'));
            return child;
        } });
        const options = { spec: TEAM_PRESETS.centralized(['new_lead', 'c', 'd']), settings: { port: 25565, profiles: ['profile.json'] } };
        try {
            if (['manual-paused', 'missing'].includes(scenario)) {
                await assert.rejects(supervisor.start(options), /新测试/);
                assert.equal(launched.length, 0, 'incompatible resume cannot launch any worker');
                await supervisor.start({ ...options, fresh: true });
                assert.equal(supervisor.snapshot().runs[0].status, 'cancelled');
            } else {
                await supervisor.start(options);
                assert.equal(supervisor.snapshot().runs[0].status, 'failed', 'legacy failure no longer locks topology');
            }
            assert.equal(launched.length, 3);
            assert(launched.every(args => !args.includes('--resume')), 'new test cannot restore stale goal');
        } finally { await supervisor.stop(); supervisor.close(); }
    }
} finally { await rm(directory, { recursive: true, force: true }); }
console.log('Team lifecycle checks passed: failed-run cleanup, lease fencing, next-message restart, legacy migration and fresh topology changes.');
