import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vec3 from 'vec3';
import minecraftData from 'minecraft-data';
import { createFlightActions } from '../src/building/flight-actions.js';
import { createMineflayerWorld } from '../src/building/mineflayer-world.js';
import { createBuildingTools } from '../src/building/tools.js';
import { compileBlueprint } from '../src/building/blueprint.js';

const { Vec3 } = vec3;
const vector = position => new Vec3(...position);
const registry = minecraftData('1.21.6');

function fixture(options = {}) {
    const blocks = new Map();
    const positions = [];
    const packets = [];
    const bot = new EventEmitter();
    Object.assign(bot, {
        username: 'andy', registry, players: {}, entities: {}, physicsEnabled: true,
        game: { gameMode: 'creative', dimension: 'overworld', minY: -64, height: 384 },
        entity: { position: vector([0.5, 0, 0.5]), velocity: vector([0, 0, 0]), height: 1.8, width: 0.6, eyeHeight: 1.62 },
        physics: { gravity: 0.08 },
        pathfinder: { setGoal() {}, setMovements() {}, async goto() { throw new Error('ground path unavailable'); } },
        clearControlStates() {},
        _client: { write: (name, data) => packets.push({ name, ...data }) },
        creative: { startFlying() { bot.physics.gravity = 0; }, stopFlying() { bot.physics.gravity = 0.08; } },
        heldItem: { name: 'stone' },
        inventory: { items: () => [] },
        blockAt(point) {
            const cell = point.floored();
            const key = [cell.x, cell.y, cell.z].join(',');
            const name = blocks.has(key) ? blocks.get(key) : (cell.y < 0 ? 'stone' : 'air');
            if (name === null) return null;
            return { name, position: cell, stateId: registry.blocksByName[name].minStateId,
                boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
        },
        async placeBlock(reference, face) {
            const target = reference.position.plus(face);
            const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
            assert(eye.distanceTo(reference.position.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5))) <= 4.25);
            blocks.set([target.x, target.y, target.z].join(','), 'stone');
        }
    });
    bot.world = {
        getBlock: point => bot.blockAt(point),
        raycast(origin, direction, range) {
            let previous = origin.floored();
            for (let t = 0; t <= range; t += 0.01) {
                const point = origin.plus(direction.scaled(t));
                const cell = point.floored();
                const block = bot.blockAt(cell);
                if (block && block.name !== 'air') {
                    const face = cell.y > previous.y ? 0 : cell.y < previous.y ? 1 :
                        cell.z > previous.z ? 2 : cell.z < previous.z ? 3 : cell.x > previous.x ? 4 : 5;
                    return { ...block, face };
                }
                previous = cell;
            }
            return null;
        }
    };
    const wait = async () => { positions.push(bot.entity.position.clone()); await options.onStep?.(bot, blocks); };
    const flight = createFlightActions(bot, { vector, wait, ...options });
    flight.setWorksite({ origin: [0, 0, 0], dimension: 'overworld' });
    return { bot, blocks, positions, packets, flight, wait };
}

// Flight reaches unsupported heights, remains hovering, and only a supported landing restores physics.
{
    const f = fixture();
    assert.equal(await f.flight.flyTo([0, 12, 0]), true);
    assert(f.flight.isFlying());
    assert.equal(f.bot.physicsEnabled, false);
    assert.equal(f.bot.physics.gravity, 0);
    assert(f.positions.every((p, i) => p.distanceTo(i ? f.positions[i - 1] : vector([0.5, 0, 0.5])) <= 0.251));
    await assert.rejects(f.flight.landAt([2, 5, 0]), /完整实体支撑/);
    assert(f.flight.isFlying());
    assert.equal(await f.flight.landAt([2, 0, 0]), true);
    assert.equal(f.flight.isFlying(), false);
    assert.equal(f.bot.physicsEnabled, true);
    assert.equal(f.bot.physics.gravity, 0.08);
    assert.deepEqual(f.packets.map(p => p.flags), [2, 0]);
}

// A low wall is flown over. An enclosure with no clear route cannot be crossed.
{
    const f = fixture();
    for (let z = -3; z <= 3; z++) for (let y = 0; y < 3; y++) f.blocks.set(`1,${y},${z}`, 'stone');
    assert.equal(await f.flight.flyTo([3, 0, 0]), true);
    assert(Math.max(...f.positions.map(p => p.y)) >= 3);
    assert(f.positions.every(p => f.flight.canOccupy([p.x, p.y, p.z])));
    const enclosed = fixture();
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) enclosed.blocks.set(`${x},2,${z}`, 'stone');
    for (let n = -2; n <= 2; n++) for (let y = 0; y < 2; y++) {
        for (const pos of [[-2, y, n], [2, y, n], [n, y, -2], [n, y, 2]]) enclosed.blocks.set(pos.join(','), 'stone');
    }
    assert.equal(await enclosed.flight.flyTo([3, 0, 0]), false);
    assert.equal(enclosed.positions.length, 0);
}

