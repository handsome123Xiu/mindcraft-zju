import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTeamRuntime } from '../src/building/team-runtime.js';
import { createTeamClient } from '../src/building/team-client.js';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { compileBlueprint } from '../src/building/blueprint.js';
import { TEAM_PRESETS } from '../src/building/team-state.js';

const spec = TEAM_PRESETS.centralized(['lead', 'a', 'b']);
const assignment = { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes: [
    { kind: 'point', at: [0,0,0], block: 'stone' },
    { kind: 'point', at: [2,0,0], block: 'stone' }
] }, [0,0,0]) };
function setup(options = {}) {
    const runtime = createTeamRuntime({ spec, ...options });
    const sessions = Object.fromEntries(Object.keys(spec.agents).map(name => [name, runtime.connect(name)]));
    const call = (name, method, args = {}) => runtime.request(name, sessions[name], method, args);
    call('lead', 'open_run', { id: 'recovery', request: 'two cakes', owner: 'tester', origin: [0,0,0], dimension: 'overworld' });
    call('lead', 'publish', { runId: 'recovery', previousVersion: 0, assignment, design: { origin: [0,0,0] } });
    const delegate = (key, recipient, partIds, dependsOn = []) => ({ runId: 'recovery', blueprintVersion: 1,
        key, recipient, partIds, dependsOn, description: 'build cake', success: 'verified' });
    return { runtime, sessions, call, delegate };
}
async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(predicate(), 'timed out waiting for recovery');
}

// Reproduce: task fails -> advice starts a chat-only round -> idle budget ends
// the round -> leader reassigns the original ID -> production client claims it.
for (const manualPause of [false, true]) {
    const { runtime, call, delegate } = setup();
    const errors = [];
    const channel = new EventEmitter(); channel.connected = true;
    channel.send = (message, callback) => {
        try {
            const result = call('a', message.method, message.args);
            queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, result })); callback?.();
        } catch (error) {
            queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, error: error.message })); callback?.();
        }
    };
    const client = createTeamClient({ name: 'a', spec, channel, onError: error => errors.push(error.message) });
    let failed = false, inCoordination = false;
    const controller = createBuildingLoop({ team: client, peers: client.peers, agentName: 'a', maxModelRequests: 2,
        save: async () => {},
        world: { snapshot: () => ({ dimension: 'overworld', position: [0,0,4], gameMode: 'creative' }),
            read: pos => pos.join() === '0,0,0' || pos[1] < 0 ? 'stone' : 'air' },
        model: { async sendRequest(turns, instructions, stop, { signal }) {
            const context = JSON.parse(turns[0].content);
            if (context.coordinationOnly) {
                inCoordination = true;
                assert.equal(context.team.assignment, null, 'chat must not revive expired work rights');
                if (manualPause) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
                return JSON.stringify({ action: 'tool', name: 'list_peers', args: {} });
            }
            if (!failed) { failed = true; return JSON.stringify({ action: 'blocked', reason: 'inspection loop made no progress' }); }
            assert(context.team.agents.every(peer => typeof peer.canAcceptTask === 'boolean'));
            if (!context.plan.steps.length) return JSON.stringify({ action: 'update_plan', steps: [
                { id: 'check', title: 'verify existing stone', success: 'matches', status: 'done', evidence: 'world stone observed' }
            ] });
            return JSON.stringify({ action: 'complete_task', summary: 'existing target verified' });
        } }
    });
    try {
        const delegated = call('lead', 'delegate', delegate('cake-a', 'a', ['part-1']));
        const original = call('a', 'take_task');
        assert.equal((await controller.acceptTask(original)).status, 'blocked');
        assert.equal(runtime.snapshot().tasks[0].status, 'blocked');
        call('lead', 'message', { runId: 'recovery', recipient: 'a', text: 'inspect suggestions then build' });
        const event = call('a', 'inbox').find(item => item.kind === 'message');
        await controller.receiveTeamEvent(event);
        await until(() => inCoordination);
        if (manualPause) await controller.stop('paused');
        await until(() => controller.snapshot()?.result?.status === (manualPause ? 'paused' : 'blocked'));
        assert.equal(controller.canAcceptTask(), !manualPause);
        assert.equal(controller.snapshot().result.stopRequested, manualPause);
        call('a', 'ack', { ids: [event.id] });
        assert.throws(() => call('lead', 'delegate', delegate('cake-a', 'b', ['part-1'])), error =>
            error.message.includes(delegated.taskId) && error.message.includes('reassign_task'));
        assert.throws(() => call('lead', 'delegate', delegate('new-key', 'a', ['part-1'])), error =>
            error.message.includes(delegated.taskId) && error.message.includes('reassign_task'));
        call('lead', 'reassign', { runId: 'recovery', taskId: delegated.taskId, recipient: 'a' });
        client.attach(controller);
        if (manualPause) {
            await new Promise(resolve => setTimeout(resolve, 1200));
            assert.equal(runtime.snapshot().tasks[0].attempt, 1);
            assert.equal(runtime.snapshot().tasks[0].status, 'queued');
            assert.equal(runtime.snapshot().agents.find(peer => peer.name === 'a').canAcceptTask, false);
            assert.equal(controller.status(), 'paused');
        } else {
            await until(() => runtime.snapshot().tasks[0].status === 'completed' && controller.canAcceptTask());
            assert.equal(runtime.snapshot().tasks[0].attempt, 2);
            assert.equal(runtime.snapshot().tasks[0].id, original.task.id);
            assert.notEqual(controller.snapshot().teamTask.token, original.task.token);
        }
        assert.deepEqual(errors, []);
        assert.equal(runtime.snapshot().runs[0].status, 'active');
    } finally { client.close(); runtime.close(); }
}

