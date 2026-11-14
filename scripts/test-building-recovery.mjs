import assert from 'node:assert/strict';
import { parseAction } from '../src/building/action-protocol.js';
import { compileBlueprint, MATERIALS } from '../src/building/blueprint.js';
import { createBuildingTools } from '../src/building/tools.js';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { attachmentFailure, compilePlacement, executePlacement } from '../src/building/placement-actions.js';

const task = { request: '拆除指定砂岩', origin: [0, 0, 0], dimension: 'overworld', owner: 'tester' };
const tool = (name, args = {}) => ({ action: 'tool', name, args });
const plan = { action: 'update_plan', steps: [{ id: 's1', title: '执行并验收', success: '完整目标现场验收通过', status: 'running' }] };
const done = { action: 'update_plan', patch: true, steps: [{ id: 's1', status: 'done', evidence: '全部登记目标现场核验通过' }] };
const finish = { action: 'finish', summary: '目标已验收', requirementReview: [{ requirementId: 'goal', satisfied: true, evidence: '完整目标现场核验通过' }] };

function fixture({ blocks = new Map(), origin = [0, 0, 0], script = [], limits = {}, overrides = {} } = {}) {
    const writes = [], digs = [], files = new Map(), calls = [];
    const world = {
        read: pos => blocks.get(pos.join(',')) ?? (pos[1] < origin[1] ? 'stone' : 'air'),
        snapshot: () => ({ dimension: 'overworld', position: [origin[0], origin[1], origin[2] + 8], gameMode: 'creative' }),
        async prepare() {},
        async place(cell) {
            const blocked = attachmentFailure(cell, world);
            if (blocked) return blocked;
            writes.push(cell.pos);
            blocks.set(cell.pos.join(','), cell.block);
            return 'placed';
        },
        async digBlock(pos, expected) {
            if (world.read(pos) !== expected) return 'target_changed';
            digs.push(pos);
            blocks.set(pos.join(','), 'air');
            return 'removed';
        },
        inspectBlock: pos => ({ status: 'observed', position: pos, block: world.read(pos) }),
        ...overrides
    };
    const model = { modelName: 'offline-regression', async sendRequest(turns, instructions, stop, options) {
        calls.push({ context: JSON.parse(turns[0].content.startsWith('{') ? turns[0].content : '{}'), purpose: options.purpose });
        let next = script.shift();
        if (typeof next === 'function') next = await next();
        return typeof next === 'string' ? next : JSON.stringify(next ?? { action: 'blocked', reason: '测试脚本结束' });
    } };
    const save = async (id, type, data) => files.set(type, structuredClone(data));
    const agent = createBuildingLoop({ world, model, save, ...limits });
    const job = { origin, dimension: 'overworld', placed: {}, removed: {}, placementAttempts: 0,
        plan: { requirements: [{ id: 'goal', description: task.request }], steps: [] }, events: [] };
    const tools = createBuildingTools({ world, job, checkpoint: async () => {} });
    return { blocks, writes, digs, files, calls, world, agent, job, tools };
}

// Only equivalent single-action envelopes are accepted; malformed or ambiguous
// output cannot quietly execute the first action or guess destructive arguments.
assert.deepEqual(parseAction('{"action":"place_block","args":{"position":[1,2,3],"block":"stone"}}'),
    tool('place_block', { position: [1, 2, 3], block: 'stone' }));
assert.deepEqual(parseAction('{"action":"tool_call","name":"inspect_build","arguments":{}}'), tool('inspect_build'));
assert.deepEqual(parseAction('{"action":"dig_block","position":[1,2,3],"expectedBlock":"stone"}'),
    tool('dig_block', { position: [1, 2, 3], expectedBlock: 'stone' }));
for (const raw of [
    '{"action":"end_turn"}{"action":"end_turn"}', '[{"action":"end_turn"}]',
    '{"action":"place_block","args":{"position":[1,2,3],"block":"stone"},"position":[4,5,6]}',
    '{"action":"tool","name":"place_block","args":{"position":[1,2],"block":"stone"}}',
    '{"action":"tool","name":"dig_block","args":{"position":[1,2,3]}}',
    '{"action":"tool","name":"place_cube","args":{"origin":[0,0,0],"size":2,"block":"stone","hollow":true}}',
    '{"action":"tool","name":"inspect_build","args":null}'
]) assert.throws(() => parseAction(raw));