// A ceiling prevents rising: take a collision-free sideways detour instead.
{
    const f = fixture();
    for (let x = -2; x <= 4; x++) for (let z = -2; z <= 2; z++) f.blocks.set(`${x},2,${z}`, 'stone');
    for (let y = 0; y < 2; y++) for (let z = -1; z <= 1; z++) f.blocks.set(`1,${y},${z}`, 'stone');
    assert.equal(await f.flight.flyTo([3, 0, 0]), true);
    assert(f.positions.some(point => point.z < -1 || point.z >= 2));
    assert(f.positions.every(point => f.flight.canOccupy([point.x, point.y, point.z])));
    assert(f.positions.every(point => point.y === 0));
}

// Real move_to falls back from a stalled pathfinder, flies around the obstacle and lands.
{
    const f = fixture();
    f.bot.pathfinder.goto = () => new Promise(() => {});
    for (let y = 0; y < 3; y++) for (let z = -2; z <= 2; z++) f.blocks.set(`1,${y},${z}`, 'stone');
    const navigation = [];
    const world = createMineflayerWorld(f.bot, { flightOptions: { wait: f.wait },
        movementOptions: { stuckMs: 15, pollMs: 2, timeoutMs: 100 }, onNavigation: info => navigation.push(info) });
    world.setWorksite({ origin: [0, 0, 0], dimension: 'overworld' });
    const before = [...f.blocks];
    assert.equal(await world.moveTo([3, 0, 0]), true);
    assert(f.bot.entity.position.floored().equals(vector([3, 0, 0])));
    assert(navigation.some(info => info.reason === 'walk_stuck'));
    assert.equal(world.snapshot().flying, false);
    assert.equal(world.snapshot().navigation.status, 'completed');
    assert.deepEqual([...f.blocks], before, 'navigation never removes or replaces the obstacle');
}

// False plugin success also triggers recovery; a pause must stop before recovery.
{
    const f = fixture();
    f.bot.pathfinder.goto = async () => {};
    const world = createMineflayerWorld(f.bot, { flightOptions: { wait: f.wait } });
    assert.equal(await world.moveTo([3, 0, 0]), true);
    const abort = new AbortController();
    const cancelled = fixture();
    const stopped = createMineflayerWorld(cancelled.bot, { flightOptions: { wait: cancelled.wait },
        onNavigation(info) { if (info.mode === 'walking') abort.abort(new Error('用户暂停')); } });
    await assert.rejects(stopped.moveTo([3, 0, 0], abort.signal), /用户暂停/);
    assert.equal(cancelled.positions.length, 0);
}

// Creative-only access, unloaded cells, body/head clearance and worksite/world limits.
{
    const f = fixture();
    f.bot.game.gameMode = 'survival';
    await assert.rejects(f.flight.flyTo([0, 5, 0]), /创造模式/);
    f.bot.game.gameMode = 'creative';
    f.blocks.set('0,8,0', null);
    assert.equal(await f.flight.flyTo([0, 8, 0]), false);
    f.blocks.set('0,8,0', 'air');
    f.blocks.set('0,9,0', 'stone');
    assert.equal(await f.flight.flyTo([0, 8, 0]), false);
    await assert.rejects(f.flight.flyTo([0, -320, 0]), /过远/);
    f.bot.game.height = 72;
    assert.equal(await f.flight.flyTo([0, 8, 2]), false);
    f.bot.game.height = 384;
    await assert.rejects(f.flight.flyTo([0, 300, 0]), /过远/);
    f.flight.setWorksite({ origin: [0, -300, 0], dimension: 'overworld' });
    assert.equal(await f.flight.flyTo([0, 10, 0]), false);
}

// Stop as soon as pause, a changed obstacle, a server correction or deadline occurs.
{
    const abort = new AbortController();
    const f = fixture({ onStep() { abort.abort(new Error('用户暂停')); } });
    await assert.rejects(f.flight.flyTo([0, 12, 0], abort.signal), /用户暂停/);
    assert.equal(f.positions.length, 1);
    assert(f.flight.isFlying(), 'pause holds the current position instead of falling');
    const changed = fixture({ onStep(bot, blocks) { blocks.set('0,2,0', 'stone'); } });
    assert.equal(await changed.flight.flyTo([0, 12, 0]), false);
    assert(changed.bot.entity.position.y < 0.3);
    const corrected = fixture({ onStep(bot) { bot.entity.position.set(0.5, 0, 0.5); bot.emit('forcedMove'); } });
    assert.equal(await corrected.flight.flyTo([0, 12, 0]), false);
    assert.equal(corrected.positions.length, 1);
    const expired = fixture({ timeoutMs: 0 });
    assert.equal(await expired.flight.flyTo([0, 12, 0]), false);
    f.bot.game.gameMode = 'survival';
    f.bot.emit('game');
    assert.equal(f.flight.isFlying(), false);
    assert.equal(f.bot.physicsEnabled, true);
}

