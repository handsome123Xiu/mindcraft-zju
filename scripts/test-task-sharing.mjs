import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTeamRuntime } from '../src/building/team-runtime.js';
import { TEAM_PRESETS } from '../src/building/team-state.js';
import { compileBlueprint } from '../src/building/blueprint.js';
import { createBuildingTools } from '../src/building/tools.js';
import { inspectPart, refreshChecklist } from '../src/building/checklist.js';

const spec = TEAM_PRESETS.centralized(['lead', 'alpha', 'beta', 'gamma']);
assert.equal(spec.rules.assignment, 'lead-assigns');
const assignment = { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes: [
    { kind: 'box', part: 'floor', min: [0,0,0], max: [3,0,1], block: 'stone' }
] }, [10,0,10]) };
const scopeOf = task => ({ runId: task.runId, blueprintVersion: task.blueprintVersion, taskId: task.id, token: task.token });
const delegates = (key, recipient, scope) => ({ runId: 'run', blueprintVersion: 1, key, recipient, partIds: ['part-1'], scope,
    description: 'Build assigned floor cells', success: 'All assigned cells match stone' });
function open(runtime) {
    const sessions = Object.fromEntries(Object.keys(spec.agents).map(name => [name, runtime.connect(name)]));
    const call = (name, method, args = {}) => runtime.request(name, sessions[name], method, args);
    call('lead', 'open_run', { id: 'run', request: 'Build floor', origin: [10,0,10], owner: 'tester', dimension: 'overworld' });
    call('lead', 'publish', { runId: 'run', previousVersion: 0, assignment, design: { origin: [10,0,10] } });
    return { sessions, call };
}

// A single semantic module supports arbitrary disjoint work, not a built-in
// left/right algorithm. Overlapping requests and writes are rejected.
{
    const runtime = createTeamRuntime({ spec });
    try {
        const { call } = open(runtime);
        const first = { positions: [[10,0,10], [12,0,11], [13,0,10]] };
        call('lead', 'delegate', delegates('sample', 'alpha', first));
        call('lead', 'delegate', delegates('row', 'beta', { region: { min: [11,0,10], max: [12,0,10] } }));
        assert.throws(() => call('lead', 'delegate', delegates('overlap', 'gamma', { positions: [[12,0,10]] })), /未完成委托/);
        const a = call('alpha', 'take_task'), b = call('beta', 'take_task');
        assert(a && b);
        assert.equal(a.run.blueprintVersion, 1);
        assert.deepEqual(a.run.assignment.blueprint, assignment.blueprint);
        assert.equal(call('alpha', 'claims', { runId: 'run' }).leases.length, 2);
        assert.equal(call('alpha', 'claims', { runId: 'run' }).claims['part-1'].owner, 'alpha');
        assert.equal(call('beta', 'claims', { runId: 'run' }).claims['part-1'].owner, 'beta');
        assert.throws(() => call('lead', 'claim', { runId: 'run', blueprintVersion: 1, partId: 'part-1' }), /已委托/);
        const authorization = { ...scopeOf(a.task), partId: 'part-1' };
        assert.equal(call('alpha', 'assert_write', { ...authorization, positions: first.positions }).status, 'allowed');
        assert.throws(() => call('alpha', 'assert_write', { ...authorization, positions: [[11,0,10]] }), /超出/);
        const world = { read: () => 'air' };
        const job = { teamTask: a.task, assignment: a.run.assignment, assignmentVersion: 1, origin: [10,0,10] };
        assert.equal(refreshChecklist(job, world).remainingCells, 3);
        const inspection = inspectPart(job, world, 'part-1');
        assert.equal(inspection.total, 3);
        assert.deepEqual(inspection.differences.map(c => c.pos.join(',')).sort(), first.positions.map(p => p.join(',')).sort());
        assert.throws(() => call('alpha', 'task_result', { ...scopeOf(a.task), status: 'completed', summary: 'done', evidence: [{ partId: 'part-1', total: 8, remaining: 0 }] }), /证据/);
    } finally { runtime.close(); }
}