// Border, shell and explicit design replacement have distinct semantics.
{
    const frame = compileBlueprint({ shapes: [{ kind: 'frame', min: [0, 0, 0], max: [6, 0, 6], block: 'red_terracotta' }] }, [0, 0, 0]);
    assert.equal(frame.blocks.length, 24);
    assert(!frame.blocks.some(cell => cell.pos.join(',') === '3,0,3'));
    assert.throws(() => compileBlueprint({ shapes: [{ kind: 'shell', min: [0, 0, 0], max: [6, 0, 6], block: 'stone' }] }, [0, 0, 0]), /frame/);
    const base = { kind: 'box', min: [0, 0, 0], max: [6, 0, 6], block: 'quartz_block' };
    const replace = { kind: 'replace', min: [0, 0, 0], max: [1, 0, 1], from: 'quartz_block', block: 'red_terracotta' };
    const design = compileBlueprint({ shapes: [base, replace] }, [0, 0, 0]);
    assert.equal(design.blocks.length, 49);
    assert.equal(design.blocks.filter(cell => cell.block === 'red_terracotta').length, 4);
    assert.throws(() => compileBlueprint({ shapes: [base, { ...replace, from: 'stone' }] }, [0, 0, 0]), /from 不匹配/);
    assert.throws(() => compileBlueprint({ shapes: [base, { ...base, block: 'red_terracotta' }] }, [0, 0, 0]), /显式替换/);
    assert.throws(() => compileBlueprint({ shapes: [{ ...base, facing: 'east' }] }, [0, 0, 0]), /未知字段/);
    for (const material of ['red_terracotta', 'pink_wool', 'blue_stained_glass', 'iron_block']) assert(MATERIALS.includes(material));
}

// A ground-heavy page doesn't hide requested building cells. Pagination is over
// matches and counts remain independent of page size and material filters.
{
    const f = fixture({ blocks: new Map([['8,0,8', 'gold_block'], ['8,1,8', 'gold_block']]) });
    const region = { min: [0, -1, 0], max: [8, 2, 8] };
    const first = await f.tools.call('observe_environment', { region, limit: 1 });
    assert.equal(first.occupiedTruncated, true);
    assert.equal(first.counts.gold_block, 2);
    const filtered = await f.tools.call('observe_environment', { region, blocks: ['gold_block'], limit: 1 });
    assert.deepEqual(filtered.occupied[0].pos, [8, 0, 8]);
    assert.equal(filtered.nextOffset, 1);
    const second = await f.tools.call('observe_environment', { region, blocks: ['gold_block'], offset: filtered.nextOffset, limit: 1 });
    assert.deepEqual(second.occupied[0].pos, [8, 1, 8]);
    assert.equal(second.nextOffset, null);
    assert.equal(second.counts.gold_block, 2);
    const withoutGround = await f.tools.call('observe_environment', { region, excludeBlocks: ['stone'] });
    assert.equal(withoutGround.occupied.length, 2);
}

// Coordinate conversion uses the DESIGN origin, including negative world Y.
// Preview changes nothing; final blueprint query reflects material replacement.
{
    const f = fixture({ origin: [3, -60, 2] });
    f.job.design = { origin: [5, -60, 4] };
    f.job.assignment = { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes: [
        { kind: 'box', min: [-1, 0, -1], max: [1, 0, 1], block: 'quartz_block' }
    ] }, f.job.design.origin) };
    const args = { min: [-1, 0, -1], max: [1, 0, 1], block: 'quartz_block', coordinateSpace: 'blueprint' };
    assert.equal((await f.tools.call('place_rectangle', { ...args, preview: true })).status, 'preview');
    assert.equal(f.writes.length, 0);
    assert.equal((await f.tools.call('place_rectangle', args)).verified, 9);
    assert.equal(f.blocks.get('4,-60,3'), 'quartz_block');
    const page = await f.tools.call('inspect_blueprint', { layer: 0, limit: 1 });
    assert.deepEqual(page.cells[0].relative, [-1, 0, -1]);
    assert.deepEqual(page.cells[0].pos, [4, -60, 3]);
    assert.equal(page.nextOffset, 1);
    await assert.rejects(f.tools.call('place_block', { position: [4, -60, 3], block: 'stone' }), /蓝图材料=quartz_block/);
    await assert.rejects(f.tools.call('place_block', { position: [0, 0, 0], block: 'stone', coordinateSpace: 'relative' }), /请选择/);
}

