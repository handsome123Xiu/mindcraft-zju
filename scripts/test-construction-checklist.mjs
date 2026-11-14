import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { parseAction } from '../src/building/action-protocol.js';
import { compileBlueprint } from '../src/building/blueprint.js';
import { MATERIALS, GRAVITY_MATERIALS, materialNames } from '../src/building/materials.js';
import { compilePlacement, executePlacement } from '../src/building/placement-actions.js';
import { createBuildingTools } from '../src/building/tools.js';
import { checklistParts } from '../src/building/checklist.js';
import { createBuildingLoop, createDecisionRequest } from '../src/building/loop-agent.js';

const tool = (name, args = {}) => ({ action: 'tool', name, args });
const origin = [11, -60, 1];
function fixture(shapes) {
    const blocks = new Map(), writes = [];
    const world = {
        read: pos => blocks.get(pos.join(',')) ?? (pos[1] < origin[1] ? 'stone' : 'air'),
        snapshot: () => ({ dimension: 'overworld', position: [15, -60, 7], gameMode: 'creative' }),
        async prepare() {},
        async place(cell) { writes.push(cell.pos); blocks.set(cell.pos.join(','), cell.block); return 'placed'; }
    };
    const job = { request: '建造蛋糕', origin, dimension: 'overworld', placed: {}, removed: {}, events: [],
        assignmentVersion: 1, design: { origin, shapes }, plan: { requirements: [{ id: 'goal', description: '建造蛋糕' }], steps: [] },
        assignment: { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes }, origin) } };
    const tools = createBuildingTools({ world, job, checkpoint: async () => {} });
    return { job, world, blocks, writes, tools };
}

// The real regression: a legal action with an explanatory note is accepted.
// Aliases normalize without relaxing validation of the operation itself.
const place = tool('place_cube', { origin: [-3, 0, -2], size: 1, block: 'white_wool', coordinateSpace: 'blueprint' });
assert.deepEqual(parseAction(JSON.stringify({ ...place, note: '先逐层放置' })), place);
assert.deepEqual(parseAction(JSON.stringify({ type: 'tool', tool: 'place_cube', parameters: { ...place.args, comment: '说明' }, notes: ['a', 'b'] })), place);
assert.deepEqual(parseAction(JSON.stringify({ action: 'place_cube', arguments: place.args, explanation: '说明' })), place);
for (const value of [
    { ...place, name: 'exec', note: 'ignore me' },
    { ...place, args: { ...place.args, hollow: true } },
    { ...place, note: { action: 'dig_block' } },
    { ...place, parameters: { origin: [100, 100, 100] } },
    { ...place, type: 'skill' },
    { ...place, actions: [place, place] }
]) assert.throws(() => parseAction(JSON.stringify(value)));
assert.throws(() => parseAction(JSON.stringify(place) + '\n' + JSON.stringify(place)));

// Registry policy opens non-cubes; gravity and special blocks are allowed with notes.
{
    const registry = minecraftData('1.21.6');
    const names = materialNames(registry);
    assert(names.length > 900);
    for (const name of ['oak_stairs', 'oak_slab', 'oak_log', 'oak_door', 'red_bed', 'torch', 'lantern', 'chest', 'tnt', 'bedrock', 'sand', 'cake']) {
        assert(names.includes(name), name);
        assert.doesNotThrow(() => compileBlueprint({ shapes: [{ kind: 'point', at: [0, 0, 0], block: name }] }, origin));
    }
    assert(!MATERIALS.includes('water'), 'fluid/internal states without inventory items are not standalone materials');
    const f = fixture([{ kind: 'point', at: [0, 0, 0], block: 'stone' }]);
    // 重力/特殊方块不再被程序拒绝：可放置，风险走 placementNotes。
    assert.doesNotThrow(() => compilePlacement('place_block', { position: origin, block: 'sand' }));
    const cakeInfo = await f.tools.call('list_materials', { query: 'cake', limit: 1 });
    assert(cakeInfo.notes?.cake?.length, 'cake 应带特殊放置提示');
    const matches = await f.tools.call('list_materials', { query: 'stairs', limit: 2 });
    assert.equal(matches.materials.length, 2);
    assert(matches.materials.every(item => item.name.endsWith('_stairs')));
    assert.equal(matches.nextOffset, 2);
}