// Exercise the real Mineflayer world adapter and GoalPlaceBlock against a high
// unsupported placement stance, not merely a mock flight tool returning success.
{
    const f = fixture();
    f.bot.entity.position.set(-3.5, 0, 0.5);
    for (let y = 0; y < 10; y++) f.blocks.set(`0,${y},0`, 'stone');
    const world = createMineflayerWorld(f.bot, { flightOptions: { wait: f.wait } });
    const job = { origin: [0, 0, 0], dimension: 'overworld', placed: {}, removed: {}, placementAttempts: 0,
        observation: { old: true }, assignment: { version: 1, dimension: 'overworld', blueprint: compileBlueprint({
            shapes: [{ kind: 'point', at: [0, 10, 0], block: 'stone' }]
        }, [0, 0, 0]) } };
    const tools = createBuildingTools({ world, job });
    const result = await tools.call('place_block', { position: [0, 10, 0], block: 'stone' });
    assert.equal(result.status, 'completed');
    assert.equal(world.read([0, 10, 0]), 'stone');
    assert.equal(world.snapshot().flying, true);
    assert(f.bot.entity.position.y >= 8);
    assert.equal(job.observation, null);
    assert.equal((await tools.call('fly_to', { position: [-3, 12, 0] })).status, 'flown');
    assert.equal((await tools.call('land_at', { position: [-3, 0, 0] })).status, 'landed');
    assert.equal(world.snapshot().flying, false);
    world.flyTo = async () => true;
    assert.equal((await tools.call('fly_to', { position: [-3, 12, 0] })).status, 'unreachable');
    await assert.rejects(tools.call('fly_to', { position: [0, 300, 0] }), /超出本次工地范围/);
}

// Wall-phasing fallback: with no collision-free route out of an enclosure, the
// adapter phases straight through; the landing cell is still strictly checked.
{
    const f = fixture();
    for (let x = -1; x <= 1; x++) for (let y = 0; y <= 2; y++) for (let z = -1; z <= 1; z++) {
        if (!(x === 0 && y < 2 && z === 0)) f.blocks.set(`${x},${y},${z}`, 'stone');
    }
    assert.equal(await f.flight.flyTo([0, 2, 0]), false);
    const phasing = createFlightActions(f.bot, { vector, wait: f.wait, passThroughWalls: true });
    phasing.setWorksite({ origin: [0, 0, 0], dimension: 'overworld' });
    assert.equal(await phasing.flyTo([0, 4, 4]), true);
    assert(f.bot.entity.position.y >= 3.9);
    // Landing still requires full solid support even in phasing mode.
    await assert.rejects(phasing.landAt([5, 4, 4]), /完整实体支撑/);
}