// A widening upper layer starts over its center support, then grows outward.
// A completely disconnected layer remains blocked, with no writes/scaffolds.
{
    const f = fixture({ blocks: new Map([['1,0,1', 'stone']]) });
    const primitive = compilePlacement('place_rectangle', { min: [0, 1, 0], max: [2, 1, 2], block: 'stone' });
    const result = await executePlacement(primitive, f.world, { dimension: 'overworld' });
    assert.equal(result.status, 'completed');
    assert.deepEqual(f.writes[0], [1, 1, 1]);
    assert.equal(f.writes.length, 9);
    const floating = fixture();
    const blocked = await executePlacement(primitive, floating.world, { dimension: 'overworld' });
    assert.equal(blocked.differences[0].reason, 'missing_reference');
    assert.equal(floating.writes.length, 0);
    assert.throws(() => compilePlacement('place_rectangle', { min: [0, 1, 0], max: [2, 1, 2], block: 'sand' }), /重力材料/);
}

const removalRegion = { min: [0, 0, 0], max: [2, 0, 0] };
const demolitionTarget = tool('set_demolition_target', { region: removalRegion });
const removeRow = tool('dig_row', { start: [0, 0, 0], end: [2, 0, 0], expectedBlock: 'sandstone' });

// Standalone demolition can finish, persists its full target before removal,
// rejects early completion, and does not fabricate a construction blueprint.
{
    const f = fixture({ blocks: new Map(['0,0,0', '1,0,0', '2,0,0'].map(key => [key, 'sandstone'])),
        script: [plan, demolitionTarget, done, finish, removeRow, finish] });
    const result = await f.agent.start(task);
    assert.equal(result.status, 'completed');
    assert.equal(result.outcome, 'demolition');
    assert.equal(result.verified, 3);
    assert.equal(result.removalCount, 3);
    assert.equal(f.agent.snapshot().assignment, null);
    assert(f.agent.snapshot().events.some(e => e.output.message?.includes('现场验收尚未通过')));
}

// Resume rechecks the world and retains all unremoved targets, even after the
// client tries to register a smaller selection. A target changing blocks is not
// silently deleted, and preflight mismatch prevents any batch writes.
{
    const blocks = new Map(['0,0,0', '1,0,0', '2,0,0'].map(key => [key, 'sandstone']));
    const first = fixture({ blocks, script: [plan, demolitionTarget, tool('dig_block', { position: [0, 0, 0], expectedBlock: 'sandstone' })],
        limits: { maxModelRequests: 3 } });
    assert.equal((await first.agent.start(task)).status, 'paused');
    const state = first.files.get('state');
    assert.equal(Object.keys(state.demolition.targets).length, 3);
    const second = fixture({ blocks, script: [tool('set_demolition_target', { region: { min: [0, 0, 0], max: [0, 0, 0] } }), removeRow, done, finish] });
    second.agent.restore(state);
    assert.equal((await second.agent.resume()).status, 'completed');
    assert.equal(second.agent.snapshot().result.removalCount, 3);
    assert.equal(Object.keys(second.agent.snapshot().demolition.targets).length, 3);
    const changed = fixture({ blocks: new Map([['0,0,0', 'sandstone'], ['1,0,0', 'gold_block'], ['2,0,0', 'sandstone']]) });
    await changed.tools.call('set_demolition_target', { region: removalRegion });
    assert.equal((await changed.tools.call(removeRow.name, removeRow.args)).reason, 'target_changed');
    assert.equal(changed.digs.length, 0);
    await assert.rejects(changed.tools.call('dig_block', { position: [4, 0, 0], expectedBlock: 'stone' }), /不在已登记/);
    await assert.rejects(changed.tools.call('set_demolition_target', { region: { min: [257, 0, 0], max: [257, 0, 0] } }), /超出本次工地/);
}

// Invalid action answers are journaled, and the next decision gets the exact
// expected field. Renaming failing plan titles cannot evade the no-progress guard.
{
    const invalid = '{"action":"unknown_operation"}';
    const f = fixture({ script: [invalid, invalid, invalid] });
    assert.equal((await f.agent.start(task)).status, 'paused');
    assert.equal(f.files.get('response-0001').text, invalid);
    const feedback = f.calls[1].context.recentEvents.at(-1).output;
    assert.equal(feedback.field, 'action');
    assert(feedback.expected.includes('tool'));
    const badPlans = [1, 2, 3].map(n => ({ action: 'update_plan', steps: [{ id: 's1', title: '改名' + n, evidence: '全部为空气' }] }));
    const p = fixture({ script: badPlans });
    assert.equal((await p.agent.start(task)).status, 'blocked');
    assert.equal(p.calls.length, 3);
    assert.equal(p.agent.snapshot().events.at(-1).output.field, 'steps[0].success');
    const repeats = fixture({ script: [plan, ...Array.from({ length: 8 }, (_, n) => ({ action: 'update_plan', patch: true,
        steps: [{ id: 's1', title: '重复改写' + n, evidence: '文字变化不代表施工进展' }] }))] });
    const paused = await repeats.agent.start(task);
    assert.equal(paused.status, 'paused');
    assert.match(paused.reason, /连续六次/);
    assert.equal(repeats.calls.length, 7);
}

