import assert from 'node:assert/strict';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { createBuildingTools } from '../src/building/tools.js';
import { parseAction, TOOL_SCHEMAS } from '../src/building/action-protocol.js';
import { extractNativeActions, nativeFunctions } from '../src/building/native-actions.js';
import { compileBlueprint } from '../src/building/blueprint.js';
import { createDecisionRequest } from '../src/building/loop-agent.js';

const small = { min: [0, -1, 0], max: [2, 3, 2] };
const large = { min: [-20, -1, -15], max: [20, 12, 15] };
const volume = r => r.max.reduce((n, value, i) => n * (value - r.min[i] + 1), 1);
const observe = region => ({ action: 'tool', name: 'observe_environment', args: { region } });
const pause = { action: 'blocked', reason: 'observation recorded' };
const task = { request: 'small structure', origin: [0, 0, 0], dimension: 'overworld', owner: 'tester' };

// No terrain reads precede the model's choice; different task footprints reach
// the scanner exactly as chosen, including areas outside the former default.
for (const [request, region] of [['small structure', small], ['large hall', large]]) {
    const reads = [], contexts = [];
    const script = [observe(region), pause];
    const world = {
        snapshot: () => ({ position: [0, 0, 0], dimension: 'overworld', minY: -64, height: 384 }),
        read(pos) { reads.push(pos); return pos[1] < 0 ? 'stone' : 'air'; }
    };
    const agent = createBuildingLoop({ world, save: async () => {}, model: { async sendRequest(turns) {
        contexts.push({ ...JSON.parse(turns[0].content), reads: reads.length });
        return JSON.stringify(script.shift() ?? pause);
    } } });
    await agent.start({ ...task, request });
    assert.equal(contexts[0].ORIGINAL_GOAL, request);
    assert.equal(contexts[0].reads, 0);
    assert.equal(contexts[0].observation, null);
    assert.equal(contexts[0].world.minY, -64);
    assert.deepEqual(contexts[1].observation.region, region);
    assert.equal(contexts[1].observation.scanned, volume(region));
    assert.equal(reads.length, volume(region));
    assert(reads.every(pos => pos.every((n, i) => n >= region.min[i] && n <= region.max[i])));

    // Restore retains timestamped evidence with uncertainty; the model can
    // choose a different region, without a forced replay of the old scan.
    const saved = agent.snapshot();
    saved.lastInspection = { verified: 999, total: 999 };
    const restoredContexts = [];
    const nextRegion = region === small ? large : small;
    const resumedScript = [observe(nextRegion), pause];
    const before = reads.length;
    const restored = createBuildingLoop({ world, save: async () => {}, model: { async sendRequest(turns) {
        restoredContexts.push({ ...JSON.parse(turns[0].content), reads: reads.length });
        return JSON.stringify(resumedScript.shift() ?? pause);
    } } });
    restored.restore(saved);
    await restored.resume();
    assert.equal(restoredContexts[0].reads, before);
    assert.deepEqual(restoredContexts[0].observation.region, region);
    assert.equal(restoredContexts[0].observation.observedAt, saved.observation.observedAt);
    assert.equal(restoredContexts[0].observation.freshness, 'possibly_stale');
    assert(restoredContexts[0].observation.staleReasons.includes('process_restored'));
    assert.equal(restoredContexts[0].lastInspection, null);
    assert.deepEqual(restoredContexts[1].observation.region, nextRegion);
    assert.equal(restoredContexts[1].observation.freshness, 'observed');
    assert.equal(reads.length - before, volume(nextRegion));
}

// Omitting region cannot silently perform a scan through JSON, native functions
// or direct tool calls. Execution bounds remain enforced for explicit requests.
assert.deepEqual(TOOL_SCHEMAS.observe_environment.required, ['region']);
assert.throws(() => parseAction(JSON.stringify({ action: 'tool', name: 'observe_environment', args: {} })), /region/);
const functions = nativeFunctions([], ['observe_environment']);
assert.throws(() => extractNativeActions({ output: [{ type: 'function_call', name: 'observe_environment', arguments: '{}' }] }, functions), /region/);
let reads = 0;
const tools = createBuildingTools({ world: { snapshot: () => ({ dimension: 'overworld' }), read() { reads++; return 'air'; } },
    job: { origin: [0, 0, 0], dimension: 'overworld' } });
await assert.rejects(tools.call('observe_environment', {}), /region/);
await assert.rejects(tools.call('observe_environment', { region: { min: [257, 0, 0], max: [257, 0, 0] } }));
await assert.rejects(tools.call('observe_environment', { region: { min: [0, 0, 0], max: [256, 0, 0] } }));
assert.equal(reads, 0);

// Ordinary conversation does not need any world scan.
const chatScript = [{ action: 'tool', name: 'send_message', args: { text: 'Hello' } }, { action: 'end_turn' }];
const chat = createBuildingLoop({ world: { snapshot: () => ({ dimension: 'overworld', position: [0, 0, 0] }),
    read() { reads++; throw new Error('Conversation must not read terrain'); } }, save: async () => {},
    sendMessage: async () => ({ status: 'sent' }), model: { async sendRequest() { return JSON.stringify(chatScript.shift() ?? pause); } } });