// A queued task gets one actionable notice per assignment, not a model polling
// loop. Paused runs and genuine dependency waits do not consume the deadline.
{
    let clock = 0;
    const { runtime, call, delegate, sessions } = setup({ now: () => clock, leaseMs: 60000, taskClaimTimeoutMs: 1000 });
    try {
        assert.equal(call('lead', 'context', { runId: 'recovery' }).peers.find(p => p.name === 'a').canAcceptTask, false,
            'connected with unknown readiness is not ready');
        call('a', 'heartbeat', { status: 'paused', canAcceptTask: false });
        call('b', 'heartbeat', { status: 'completed', canAcceptTask: true });
        const a = call('lead', 'delegate', delegate('a', 'a', ['part-1']));
        call('lead', 'delegate', delegate('b', 'b', ['part-2'], [a.taskId]));
        const notices = () => call('lead', 'inbox').filter(e => e.kind === 'task_unclaimed');
        call('lead', 'pause_run', { runId: 'recovery' });
        clock += 5000; runtime.sweep(); assert.equal(notices().length, 0);
        call('lead', 'resume_run', { runId: 'recovery' }); runtime.sweep();
        clock += 999; runtime.sweep(); assert.equal(notices().length, 0);
        clock += 2; runtime.sweep();
        assert.equal(notices().length, 1);
        assert.equal(notices()[0].payload.taskId, a.taskId);
        assert.equal(notices()[0].payload.peer.canAcceptTask, false);
        clock += 2000; runtime.sweep(); assert.equal(notices().length, 1, 'no repeated wakeups');
        assert.equal(runtime.snapshot().tasks[0].attempt, 0, 'notice does not execute work');
        const reassigned = call('lead', 'reassign', { runId: 'recovery', taskId: a.taskId, recipient: 'b' });
        assert.equal(reassigned.recipient.canAcceptTask, true);
        assert.equal(runtime.snapshot().tasks[0].claimStalled, undefined);
        runtime.sweep(); clock += 1001; runtime.sweep();
        assert.equal(notices().length, 2, 'a new assignment has a fresh deadline');
        call('b', 'take_task');
        assert.equal(runtime.snapshot().tasks[0].claimStalled, undefined);
        // Offline recovery must not commandeer an explicitly paused teammate.
        runtime.disconnect('b', sessions.b);
        assert.equal(runtime.snapshot().tasks[0].to, 'b');
        assert.equal(runtime.snapshot().agents.find(p => p.name === 'a').canAcceptTask, false);
    } finally { runtime.close(); }
}
console.log('Team recovery checks passed: blocked/chat/reassign/claim, manual pause, readiness, duplicate guidance and bounded unclaimed notices.');
