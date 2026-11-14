import assert from 'node:assert/strict';
import { compileBlueprint } from '../src/building/blueprint.js';
import { partitionBuilding, verifyParallelSite } from '../src/building/parallel-building.js';
import { createTeamRuntime } from '../src/building/team-runtime.js';
import { TEAM_PRESETS } from '../src/building/team-state.js';
import { refreshChecklist } from '../src/building/checklist.js';
import { createBuildingLoop } from '../src/building/loop-agent.js';

const spec = TEAM_PRESETS.centralized(['lead', 'alpha', 'beta']);
const assignment = { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes: [
    { kind: 'box', part: 'bottom', min: [0,0,0], max: [3,0,2], block: 'white_concrete' },
    { kind: 'box', part: 'upper', min: [1,1,1], max: [2,1,1], block: 'pink_concrete' },
    { kind: 'point', part: 'candle', at: [1,2,1], block: 'red_concrete' }
] }, [0,0,0]) };
const split = partitionBuilding(assignment, 2);
assert.deepEqual(split.blueprint.blocks, assignment.blueprint.blocks);
assert.deepEqual(split.blueprint.bounds, assignment.blueprint.bounds);
assert.equal(assignment.blueprint.parts.length, 3, 'input blueprint is not mutated');
assert.equal(split.blueprint.parts.length, 2);
const all = split.blueprint.parts.flatMap(part => part.positions.map(pos => pos.join(',')));
assert.equal(new Set(all).size, 15);
assert.equal(all.length, 15, 'all cells owned exactly once');
assert(split.blueprint.parts.every(part => part.positions.some(pos => pos[1] === 0) && part.positions.some(pos => pos[1] === 1)), 'each worker builds from the ground to upper layers');
const world = { read: pos => pos[1] < 0 ? 'stone' : 'air' };
verifyParallelSite(split, world);
assert.throws(() => verifyParallelSite(split, { read: () => 'air' }), /支撑/);
const explicitClearance = structuredClone(split);
explicitClearance.blueprint.clearance.push([0,1,0]);
assert.throws(() => verifyParallelSite(explicitClearance, { read: pos => pos.join(',') === '0,1,0' ? 'stone' : world.read(pos) }), /clearance/);
assert.throws(() => verifyParallelSite(split, { read: pos => pos.join(',') === '0,0,0' ? null : world.read(pos) }), /未加载/);
const bed = { ...assignment, blueprint: compileBlueprint({ shapes: [
    { kind: 'box', min: [0,0,0], max: [1,0,0], block: 'red_bed' }
] }, [0,0,0]) };
assert.throws(() => partitionBuilding(bed, 2), /连体/);

// Atomic publication, retries, concurrent claims, and boundary enforcement.
const runtime = createTeamRuntime({ spec });
try {
    const sessions = Object.fromEntries(Object.keys(spec.agents).map(name => [name, runtime.connect(name)]));
    const call = (name, method, args = {}) => runtime.request(name, sessions[name], method, args);
    call('lead', 'open_run', { id: 'parallel', owner: 'tester', request: 'Build cake', dimension: 'overworld', origin: [0,0,0] });
    call('lead', 'publish', { runId: 'parallel', previousVersion: 0, assignment, design: { origin: [0,0,0] } });
    const args = { runId: 'parallel', blueprintVersion: 1, key: 'cake', workers: ['alpha', 'beta'] };
    assert.throws(() => call('lead', 'prepare_parallel', { ...args, workers: ['alpha', 'lead'] }), /连线/);
    assert.equal(runtime.snapshot().tasks.length, 0);
    assert.equal(runtime.snapshot().runs[0].blueprintVersion, 1, 'invalid request cannot partly publish');
    const prepared = call('lead', 'prepare_parallel', args);
    assert.equal(prepared.assignmentVersion, 2);
    assert.deepEqual(call('lead', 'prepare_parallel', args), prepared, 'lost response retry is idempotent');
    const a = call('alpha', 'take_task'), b = call('beta', 'take_task');
    assert(a && b, 'second worker starts while the first is still running');
    assert(runtime.snapshot().tasks.every(task => task.status === 'running'));
    const scope = { runId: 'parallel', blueprintVersion: 2, taskId: a.task.id, token: a.task.token, partId: a.task.partIds[0] };
    assert.throws(() => call('alpha', 'assert_write', { ...scope, positions: prepared.assignment.blueprint.parts[1].positions }), /超出/);
    assert.equal(call('alpha', 'assert_write', { ...scope, positions: prepared.assignment.blueprint.parts[0].positions }).status, 'allowed');
    const job = { assignment: a.run.assignment, assignmentVersion: 2, teamTask: a.task, origin: [0,0,0] };
    const checklist = refreshChecklist(job, world);
    assert.equal(checklist.totalParts, 1);
    assert.equal(checklist.remainingCells, prepared.assignment.blueprint.parts[0].positions.length);
    call('alpha', 'message', { runId: 'parallel', recipient: 'beta', text: 'Please move aside' });
    assert(call('beta', 'inbox').some(event => event.payload.text === 'Please move aside'));
} finally { runtime.close(); }

// An idle worker can move/respond, but cannot revive its completed task or
// mutate construction. A duplicate inbox delivery must not trigger a new turn.
{
    let position = [0,0,0], forbidden = 0, settled = 0;
    const sent = [], contexts = [];
    const script = [
        { action: 'tool', name: 'place_block', args: { position: [0,0,0], block: 'stone' } },
        { action: 'tool', name: 'move_to', args: { position: [5,0,5] } },
        { action: 'tool', name: 'send_message', args: { recipient: 'beta', text: 'Moved aside' } },
        { action: 'end_turn' }
    ];
    const peers = { isPeer: name => name === 'beta', async sendToAgent(name, text) { sent.push({ name, text }); return { status: 'delivered' }; } };
    const team = { runtime: true, self: 'alpha', spec: () => spec,
        async refresh(job) { job.teamContext = { tasks: [], paused: false }; },
        async openRun() { forbidden++; }, async resume() { forbidden++; }, async finish() { forbidden++; },
        async settle(job) { assert(!job.teamTask); settled++; } };
    const controller = createBuildingLoop({ agentName: 'alpha', team, peers, sendMessage: async () => ({ status: 'sent' }),
        world: { snapshot: () => ({ dimension: 'overworld', gameMode: 'creative', position }), read: world.read,
            async moveTo(pos) { position = pos; return true; }, async place() { forbidden++; } },
        model: { async sendRequest(turns) { contexts.push(JSON.parse(turns[0].content)); return JSON.stringify(script.shift() ?? { action: 'end_turn' }); } },
        save: async () => {} });
    const event = { id: 'message-1', runId: 'parallel', from: 'beta', kind: 'message',
        payload: { text: 'Please move aside', context: { owner: 'tester', origin: [0,0,0], dimension: 'overworld', request: 'Build cake' } } };
    assert.equal(await controller.receiveTeamEvent(event), true);
    const deadline = Date.now() + 5000;
    while (!controller.canAcceptTask() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(controller.status(), 'completed');
    assert.equal(forbidden, 0);
    assert.equal(settled, 1);
    assert.deepEqual(position, [5,0,5]);
    assert.equal(sent.length, 1);
    assert(contexts.every(context => context.coordinationOnly && !context.team.assignment));
    assert(controller.snapshot().events.some(event => event.output?.message?.includes('协调回合')));
    await controller.receiveTeamEvent(event);
    assert.equal(contexts.length, 4);
}
console.log('Parallel checks passed: immutable geometry, independent zones/support, atomic dispatch/retry, concurrent leases, local checklists, and safe idle-worker coordination.');