// Batch demolition is top-down, bounded and cancellable. A pause arriving just
// after the server removes a block still journals it; retry skips confirmed air.
{
    const blocks = new Map();
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) blocks.set(`${x},${y},${z}`, 'stone');
    const abort = new AbortController();
    const f = fixture({ blocks });
    await f.tools.call('set_demolition_target', { region: { min: [0, 0, 0], max: [1, 1, 1] } });
    const original = f.world.digBlock;
    f.world.digBlock = async (...args) => {
        const result = await original(...args);
        if (f.digs.length === 2) abort.abort(new Error('用户暂停'));
        return result;
    };
    await assert.rejects(f.tools.call('dig_cube', { origin: [0, 0, 0], size: 2, expectedBlock: 'stone' }, abort.signal), /用户暂停/);
    assert.equal(f.job.removalCount, 2);
    assert.equal(Object.keys(f.job.removed).length, 2);
    assert(f.digs.every(pos => pos[1] === 1));
    f.world.digBlock = original;
    const completed = await f.tools.call('dig_cube', { origin: [0, 0, 0], size: 2, expectedBlock: 'stone' });
    assert.equal(completed.attempts, 6);
    assert.equal(f.tools.inspect().verified, 8);
    assert.equal(f.digs.length, 8);
    assert(f.digs.every((pos, i) => !i || pos[1] <= f.digs[i - 1][1]));
}

// End-to-end scripted cake: mixed materials, an actual frame, multiple relative
// primitives, incremental plan completion and independent world verification.
// Geometry and primitive choices come from model replies, never a preset builder.
{
    const shapes = [
        { kind: 'box', min: [-3, 0, -3], max: [3, 0, 3], block: 'quartz_block' },
        { kind: 'frame', min: [-3, 1, -3], max: [3, 1, 3], block: 'red_terracotta' },
        { kind: 'box', min: [-2, 1, -2], max: [2, 1, 2], block: 'quartz_block' },
        { kind: 'box', min: [-2, 2, -2], max: [2, 2, 2], block: 'pink_terracotta' },
        { kind: 'box', min: [-1, 3, -1], max: [1, 3, 1], block: 'quartz_block' },
        { kind: 'point', at: [0, 4, 0], block: 'red_terracotta' },
        { kind: 'point', at: [0, 5, 0], block: 'yellow_terracotta' }
    ];
    const rect = (min, max, block) => tool('place_rectangle', { min, max, block, coordinateSpace: 'blueprint' });
    const script = [plan, { action: 'skill', name: 'design_blueprint', args: {} },
        { summary: '分层蛋糕', shapes, coverage: [{ requirementId: 'goal', evidence: '分层主体、红边和蜡烛' }] },
        rect([-3, 0, -3], [3, 0, 3], 'quartz_block'),
        ...[ [[-3, 1, -3], [3, 1, -3]], [[-3, 1, 3], [3, 1, 3]],
            [[-3, 1, -2], [-3, 1, 2]], [[3, 1, -2], [3, 1, 2]] ].map(([start, end]) =>
            tool('place_row', { start, end, block: 'red_terracotta', coordinateSpace: 'blueprint' })),
        rect([-2, 1, -2], [2, 1, 2], 'quartz_block'), rect([-2, 2, -2], [2, 2, 2], 'pink_terracotta'),
        rect([-1, 3, -1], [1, 3, 1], 'quartz_block'),
        tool('place_block', { position: [0, 4, 0], block: 'red_terracotta', coordinateSpace: 'blueprint' }),
        tool('place_block', { position: [0, 5, 0], block: 'yellow_terracotta', coordinateSpace: 'blueprint' }),
        tool('inspect_build'), done, finish];
    const f = fixture({ origin: [3, -60, 2], script });
    const result = await f.agent.start({ ...task, request: '给我搭建一个蛋糕', origin: [3, -60, 2] });
    assert.equal(result.status, 'completed');
    assert.equal(result.verified, 134);
    assert.equal(f.blocks.get('3,-59,2'), 'quartz_block');
    assert.equal(f.blocks.get('0,-59,-1'), 'red_terracotta');
    assert(!f.agent.snapshot().events.some(e => e.output.status === 'error'));
}

console.log('Recovery checks passed: action schemas, design composition, observation pages, relative placement, overhangs, demolition lifecycle, response journals and no-progress detection.');
