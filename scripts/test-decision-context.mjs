import assert from 'node:assert/strict';
import { createDecisionRequest } from '../src/building/loop-agent.js';
import { compactObservation, recentModelEvents, actionStats } from '../src/building/decision-context.js';
import { parseAction } from '../src/building/action-protocol.js';
import { TEAM_PRESETS } from '../src/building/team-state.js';
import { createTeamRuntime } from '../src/building/team-runtime.js';
import { compileBlueprint } from '../src/building/blueprint.js';
import { createProgressTracker } from '../src/building/progress.js';

const spec = TEAM_PRESETS.centralized(['lead', 'builder_1', 'builder_2']);
const blueprint = compileBlueprint({ shapes: [
    { kind: 'box', min: [0,0,0], max: [3,0,0], part: 'floor', block: 'stone' },
    { kind: 'point', at: [3,1,0], part: 'decoration', block: 'red_concrete' }
] }, [10,0,10]);
const differences = Array.from({ length: 128 }, (_, x) => ({ pos: [x,0,0], block: 'stone', actual: 'air', reason: 'missing' }));
const suggestions = { actions: [{ name: 'place_block', args: { position: [10,0,10], block: 'stone', partId: 'part-1', assignmentVersion: 1 } }] };
const observation = { region: { min: [0,0,0], max: [128,0,0] }, scanned: 129, counts: { stone: 128, unloaded: 1 },
    occupied: differences.map(d => ({ pos: d.pos, block: 'stone' })), occupiedTruncated: false,
    offset: 20, nextOffset: null, matched: 148, filter: { blocks: ['stone'] }, unloaded: [[128,0,0]] };
const job = { request: 'Build the whole cake, with decoration', owner: 'tester', origin: [10,0,10], placed: {}, removed: {},
    plan: { requirements: [{ id: 'goal', description: 'Keep this original obligation' }], steps: [{ id: 's1', title: 'Build', success: 'All cells match', status: 'running' }] },
    messages: [{ role: 'user', content: 'Keep the red decoration; do not omit it.' }],
    assignment: { blueprint }, assignmentVersion: 1, design: { origin: [10,0,10], summary: 'floor and decoration', coverage: [], shapes: Array(512).fill({ kind: 'point' }) },
    observation, checklist: { nextPartId: 'part-1', remainingCells: 5, parts: [{ id: 'part-1', status: 'pending' }, { id: 'part-2', status: 'pending' }] },
    teamContext: { tasks: [], proposals: [] },
    events: Array.from({ length: 8 }, () => ({ kind: 'tool', name: 'inspect_part', input: { large: 'x'.repeat(10000) }, output: { differences, suggestions } })) };
const before = JSON.stringify(job);
const team = { self: 'lead', runtime: true, spec: () => spec };
const world = { position: [10,0,10], dimension: 'overworld' };
const request = createDecisionRequest(job, world, {}, 'lead', team);
const context = JSON.parse(request.turns[0].content);
assert.equal(context.ORIGINAL_GOAL, job.request);
assert.deepEqual(context.messages, job.messages);
assert.deepEqual(context.plan, job.plan);
assert.deepEqual(context.constructionChecklist, job.checklist);
assert.equal(context.blueprint.version, 1);
assert.equal(context.blueprint.design.shapes, undefined, 'geometry is retrieved on demand');
assert.deepEqual(context.recentEvents.at(-1).output.suggestions, suggestions, 'retain current executable repair advice');
assert(context.recentEvents.slice(0,-1).every(event => !event.output.suggestions));
assert.equal(JSON.stringify(job), before, 'compaction must never mutate saved facts/audit');
assert(request.instructions.length < 11000, 'system prompt must not grow back to 26k chars');
assert(request.turns[0].content.length < 6500, 'large old tool results cannot dominate decisions');
assert.equal(context.observation.nextOffset, 32, 'continue from visible page, not original longer page');
assert.equal(context.observation.occupiedTruncated, true);
assert.deepEqual(context.observation.counts, observation.counts);
assert.deepEqual(context.observation.unloaded, observation.unloaded);
assert.deepEqual(context.observation.filter, observation.filter);
assert.equal(compactObservation({ occupied: [] }).occupied.length, 0);
const error = { kind: 'feedback', name: 'decision_error', output: { code: 'INVALID_ARGUMENT', field: 'args.partId',
    expected: { type: 'string' }, recovery: 'Read the exact part ID from checklist.' } };
assert.equal(recentModelEvents([error])[0].output.recovery, error.output.recovery);

// 折叠与统计：重复检查在全历史维度折叠为 repeats 计数，统计呈现动作分布。
{
    const repeat = output => ({ kind: 'feedback', name: 'inspect_part', input: {}, output });
    const same = { status: 'pending', remaining: 9 };
    const events = [
        { kind: 'tool', name: 'observe_environment', input: {}, output: { status: 'observed' } },
        repeat(same), repeat(same), repeat(same), repeat(same), repeat(same), repeat(same), repeat(same),
        { kind: 'user', name: 'message', input: {}, output: { status: 'received' } }
    ];
    const window = recentModelEvents(events);
    const folded = window.find(event => event.name === 'inspect_part');
    assert.equal(folded?.repeats, 7, '七份相同反馈折叠为一条 ×7');
    assert.equal(window.filter(event => event.name === 'inspect_part').length, 1);
    assert(window.some(event => event.name === 'message'), '用户消息不折叠');
    // 中断后重新开始的重复不合并（内容变化）。
    const changed = recentModelEvents([...events.slice(0, 4), repeat({ status: 'pending', remaining: 4 })]);
    assert.equal(changed.filter(event => event.name === 'inspect_part').length, 2, '输出变化不折叠');
    // 统计：决策数、动作计数、batch 展开。
    const stats = actionStats([
        { kind: 'tool', name: 'place_block', input: {}, output: {} },
        { kind: 'feedback', name: 'batch', input: {}, output: { steps: [{ name: 'inspect_part' }, { name: 'inspect_part' }, { name: 'update_plan' }] } },
        { kind: 'user', name: 'message', input: {}, output: {} }
    ], 5);
    assert.equal(stats.decisionsSoFar, 5);
    assert.equal(stats.actionCounts.inspect_part, 2, 'batch 子步骤计入统计');
    assert.equal(stats.actionCounts.place_block, 1);
    assert.equal(stats.actionCounts.message, undefined, '用户消息不计入');
    assert(!stats.note.includes('必须'), '统计只陈述事实，不下指令');
}

