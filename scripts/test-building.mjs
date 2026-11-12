import assert from 'node:assert/strict';
import { compileBlueprint, prepareAssignment } from '../src/building/blueprint.js';
import { createPlanner } from '../src/building/planner.js';
import { executeAssignment } from '../src/building/executor.js';
import { createBuildController } from '../src/building/controller.js';
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
    { action: 'build', request: 'bulid a 5-level pyramid with sand blocks' });

assert.deepEqual(parseBuildMessage('用沙子建造一座实心五层阶梯金字塔。', 'andy'),
    { action: 'build', request: '用沙子建造一座实心五层阶梯金字塔' });
assert.deepEqual(parseBuildMessage('build a five-level pyramid with sand blocks', 'andy'),
    { action: 'build', request: 'build a five-level pyramid with sand blocks' });
assert.equal(parseBuildMessage('Build a five-level hollow pyramid with sand blocks.', 'andy').action, 'build');
assert.deepEqual(parseBuildMessage('Andy，继续建造', 'andy'), { action: 'resume' });
assert.equal(parseBuildMessage('用石砖建造一座小屋', 'andy').action, 'build');
assert.equal(parseBuildMessage('用沙子建造一座五层空心金字塔', 'andy').action, 'build');
assert.equal(parseBuildMessage('你好呀', 'andy'), null);
assert.equal(parseBuildMessage('add windows and door to the wooden house', 'andy').action, 'unsupported_edit');
assert.equal(parseBuildMessage('Andy, please add windows to the house', 'andy').action, 'unsupported_edit');
assert.equal(parseBuildMessage('给木屋加上窗户和门', 'andy').action, 'unsupported_edit');
assert.equal(parseBuildMessage('build a wooden house with windows and a doorway', 'andy').action, 'build');

// Synthetic model output used only to test generic compilation and execution.
const shapes = [
    { kind: 'box', min: [-4, 0, -4], max: [4, 0, 4], block: 'sand' },
    { kind: 'box', min: [-3, 1, -3], max: [3, 1, 3], block: 'sand' },
    { kind: 'box', min: [-2, 2, -2], max: [2, 2, 2], block: 'sand' },
    { kind: 'box', min: [-1, 3, -1], max: [1, 3, 1], block: 'sand' },
    { kind: 'point', at: [0, 4, 0], block: 'sand' }
];
const origin = [8, -60, -3];
const blueprint = compileBlueprint({ shapes }, origin);
assert.equal(blueprint.blocks.length, 165);
const assignment = { version: 1, dimension: 'overworld', blueprint };
const top = { ...assignment, region: { min: [4, -56, -7], max: [12, -56, 1] } };
assert.equal(prepareAssignment(top).targets.length, 1);
assert.throws(() => prepareAssignment({ ...assignment, region: { min: [0, -60, -7], max: [12, -56, 1] } }));
assert.throws(() => compileBlueprint({ shapes: [{ ...shapes[0], block: 'tnt' }] }, origin));
assert.throws(() => compileBlueprint({ shapes: [{ kind: 'pyramid', at: [0, 0, 0], levels: 5, block: 'sand' }] }, origin));

const blocks = new Map();
const read = pos => blocks.get(pos.join(',')) ?? 'air';
let writes = 0;
const world = {
    async prepare() {},
    read,
    async place({ pos, block }) {
        if (pos[1] > origin[1] && read([pos[0], pos[1] - 1, pos[2]]) !== 'sand') {
            return 'missing_support';
        }
        writes++;
        blocks.set(pos.join(','), block);
        return 'placed';
    }
};
const result = await executeAssignment(assignment, world);
assert.equal(result.status, 'completed');
assert.equal(result.verified, 165);
assert.equal(writes, 165);
assert.equal((await executeAssignment(assignment, world)).attempts, 0);
assert.equal((await executeAssignment(top, world)).verified, 1);
blocks.set('4,-56,-7', 'stone');
const blocked = await executeAssignment(top, world);
assert.equal(blocked.status, 'blocked');
assert.equal(blocked.differences[0].reason, 'occupied');
assert.equal(writes, 165);
blocks.delete('4,-56,-7');
assert.equal((await executeAssignment(top, { ...world, read: () => null })).status, 'blocked');
assert.equal((await executeAssignment(assignment, {
    ...world, read: () => 'air', async place() { return 'placed'; }
})).verified, 0);

blocks.clear();
const blockedAt = blueprint.blocks[0].pos.join(',');
const attemptedLayers = [];
const layerBlocked = await executeAssignment(assignment, {
    ...world,
    async place(cell) {
        attemptedLayers.push(cell.pos[1]);
        if (cell.pos.join(',') === blockedAt) return 'unreachable';
        return world.place(cell);
    }
});
assert.equal(layerBlocked.status, 'blocked');
assert.deepEqual([...new Set(attemptedLayers)], [-60]);
assert.equal(layerBlocked.differences[0].reason, 'unreachable');
assert(layerBlocked.differences.some(cell => cell.reason === 'waiting_for_lower_layer'));

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

blocks.clear();
const reports = [];
let controller;
controller = createBuildController({
    world: {
        ...world,
        async place(cell) {
            const answer = await world.place(cell);
            if (blocks.size === 1) controller.stop('paused');
            return answer;
        }
    },
    save: async () => {},
    report: (event, data) => { if (event === 'result') reports.push(data); }
});
assert.equal((await controller.start(async () => assignment)).status, 'paused');
assert.equal(blocks.size, 1);
assert.equal((await controller.resume()).status, 'completed');
assert.equal(reports.at(-1).modelRequests, 0);
assert.equal(reports.at(-1).attempts, 164);
// A finished or blocked job must release the controller for a distinct new job.
const previousId = reports.at(-1).runId;
assert.equal((await controller.start(async () => assignment, { usesModel: true })).status, 'completed');
assert.notEqual(reports.at(-1).runId, previousId);
assert.equal(reports.at(-1).modelRequests, 1);
blocks.set('4,-56,-7', 'stone');
assert.equal((await controller.start(async () => top)).status, 'blocked');
blocks.delete('4,-56,-7');
assert.equal((await controller.start(async () => assignment)).status, 'completed');
console.log('Building checks passed: geometry, verification, planner, pause/resume, sequential jobs, renovation feedback.');