assert.equal((await chat.start({ ...task, request: 'Hello' })).outcome, 'conversation');
assert.equal(reads, 0);
// Movement and local reads retain evidence for design, including the original
// timestamp. Design never performs another area scan; publication still reads
// the candidate cells and rejects actual conflicts.
for (const mode of ['area', 'block', 'conflict']) {
    let position = [0, 0, 2], scans = 0, actual = 'air', designInput;
    const job = { ...task, plan: { requirements: [{ id: 'goal', description: task.request }], steps: [] },
        placed: {}, removed: {}, events: [], assignmentVersion: 0, messages: [] };
    const world = {
        snapshot: () => ({ position, dimension: 'overworld' }),
        read(pos) { scans++; return pos.every(n => n === 0) ? actual : pos[1] < 0 ? 'stone' : 'air'; },
        async moveTo(target) { position = target; return true; },
        inspectBlock(pos) { return { status: 'observed', position: pos, block: world.read(pos) }; }
    };
    const tools = createBuildingTools({ job, world, checkpoint: async () => {}, design: async input => {
        designInput = input;
        if (mode === 'conflict') actual = 'glass'; // Changed during the model request.
        return { blueprint: compileBlueprint({ shapes: [{ kind: 'point', at: [0,0,0], block: 'stone' }] }, task.origin),
            summary: 'one block', coverage: [{ requirementId: 'goal', evidence: 'one stone' }], shapes: [] };
    } });
    if (mode === 'block') await tools.call('inspect_block', { position: [0,0,0] });
    else await tools.call('observe_environment', { region: small });
    const recorded = structuredClone(job.observation ?? job.blockObservations[0]);
    await tools.call('move_to', { position: [1,0,2] });
    const retained = job.observation ?? job.blockObservations[0];
    assert.equal(retained.observedAt, recorded.observedAt);
    assert.equal(retained.freshness, 'possibly_stale');
    assert(retained.staleReasons.includes('movement'));
    const before = scans;
    if (mode === 'conflict') {
        await assert.rejects(tools.useSkill('design_blueprint', {}), error => error.code === 'SITE_CONFLICT');
        assert.equal(job.assignment, undefined);
    } else assert.equal((await tools.useSkill('design_blueprint', {})).status, 'designed');
    assert(scans - before < volume(small), 'publication checks cells, not another region scan');
    const passed = mode === 'block' ? designInput.context.blockObservations[0] : designInput.context.observation;
    assert.equal(passed.observedAt, recorded.observedAt);
    assert.equal(passed.freshness, 'possibly_stale');
    if (mode === 'block') assert.equal(designInput.context.observation, null);
}

// Waiting for clarification and process restoration can proceed straight to
// design with retained evidence; old states without timestamps remain usable.
for (const restore of [false, true]) {
    const contexts = [], blocks = new Map();
    const world = { snapshot: () => ({ position: [0,0,2], dimension: 'overworld' }),
        read: pos => blocks.get(pos.join(',')) ?? (pos[1] < 0 ? 'stone' : 'air') };
    let script = [observe(small),
        { action: 'update_plan', steps: [{ id: 'build', title: 'Build', success: 'stone at origin', status: 'running' }] },
        { action: 'tool', name: 'send_message', args: { text: 'Confirm material?' } },
        { action: 'wait_for_user', reason: 'material' }];
    const options = { world, save: async () => {}, sendMessage: async () => ({ status: 'sent' }),
        model: { async sendRequest(turns, instructions, stop, options) {
            contexts.push({ purpose: options.purpose, context: JSON.parse(turns[0].content) });
            return JSON.stringify(script.shift() ?? pause);
        } } };
    let agent = createBuildingLoop(options);
    assert.equal((await agent.start(task)).status, 'waiting_user');
    const observedAt = agent.snapshot().observation.observedAt;
    if (restore) {
        const saved = agent.snapshot(); delete saved.observation.observedAt;
        agent = createBuildingLoop(options); agent.restore(saved);
    }
    script = [{ action: 'skill', name: 'design_blueprint', args: {} },
        { summary: 'one stone', shapes: [{ kind: 'point', at: [0,0,0], block: 'stone' }],
            coverage: [{ requirementId: 'goal', evidence: 'one stone' }] }, pause];
    const before = contexts.length;
    await agent.receiveMessage({ ...task, request: 'stone please' });
    const first = contexts[before].context;
    assert.equal(first.observation.freshness, 'possibly_stale');
    assert.equal(first.observation.observedAt, restore ? null : observedAt);
    assert(!first.nextStep.includes('Observe the site, then'));
    assert.equal(contexts[before + 1].purpose, 'blueprint', 'no extra observation decision required');
    assert.equal(agent.snapshot().assignmentVersion, 1);
}

// Partial samples retain their precise coverage and unknown counts in the
// decision context. Refreshing a single block does not freshen an area scan.
{
    const job = { ...task, plan: { requirements: [], steps: [] }, events: [], placed: {} };
    const world = { snapshot: () => ({ dimension: 'overworld', position: [0,0,2] }), read: () => null,
        inspectBlock: pos => ({ status: 'unloaded', position: pos, block: null }) };
    const tools = createBuildingTools({ world, job });
    const positions = Array.from({ length: 40 }, (_, x) => [x,0,0]);
    await tools.call('observe_cells', { positions });
    const context = JSON.parse(createDecisionRequest(job, world.snapshot(), {}).turns[0].content);
    assert.equal(context.observation.kind, 'cells');
    assert.deepEqual(context.observation.positions, positions);
    assert.equal(context.observation.counts.unloaded, 40);
    assert.equal(context.observation.airCount, 0);
    assert.equal(context.observation.unloadedTruncated, true);
    job.observation.freshness = 'possibly_stale';
    await tools.call('inspect_block', { position: [0,0,0] });
    assert.equal(job.observation.freshness, 'possibly_stale');
    assert.equal(job.blockObservations[0].freshness, 'observed');
}
console.log('Observation checks passed: task-sized scans, reusable evidence, local inspections, resume/wait reuse, publication conflicts and scan-free chat.');
