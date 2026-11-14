import assert from 'node:assert/strict';
import { compileBlueprint, prepareAssignment } from '../src/building/blueprint.js';
import { createPlanner } from '../src/building/planner.js';
import { inspectAssignment } from '../src/building/inspection.js';
import { parseBuildMessage } from '../src/building/chat-input.js';
import { resolveGroundOrigin } from '../src/building/site.js';

const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const ground = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const flatSite = ([, y]) => y <= -61 ? ground : air;
assert.deepEqual(resolveGroundOrigin([16, -51, 7], flatSite, -64, 384), [16, -60, 7]);
assert.deepEqual(resolveGroundOrigin([16, -60, 7], flatSite, -64, 384), [16, -60, 7]);
assert.throws(() => resolveGroundOrigin([16, -51, 7], () => null, -64, 384), /尚未加载/);
assert.throws(() => resolveGroundOrigin([16, -51, 7], () => air, -64, 384), /没有找到地面/);
assert.throws(() => resolveGroundOrigin([16, -51, 7], () => ({ name: 'water', shapes: [] }), -64, 384), /实体地面/);
assert.deepEqual(parseBuildMessage('bulid a 5-level pyramid with sand blocks', 'andy'),
    { action: 'message', request: 'bulid a 5-level pyramid with sand blocks' });

assert.deepEqual(parseBuildMessage('用沙子建造一座实心五层阶梯金字塔。', 'andy'),
    { action: 'message', request: '用沙子建造一座实心五层阶梯金字塔。' });
assert.deepEqual(parseBuildMessage('build a five-level pyramid with sand blocks', 'andy'),
    { action: 'message', request: 'build a five-level pyramid with sand blocks' });
assert.equal(parseBuildMessage('Build a five-level hollow pyramid with sand blocks.', 'andy').action, 'message');
assert.deepEqual(parseBuildMessage('Andy，继续建造', 'andy'), { action: 'resume' });
for (const request of ['用石砖建造一座小屋', '用沙子建造一座五层空心金字塔', '你好呀',
    'add windows and door to the wooden house', '给木屋加上窗户和门',
    'build a wooden house with windows and a doorway', '放置一排石头',
    '用玻璃放置一个立方体', '铺设一个矩形地板', 'place a row of stone blocks',
    'hello, how are you?', '为什么卡住了？', '红色吧', '@bob 写一个江字']) {
    assert.deepEqual(parseBuildMessage(request, 'andy'), { action: 'message', request });
}
assert.deepEqual(parseBuildMessage('Andy, please add windows to the house', 'andy'),
    { action: 'message', request: 'please add windows to the house' });

// Natural location/site prefixes must not silently discard building requests.
for (const message of [
    '在地面上搭一个平面的江字', '在地面搭建一个平面的江字',
    '请在地面上搭建一个江字', '在地面用石砖搭一个江字',
    '找块空地，写一个江字，用石砖', '找一块空地，写一个江字',
    '在空地上写一个江字', '用石砖写一个江字', '请搭一个江字'
]) {
    assert.deepEqual(parseBuildMessage(message, 'andy'), { action: 'message', request: message });
}
assert.equal(parseBuildMessage('ZhiXiu，在地面搭建一个平面的江字', 'ZhiXiu').action, 'message');
assert.equal(parseBuildMessage('在地面搭建一个平面的江字', 'ZhiXiu').action, 'message');
assert.deepEqual(parseBuildMessage('进度', 'andy'), { action: 'status' });
assert.equal(parseBuildMessage('   ', 'andy'), null);
assert.deepEqual(parseBuildMessage('暂停！', 'andy'), { action: 'pause' });
assert.deepEqual(parseBuildMessage('bob，建造一个平台', 'andy'), { action: 'message', request: 'bob，建造一个平台' });
assert.deepEqual(parseBuildMessage('!build at 1 64 2 在地面搭建一个江字', 'andy'), {
    action: 'message', origin: [1, 64, 2], request: '在地面搭建一个江字'
});

// Synthetic model output used only to test generic compilation and execution.
const shapes = [
    { kind: 'box', min: [-4, 0, -4], max: [4, 0, 4], block: 'stone' },
    { kind: 'box', min: [-3, 1, -3], max: [3, 1, 3], block: 'stone' },
    { kind: 'box', min: [-2, 2, -2], max: [2, 2, 2], block: 'stone' },
    { kind: 'box', min: [-1, 3, -1], max: [1, 3, 1], block: 'stone' },
    { kind: 'point', at: [0, 4, 0], block: 'stone' }
];
const origin = [8, -60, -3];
const blueprint = compileBlueprint({ shapes }, origin);
assert.equal(blueprint.blocks.length, 165);
const assignment = { version: 1, dimension: 'overworld', blueprint };
const top = { ...assignment, region: { min: [4, -56, -7], max: [12, -56, 1] } };
assert.equal(prepareAssignment(top).targets.length, 1);
assert.throws(() => prepareAssignment({ ...assignment, region: { min: [0, -60, -7], max: [12, -56, 1] } }));
assert.throws(() => compileBlueprint({ shapes: [{ ...shapes[0], block: 'sand' }] }, origin), /重力材料/);
assert.throws(() => compileBlueprint({ shapes: [{ kind: 'pyramid', at: [0, 0, 0], levels: 5, block: 'sand' }] }, origin));

// World fixtures verify blueprints without an automatic construction executor.
const blocks = new Map(blueprint.blocks.map(cell => [cell.pos.join(','), cell.block]));
const world = { read: pos => blocks.get(pos.join(',')) ?? 'air' };
assert.equal(inspectAssignment(assignment, world).verified, 165);
assert.equal(inspectAssignment(assignment, world).differences.length, 0);
assert.equal(inspectAssignment(top, world).verified, 1);
blocks.set('4,-56,-7', 'stone');
assert.equal(inspectAssignment(top, world).differences[0].reason, 'occupied');
blocks.delete('4,-56,-7');
assert.equal(inspectAssignment(top, { read: () => null }).differences[0].reason, 'unloaded');
assert.equal(inspectAssignment(assignment, { read: () => 'air' }).verified, 0);

let calls = 0;
const planner = createPlanner({
    async sendRequest(turns, instructions, stop, { runId }) {
        calls++;
        assert.equal(turns[0].content, '建造五层沙子金字塔');
        assert(!/pyramid|金字塔/i.test(instructions));
        assert.equal(stop, null);
        assert.equal(runId, 'test');
        return JSON.stringify({ shapes });
    }
});
assert.deepEqual(await planner({ request: '建造五层沙子金字塔', origin, runId: 'test' }), blueprint);
assert.equal(calls, 1);

// Other requests must receive the model's different geometry, without a fallback.
const alternate = createPlanner({ async sendRequest(turns) {
    assert.equal(turns[0].content, 'build a wooden house');
    return JSON.stringify({ shapes: [{ kind: 'shell', min: [0, 0, 0], max: [4, 3, 4], block: 'oak_planks' }] });
} });
const house = await alternate({ request: 'build a wooden house', origin });
assert(house.blocks.every(block => block.block === 'oak_planks'));
assert.notDeepEqual(house, blueprint);

console.log('Building checks passed: geometry, independent verification, planner and chat controls.');