const base = [
    { kind: 'box', part: '底部两侧', min: [-1, 0, -3], max: [1, 1, -3], block: 'white_wool' },
    { kind: 'box', part: '底部主体', min: [-3, 0, -2], max: [3, 1, 2], block: 'white_wool' },
    { kind: 'box', part: '底部两侧', min: [-1, 0, 3], max: [1, 1, 3], block: 'white_wool' }
];

// Reproduce the actual cake omission: the 70-cell center is built, but 12 side
// cells remain. They stay visible even after 20 later tool feedback entries.
{
    const f = fixture(base);
    for (const cell of f.job.assignment.blueprint.blocks) if (cell.pos[2] >= -1 && cell.pos[2] <= 3) f.blocks.set(cell.pos.join(','), cell.block);
    f.job.events = Array.from({ length: 20 }, () => ({ kind: 'feedback', name: 'place_row', output: { status: 'completed' } }));
    const check = (await f.tools.call('get_build_checklist')).checklist;
    assert.equal(check.parts.find(part => part.title === '底部两侧').remaining, 12);
    assert.equal(check.parts.find(part => part.title === '底部主体').verified, 70);
    const context = JSON.parse(createDecisionRequest(f.job, f.world.snapshot(), {}).turns[0].content);
    assert.equal(context.constructionChecklist.parts[0].remaining, 12);
    const inspected = await f.tools.call('inspect_part', { partId: 'part-1' });
    assert.equal(inspected.suggestions.actions.length, 4);
    assert.equal(f.writes.length, 0, 'inspection never executes its suggestions');
    for (const action of inspected.suggestions.actions) await f.tools.call(action.name, action.args);
    assert.equal(f.tools.inspect().verified, 82);
    assert(f.job.checklist.parts.every(part => part.status === 'verified'));
    // A verified part can regress; neither a cached checkbox nor old evidence wins.
    f.blocks.delete('10,-60,-2');
    assert.equal(f.tools.refreshChecklist().parts[0].remaining, 1);
    assert.equal(f.tools.inspect().differences.length, 1);
    f.job.assignment.blueprint.parts[0].positions.pop();
    assert.throws(() => checklistParts(f.job), /遗漏/);
}

// A box that confused the live model yields exactly two planar suggestions.
// A frame's suggestions contain its 16 boundary cells, never its 9 air cells.
{
    const box = fixture([base[1]]);
    assert.throws(() => compilePlacement('place_rectangle', { min: [-3, 0, -2], max: [3, 1, 2], block: 'white_wool' }),
        error => error.code === 'PRIMITIVE_GEOMETRY' && error.message.includes('inspect_part'));
    const suggestions = (await box.tools.call('inspect_part', { partId: 'part-1' })).suggestions.actions;
    assert.equal(suggestions.length, 2);
    assert(suggestions.every(action => action.name === 'place_rectangle' && action.args.min[1] === action.args.max[1]));
    const frame = fixture([{ kind: 'frame', part: '奶油边框', min: [-2, 0, -2], max: [2, 0, 2], block: 'white_concrete' }]);
    const actions = (await frame.tools.call('inspect_part', { partId: 'part-1' })).suggestions.actions;
    const cells = actions.flatMap(action => compilePlacement(action.name, action.args).cells);
    assert.equal(cells.length, 16);
    assert(cells.every(cell => Math.abs(cell.pos[0]) === 2 || Math.abs(cell.pos[2]) === 2));
    for (const action of actions) await frame.tools.call(action.name, action.args);
    frame.blocks.set(origin.join(','), 'stone');
    const clearance = await frame.tools.call('inspect_part', { partId: 'clearance' });
    assert.equal(clearance.status, 'blocked');
    assert.equal(clearance.remaining, 1);
    // An occupied clearance cell now yields a dig suggestion with the observed block.
    const dig = clearance.suggestions.actions;
    assert.equal(dig.length, 1);
    assert.equal(dig[0].name, 'dig_block');
    assert.equal(dig[0].args.expectedBlock, 'stone');
    assert.equal(frame.tools.inspect().status, 'blocked');
    frame.blocks.set(origin.join(','), 'air');
    assert.equal((await frame.tools.call('inspect_part', { partId: 'clearance' })).suggestions.actions.length, 0);
    assert.equal(frame.tools.inspect().status, 'completed');
}