const child = { ...job, teamTask: { id: 'child', partIds: ['part-1'], from: 'lead', success: 'exact cells', scope: { positions: [[10,0,10]] } } };
const worker = createDecisionRequest(child, world, {}, 'builder_1', { ...team, self: 'builder_1' });
const actions = worker.actionContract.anyOf.map(schema => schema.properties.action.const);
assert(!actions.includes('skill') && !actions.includes('finish'));
assert(actions.includes('complete_task'));
const names = worker.actionContract.anyOf.find(schema => schema.properties.action.const === 'tool').properties.name.enum;
assert(!names.includes('delegate_task') && names.includes('propose_task_share'));
assert.equal(JSON.parse(worker.turns[0].content).team.assignment.workScope.count, 1);
const coordination = createDecisionRequest({ ...job, teamCoordination: true }, world, {}, 'builder_2', { ...team, self: 'builder_2' });
assert.deepEqual(coordination.actionContract.anyOf.map(s => s.properties.action.const), ['tool','batch','end_turn','blocked']);
assert(!coordination.instructions.includes('"place_block":'));

// A later invalid step rejects the batch before any earlier step is dispatched.
assert.throws(() => parseAction(JSON.stringify({ action: 'batch', steps: [
    { name: 'send_message', args: { text: 'must not be sent yet' } },
    { name: 'place_block', args: { position: [0,0,0], block: 'stone', invented: true } }
] })), error => error.code === 'INVALID_ARGUMENT' && error.field === 'steps[1].args.invented');
assert.throws(() => parseAction('{"action":"build_all"}'));

// Reproduce the cake dispatch failure: a region intersects only some of the
// listed semantic parts. Both independent scopes can actually be taken.
const runtime = createTeamRuntime({ spec });
try {
    const sessions = Object.fromEntries(Object.keys(spec.agents).map(name => [name, runtime.connect(name)]));
    const call = (name, method, args = {}) => runtime.request(name, sessions[name], method, args);
    call('lead', 'open_run', { id: 'cake', request: job.request, origin: job.origin, owner: job.owner, dimension: 'overworld' });
    call('lead', 'publish', { runId: 'cake', previousVersion: 0, assignment: { version: 1, dimension: 'overworld', blueprint }, design: { origin: job.origin } });
    const delegate = (key, recipient, min, max) => ({ runId: 'cake', blueprintVersion: 1, key, recipient,
        partIds: ['part-1','part-2'], description: 'Build scoped cells', success: 'All scoped cells verified', scope: { region: { min, max } } });
    const args = delegate('first', 'builder_1', [10,0,10], [11,1,10]);
    const first = call('lead', 'delegate', args);
    assert.deepEqual(first.partIds, ['part-1']);
    assert.equal(first.scope.count, 2);
    const allocated = call('lead', 'context', { runId: 'cake' }).allocation;
    assert.equal(allocated.find(part => part.partId === 'part-1').unallocated, 2);
    assert.equal(allocated.find(part => part.partId === 'part-2').unallocated, 1);
    assert.deepEqual(call('lead', 'delegate', args), first, 'retry returns the same effective scope');
    const second = call('lead', 'delegate', delegate('second', 'builder_2', [12,0,10], [13,1,10]));
    assert.deepEqual(second.partIds, ['part-1','part-2']);
    assert.equal(second.scope.count, 3);
    assert(call('lead', 'context', { runId: 'cake' }).allocation.filter(part => part.partId !== 'clearance').every(part => part.unallocated === 0));
    const a = call('builder_1', 'take_task'), b = call('builder_2', 'take_task');
    assert(a && b, 'both scopes are runnable concurrently without artificial dependency');
    assert.deepEqual(a.task.partIds, first.partIds);
    assert.throws(() => call('builder_1', 'assert_write', { runId: 'cake', blueprintVersion: 1, taskId: a.task.id,
        token: a.task.token, partId: 'part-2', positions: [[13,1,10]] }), /超出/);
    assert.throws(() => call('lead', 'delegate', delegate('empty', 'builder_1', [90,0,90], [91,1,90])), /范围为空/);
} finally { runtime.close(); }

const track = createProgressTracker(job, { snapshot: () => world });
assert(track({ action: 'tool', name: 'delegate_task' }, { taskId: 'new-task', status: 'queued' }).progressed);
assert(!track({ action: 'tool', name: 'delegate_task' }, { taskId: 'new-task', status: 'queued' }).progressed, 'same retry is not progress');
console.log('Decision context checks passed: immutable obligations, compact history, paged retrieval, role protocols, batch preflight and intersected concurrent scopes.');