// Newly admitted multi-cell materials must reserve their extra cell in the
// blueprint. Door/bed side effects are journaled and included in part checks.
{
    const f = fixture();
    f.bot.heldItem = { name: 'oak_door' };
    let writes = 0;
    f.bot.placeBlock = async (reference, face) => {
        writes++;
        const target = reference.position.plus(face);
        f.blocks.set([target.x, target.y, target.z].join(','), 'oak_door');
        f.blocks.set([target.x, target.y + 1, target.z].join(','), 'oak_door');
    };
    const world = createMineflayerWorld(f.bot, { flightOptions: { wait: f.wait } });
    assert.equal(await world.place({ pos: [2, 0, 0], block: 'oak_door' }), 'multiblock_blueprint_required');
    assert.equal(writes, 0);
    await assert.rejects(world.place({ pos: [2, 0, 0], block: 'oak_door', expectedAt: () => 'oak_door',
        authorize(positions) { assert.deepEqual(positions, [[2, 0, 0], [2, 1, 0]]); throw new Error('lease revoked'); } }), /lease revoked/);
    assert.equal(writes, 0, 'revocation blocks physical placement including the extra cell');
    // 重力方块已放开：不再被断言拒绝；仍要求注册表内存在的物品。
    await assert.rejects(world.place({ pos: [2, 0, 0], block: 'no_such_block_ever' }), /没有可用的方块物品/);
    const job = { origin: [0, 0, 0], dimension: 'overworld', placed: {}, removed: {}, placementAttempts: 0,
        assignmentVersion: 1, assignment: { version: 1, dimension: 'overworld', blueprint: compileBlueprint({
            shapes: [{ kind: 'box', part: '门', min: [2, 0, 0], max: [2, 1, 0], block: 'oak_door' }]
        }, [0, 0, 0]) } };
    const tools = createBuildingTools({ world, job });
    assert.equal((await tools.call('place_block', { position: [2, 0, 0], block: 'oak_door' })).status, 'completed');
    assert.equal(writes, 1);
    assert.equal(Object.keys(job.placed).length, 2);
    assert.equal(job.checklist.parts[0].verified, 2);

    const bed = fixture();
    bed.bot.heldItem = { name: 'red_bed' };
    bed.bot.look = async yaw => { bed.bot.entity.yaw = yaw; };
    bed.bot._placeBlockWithOptions = async (reference, face, options) => {
        assert.equal(options.forceLook, 'ignore');
        assert.equal(Math.abs(bed.bot.entity.yaw), Math.PI, 'head is placed toward the reserved south cell');
        const target = reference.position.plus(face);
        bed.blocks.set([target.x, target.y, target.z].join(','), 'red_bed');
        bed.blocks.set([target.x, target.y, target.z + 1].join(','), 'red_bed');
    };
    const bedWorld = createMineflayerWorld(bed.bot, { flightOptions: { wait: bed.wait } });
    const bedJob = { ...job, placed: {}, removed: {}, assignment: { version: 1, dimension: 'overworld', blueprint: compileBlueprint({
        shapes: [{ kind: 'box', part: '床', min: [2, 0, 0], max: [2, 0, 1], block: 'red_bed' }]
    }, [0, 0, 0]) } };
    const bedTools = createBuildingTools({ world: bedWorld, job: bedJob });
    assert.equal((await bedTools.call('place_block', { position: [2, 0, 0], block: 'red_bed' })).status, 'completed');
    assert.equal(Object.keys(bedJob.placed).length, 2);
    assert.equal(bedTools.inspect().verified, 2);
}

// The real digging adapter can reach a high exposed block without a ground
// stance. Actual raycasting and flight collision checks are used before digging.
{
    const prepareDig = f => {
        let lookPoint;
        let digs = 0;
        f.bot.lookAt = async point => { lookPoint = point; };
        f.bot.blockAtCursor = range => {
            const eye = f.bot.entity.position.offset(0, f.bot.entity.eyeHeight, 0);
            return lookPoint ? f.bot.world.raycast(eye, lookPoint.minus(eye).normalize(), range) : null;
        };
        f.bot.canDigBlock = block => block.name !== 'bedrock';
        f.bot.unequip = async () => { f.bot.heldItem = null; };
        f.bot.stopDigging = () => {};
        f.bot.dig = async block => {
            const eye = f.bot.entity.position.offset(0, f.bot.entity.eyeHeight, 0);
            assert(eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 4.5);
            digs++;
            f.blocks.set([block.position.x, block.position.y, block.position.z].join(','), 'air');
        };
        return () => digs;
    };
    const f = fixture();
    f.blocks.set('0,12,0', 'stone');
    const digs = prepareDig(f);
    const world = createMineflayerWorld(f.bot, { flightOptions: { wait: f.wait } });
    world.setWorksite({ origin: [0, 0, 0], dimension: 'overworld' });
    assert(world.supportedMaterials().includes('pink_terracotta'));
    assert(world.supportedMaterials().includes('oak_stairs'));
    assert(world.supportedMaterials().includes('sand'), '重力方块已放开：目录包含 sand');
    assert.equal(await world.digBlock([0, 12, 0], 'stone'), 'removed');
    assert.equal(digs(), 1);
    assert(world.snapshot().flying);
    assert(f.bot.entity.position.y >= 9);
    const abort = new AbortController();
    const stopped = fixture({ onStep() { abort.abort(new Error('用户暂停')); } });
    stopped.blocks.set('0,12,0', 'stone');
    const cancelledDigs = prepareDig(stopped);
    const cancelled = createMineflayerWorld(stopped.bot, { flightOptions: { wait: stopped.wait } });
    cancelled.setWorksite({ origin: [0, 0, 0], dimension: 'overworld' });
    await assert.rejects(cancelled.digBlock([0, 12, 0], 'stone', abort.signal), /用户暂停/);
    assert.equal(cancelledDigs(), 0);
    assert.equal(cancelled.read([0, 12, 0]), 'stone');
}

console.log('Flight checks passed: hover/landing, obstacles, cancellation, corrections, bounds and real high-placement/high-demolition adapters.');