// Consent alone grants no writes. Commit happens between source actions,
// transfers only the agreed cells, and retains the source's full obligation.
{
    const runtime = createTeamRuntime({ spec });
    try {
        const { call } = open(runtime);
        call('lead', 'delegate', delegates('floor', 'alpha'));
        const a = call('alpha', 'take_task');
        const source = scopeOf(a.task), subset = [[12,0,10], [13,0,10]];
        const args = { ...source, key: 'help', recipient: 'beta', partIds: ['part-1'], scope: { positions: subset }, description: 'Help with two cells', success: 'Both match stone' };
        assert.throws(() => call('alpha', 'propose_share', { ...args, scope: { positions: [[99,0,99]] } }), /超出/);
        const proposal = call('alpha', 'propose_share', args).proposal;
        assert.equal(call('alpha', 'propose_share', args).proposal.id, proposal.id);
        assert.throws(() => call('alpha', 'commit_share', { ...source, proposalId: proposal.id }), /尚未接受/);
        assert.throws(() => call('gamma', 'respond_share', { runId: 'run', proposalId: proposal.id, accept: true }), /无权/);
        call('beta', 'respond_share', { runId: 'run', proposalId: proposal.id, accept: true });
        assert.equal(call('beta', 'take_task'), null);
        assert.equal(call('alpha', 'assert_write', { ...source, partId: 'part-1', positions: subset }).status, 'allowed');
        const committed = call('alpha', 'commit_share', { ...source, proposalId: proposal.id });
        assert.equal(call('alpha', 'commit_share', { ...source, proposalId: proposal.id }).taskId, committed.taskId);
        assert.equal(committed.currentTask.workScope.positions.length, 6);
        assert.equal(committed.currentTask.description, a.task.description);
        assert.equal(committed.currentTask.scope, null);
        assert.throws(() => call('alpha', 'assert_write', { ...source, partId: 'part-1', positions: subset }), /超出/);
        assert.throws(() => call('alpha', 'propose_share', { ...args, key: 'again' }), /自己施工范围/);
        const b = call('beta', 'take_task');
        assert.equal(b.task.parentId, a.task.id);
        const finishA = { ...source, status: 'completed', summary: 'verified', evidence: [{ partId: 'part-1', total: 8, remaining: 0 }] };
        assert.throws(() => call('alpha', 'task_result', finishA), /协作子任务尚未完成/);
        const job = { teamTask: committed.currentTask, assignment, assignmentVersion: 1, origin: [10,0,10] };
        const world = { read: pos => subset.some(p => p.join() === pos.join()) ? 'air' : 'stone' };
        assert.equal(refreshChecklist(job, world).remainingCells, 0);
        assert.equal(inspectPart(job, world, 'part-1', { fullTask: true }).remaining, 2, 'parent completion still verifies the shared work');
        call('beta', 'task_result', { ...scopeOf(b.task), status: 'blocked', summary: 'Cannot reach' });
        assert.throws(() => call('lead', 'reassign', { runId: 'run', taskId: b.task.id, recipient: 'alpha' }), /等待它/);
        call('lead', 'reassign', { runId: 'run', taskId: b.task.id, recipient: 'gamma' });
        const c = call('gamma', 'take_task');
        assert.notEqual(c.task.token, b.task.token);
        assert.throws(() => call('beta', 'assert_write', { ...scopeOf(b.task), partId: 'part-1', positions: subset }), /失效/);
        call('gamma', 'task_result', { ...scopeOf(c.task), status: 'completed', summary: 'verified', evidence: [{ partId: 'part-1', total: 2, remaining: 0 }] });
        assert(call('alpha', 'inbox').some(event => event.kind === 'task_result'));
        call('alpha', 'task_result', finishA);
        call('lead', 'finish_run', { runId: 'run' });
    } finally { runtime.close(); }
}

// Handoff survives a real store restart without restoring stale write tokens.
{
    const directory = await mkdtemp(join(tmpdir(), 'mindcraft-share-'));
    const path = join(directory, 'runtime.sqlite');
    let runtime = createTeamRuntime({ spec, path });
    try {
        const { call } = open(runtime);
        call('lead', 'delegate', delegates('floor', 'alpha'));
        const a = call('alpha', 'take_task');
        const p = call('alpha', 'propose_share', { ...scopeOf(a.task), key: 'all', recipient: 'beta', partIds: ['part-1'],
            scope: { region: assignment.blueprint.bounds }, description: 'Take over all physical work', success: 'All cells match' }).proposal;
        call('beta', 'respond_share', { runId: 'run', proposalId: p.id, accept: true });
        call('alpha', 'commit_share', { ...scopeOf(a.task), proposalId: p.id });
        runtime.close(); runtime = createTeamRuntime({ spec, path });
        const sa = runtime.connect('alpha'), sb = runtime.connect('beta');
        const restoredA = runtime.request('alpha', sa, 'take_task');
        const restoredB = runtime.request('beta', sb, 'take_task');
        assert(restoredA && restoredB);
        assert.deepEqual(restoredA.task.workScope.positions, []);
        assert.equal(restoredB.task.scope.positions.length, 8);
        assert.notEqual(restoredA.task.token, a.task.token);
        assert.equal(runtime.snapshot().proposals[0].status, 'committed');
        assert.throws(() => runtime.request('alpha', sa, 'assert_write', { ...scopeOf(restoredA.task), partId: 'part-1', positions: [[10,0,10]] }), /租约/);
    } finally { runtime.close(); await rm(directory, { recursive: true, force: true }); }
}

// Design never triggers automatic work, including existing saved legacy rules.
for (const strategy of ['lead-assigns', 'spatial-parallel']) {
    const legacy = structuredClone(spec); legacy.rules.assignment = strategy;
    let published = 0, dispatched = 0;
    const job = { request: 'Build floor', origin: [10,0,10], dimension: 'overworld', owner: 'tester', assignmentVersion: 0,
        placed: {}, removed: {}, events: [], observation: {}, plan: { requirements: [{ id: 'goal', description: 'Build floor' }], steps: [] } };
    const tools = createBuildingTools({ job, world: { read: () => 'air', snapshot: () => ({ dimension: 'overworld' }) },
        team: { runtime: true, self: 'lead', spec: () => legacy, async publish() { published++; return { assignmentVersion: 1 }; }, async prepareParallel() { dispatched++; } },
        checkpoint: async () => {}, design: async () => ({ blueprint: assignment.blueprint, summary: 'Floor', shapes: [], coverage: [{ requirementId: 'goal', evidence: 'Eight cells' }] }) });
    await tools.useSkill('design_blueprint', {});
    assert.equal(published, 1);
    assert.equal(dispatched, 0);
    assert.deepEqual(job.assignment.blueprint.parts, assignment.blueprint.parts);
}
console.log('Adaptive collaboration checks passed: module subsets, conflict fencing, explicit consent and atomic handoff, full parent obligations, helper reassignment, persistence, and no automatic dispatch.');