// Replacement and openings produce a single, non-overlapping final ownership
// map. Stale suggestions cannot silently execute against a newer blueprint.
{
    const f = fixture([
        { kind: 'box', part: '主体', min: [0, 0, 0], max: [2, 0, 2], block: 'quartz_block' },
        { kind: 'replace', part: '红色装饰', min: [1, 0, 1], max: [1, 0, 1], from: 'quartz_block', block: 'red_concrete' },
        { kind: 'opening', min: [0, 0, 0], max: [0, 0, 0] }
    ]);
    assert.equal(f.job.assignment.blueprint.parts.reduce((n, part) => n + part.positions.length, 0), 8);
    const p = await f.tools.call('inspect_part', { partId: 'part-1' });
    for (const action of p.suggestions.actions) for (const cell of compilePlacement(action.name, action.args).cells) {
        assert.notDeepEqual(cell.pos, [1, 0, 1]);
        assert.notDeepEqual(cell.pos, [0, 0, 0]);
    }
    f.job.assignmentVersion = 2;
    await assert.rejects(f.tools.call(p.suggestions.actions[0].name, p.suggestions.actions[0].args), /版本已变化/);
    assert.equal(f.writes.length, 0);
    delete f.job.assignment.blueprint.parts;
    assert.equal((await f.tools.call('get_build_checklist')).checklist.parts.filter(part => part.id !== 'clearance').length, 1,
        'old saved blueprints get complete layer-based parts');
}

// Full loop completion still re-reads the world after all parts were checked.
// A tampered saved checkbox cannot authorize completion after a block vanished.
{
    const f = fixture([{ kind: 'box', part: '平台', min: [0, 0, 0], max: [1, 0, 0], block: 'stone' }]);
    const done = { action: 'update_plan', steps: [{ id: 's1', title: '施工', success: '现场两格正确', status: 'done', evidence: '部件通过' }] };
    const finish = { action: 'finish', summary: '完成', requirementReview: [{ requirementId: 'goal', satisfied: true, evidence: '现场通过' }] };
    const script = [done, { action: 'skill', name: 'design_blueprint', args: {} },
        { summary: '平台', coverage: [{ requirementId: 'goal', evidence: '两格平台' }], shapes: f.job.design.shapes },
        tool('place_row', { start: [0, 0, 0], end: [1, 0, 0], block: 'stone', coordinateSpace: 'blueprint' }),
        tool('inspect_part', { partId: 'part-1' }),
        () => { f.blocks.delete(origin.join(',')); return finish; }, { action: 'blocked', reason: '需要修复缺失格' }];
    const files = new Map();
    const agent = createBuildingLoop({ world: f.world, model: { async sendRequest() {
        const item = script.shift(); return JSON.stringify(typeof item === 'function' ? item() : item);
    } }, save: async (id, type, data) => files.set(type, structuredClone(data)) });
    const result = await agent.start({ request: '建造平台', origin, dimension: 'overworld', owner: 'tester' });
    assert.equal(result.status, 'blocked');
    assert(agent.snapshot().events.some(event => event.output.message?.includes('现场验收尚未通过')));
    const saved = files.get('state');
    saved.checklist.parts.forEach(part => { part.status = 'verified'; part.remaining = 0; });
    const resumed = createBuildingLoop({ world: f.world, model: { async sendRequest() { return JSON.stringify({ action: 'blocked', reason: '先看清单' }); } }, save: async () => {} });
    resumed.restore(saved);
    await resumed.resume();
    assert.equal(resumed.snapshot().checklist.parts.find(part => part.id === 'part-1').remaining, 1);
}

console.log('Checklist checks passed: metadata compatibility, registry materials/gravity policy, missing cake sides, geometric suggestions, part/air verification, revisions and resume.');
