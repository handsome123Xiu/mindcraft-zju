import assert from 'node:assert/strict';
import { createBlockActions } from '../src/building/block-actions.js';
import { compileBlueprint } from '../src/building/blueprint.js';
import { createBuildingTools } from '../src/building/tools.js';

function botFixture(options = {}) {
    const blocks = new Map([['0,0,0', 'stone']]);
    const looked = [];
    let digs = 0;
    let stops = 0;
    const vector = ([x, y, z]) => ({ x, y, z });
    const bot = {
        game: { gameMode: 'creative' },
        entity: { position: vector([0, 0, 3]), eyeHeight: 1.62, yaw: 0, pitch: 0 },
        cursorPosition: [0, 0, 0], heldItem: null,
        blockAt(pos) {
            const position = [pos.x, pos.y, pos.z];
            const name = blocks.get(position.join(',')) ?? (pos.y < 0 ? 'stone' : 'air');
            return { name, position: pos, stateId: name === 'air' ? 0 : 1,
                boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'bedrock',
                shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ facing: 'north' }) };
        },
        blockAtCursor() { return bot.blockAt(vector(bot.cursorPosition)); },
        async lookAt(point) { looked.push(point); bot.entity.yaw = 0.2; bot.entity.pitch = 0.3; },
        canDigBlock: block => block.diggable,
        async unequip() { bot.heldItem = null; },
        async dig(block) { digs++; blocks.set([block.position.x, block.position.y, block.position.z].join(','), 'air'); },
        stopDigging() { stops++; }
    };
    const actions = createBlockActions(bot, { vector, settleMs: 0,
        walkTo: async position => { bot.entity.position = vector(position); return true; }, ...options });
    return { bot, actions, blocks, looked, vector, digs: () => digs, stops: () => stops };
}

// Inspection includes state and neighbors, while looking only changes orientation.
{
    const f = botFixture();
    const info = f.actions.inspectBlock([0, 0, 0]);
    assert.equal(info.block, 'stone');
    assert.equal(info.properties.facing, 'north');
    assert.equal(info.neighbors.length, 6);
    assert.equal(info.neighbors.find(cell => cell.position[1] === -1).block, 'stone');
    assert.equal(f.looked.length, 0);
    const before = { ...f.bot.entity.position };
    assert.deepEqual(await f.actions.lookAt([0, 0, 0]), { yaw: 0.2, pitch: 0.3 });
    assert.deepEqual(f.looked[0], { x: 0.5, y: 0.5, z: 0.5 });
    assert.deepEqual(f.bot.entity.position, before);
    f.bot.blockAt = () => null;
    assert.equal(f.actions.inspectBlock([0, 0, 0]).status, 'unloaded');
}

// A real dig is verified from the world. Idempotent retries never dig air again.
{
    const f = botFixture();
    assert.equal(await f.actions.digBlock([0, 0, 0], 'stone'), 'removed');
    assert.equal(f.digs(), 1);
    assert.equal(await f.actions.digBlock([0, 0, 0], 'stone'), 'already_air');
    assert.equal(f.digs(), 1);
}

// Reauthorize after approach, before the physical dig.
{
    const f = botFixture();
    await assert.rejects(f.actions.digBlock([0, 0, 0], 'stone', undefined, () => { throw new Error('lease revoked'); }), /lease revoked/);
    assert.equal(f.digs(), 0);
    assert.equal(f.blocks.get('0,0,0'), 'stone');
}

// Loaded material, visibility, diggability and the bot's own footing are checked.
{
    const f = botFixture({ walkTo: async () => false });
    assert.equal(await f.actions.digBlock([0, 0, 0], 'glass'), 'target_changed');
    f.bot.blockAtCursor = () => null;
    assert.equal(await f.actions.digBlock([0, 0, 0], 'stone'), 'unreachable');
    assert.equal(f.digs(), 0);
    f.bot.blockAtCursor = () => f.bot.blockAt(f.vector([0, 0, 0]));
    f.blocks.set('0,0,0', 'bedrock');
    assert.equal(await f.actions.digBlock([0, 0, 0], 'bedrock'), 'unbreakable');
    f.blocks.set('0,0,0', 'stone');
    f.bot.entity.position = f.vector([0, 1, 0]);
    assert.equal(await f.actions.digBlock([0, 0, 0], 'stone'), 'standing_on_target');
    assert.equal(f.digs(), 0);
}

// Relocate successfully before removing the bot's own support.
{
    const f = botFixture();
    f.bot.entity.position = f.vector([0, 1, 0]);
    assert.equal(await f.actions.digBlock([0, 0, 0], 'stone'), 'removed');
    assert.notDeepEqual(f.bot.entity.position, f.vector([0, 1, 0]), 'relocate before removing own support');
}

// The block can change during approach or equipment handling: never dig its replacement.
{
    let f;
    f = botFixture({ walkTo: async position => {
        f.bot.entity.position = f.vector(position);
        f.blocks.set('0,0,0', 'glass');
        return true;
    } });
    f.bot.entity.position = f.vector([0, 0, 10]);
    assert.equal(await f.actions.digBlock([0, 0, 0], 'stone'), 'target_changed');
    assert.equal(f.digs(), 0);
    const equipped = botFixture();
    equipped.bot.heldItem = { name: 'diamond_sword' };
    equipped.bot.unequip = async () => { equipped.blocks.set('0,0,0', 'glass'); };
    assert.equal(await equipped.actions.digBlock([0, 0, 0], 'stone'), 'target_changed');
    assert.equal(equipped.digs(), 0);
}

// Digging is cancellable and bounded even if the protocol promise never settles.
{
    const f = botFixture({ digTimeoutMs: 20 });
    f.bot.dig = () => new Promise(() => {});
    assert.equal(await f.actions.digBlock([0, 0, 0], 'stone'), 'dig_timeout');
    assert.equal(f.stops(), 1);
    const abort = new AbortController();
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const cancelled = botFixture();
    cancelled.bot.dig = () => { entered(); return new Promise(() => {}); };
    const running = cancelled.actions.digBlock([0, 0, 0], 'stone', abort.signal);
    await waiting;
    abort.abort(new Error('用户暂停'));
    await assert.rejects(running, /用户暂停/);
    assert.equal(cancelled.stops(), 1);
}

function toolFixture() {
    const blocks = new Map([['0,0,0', 'glass'], ['3,0,0', 'bricks']]);
    let position = [0, 0, 3];
    const world = {
        read: pos => blocks.get(pos.join(',')) ?? (pos[1] < 0 ? 'stone' : 'air'),
        snapshot: () => ({ dimension: 'overworld', position }),
        async prepare() {},
        inspectBlock: pos => ({ status: 'observed', position: pos, block: world.read(pos), properties: {} }),
        async lookAt() { return { yaw: 1, pitch: 0 }; },
        async moveTo(pos) { position = pos.map((n, i) => i === 1 ? n : n + 0.5); return true; },
        async digBlock(pos) { blocks.set(pos.join(','), 'air'); return 'removed'; },
        async place(cell) { blocks.set(cell.pos.join(','), cell.block); return 'placed'; }
    };
    const job = { origin: [0, 0, 0], dimension: 'overworld', placed: {}, removed: {}, placementAttempts: 0,
        assignment: { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes: [
            { kind: 'point', at: [0, 0, 0], block: 'stone' }
        ] }, [0, 0, 0]) } };
    return { blocks, world, job, tools: createBuildingTools({ world, job }) };
}

// Existing worksite blocks may be removed; removal and placement remain separate actions.
{
    const f = toolFixture();
    assert.equal((await f.tools.call('inspect_block', { position: [0, 0, 0] })).block, 'glass');
    assert.equal((await f.tools.call('dig_block', { position: [0, 0, 0], expectedBlock: 'glass' })).status, 'completed');
    assert.equal(f.job.removed['0,0,0'], 'glass');
    assert.equal(f.job.removalCount, 1);
    assert.equal((await f.tools.call('place_block', { position: [0, 0, 0], block: 'stone' })).status, 'completed');
    assert.equal(f.job.removed['0,0,0'], undefined);
    assert.equal(f.tools.inspect().differences.length, 0);
    await f.tools.call('dig_block', { position: [3, 0, 0], expectedBlock: 'bricks' });
    assert.equal(f.tools.inspect().differences.length, 0);
    f.blocks.set('3,0,0', 'bricks');
    assert(f.tools.inspect().differences.some(cell => cell.pos[0] === 3 && cell.block === 'air'));
    await assert.rejects(f.tools.call('dig_block', { position: [257, 0, 0], expectedBlock: 'stone' }), /超出本次工地范围/);
}

// A changed target or a backend's false success must not authorize or confirm removal.
{
    const f = toolFixture();
    let calls = 0;
    f.world.digBlock = async () => { calls++; return 'removed'; };
    assert.equal((await f.tools.call('dig_block', { position: [0, 0, 0], expectedBlock: 'stone' })).reason, 'target_changed');
    assert.equal(calls, 0);
    const result = await f.tools.call('dig_block', { position: [0, 0, 0], expectedBlock: 'glass' });
    assert.equal(result.status, 'blocked');
    assert.equal(f.job.removalCount ?? 0, 0);
    assert.equal(f.job.removed['0,0,0'], undefined);
}

// The actual destination matters more than a pathfinder's return value.
{
    const f = toolFixture();
    assert.equal((await f.tools.call('move_to', { position: [1, 0, 2] })).status, 'moved');
    f.world.moveTo = async () => true;
    assert.equal((await f.tools.call('move_to', { position: [2, 0, 2] })).status, 'unreachable');
    assert.equal((await f.tools.call('look_at', { position: [0, 0, 0] })).status, 'looked');
}

// An unreachable dig result carries a hint to clear covering blocks first,
// and observe_cells samples remain available as design evidence.
{
    const f = toolFixture();
    f.blocks.set('0,0,0', 'glass');
    f.world.digBlock = async () => 'unreachable';
    const blocked = await f.tools.call('dig_block', { position: [0, 0, 0], expectedBlock: 'glass' });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.reason, 'unreachable');
    assert(blocked.hint?.includes('自上而下'));
    f.job.observation = null;
    const sampled = await f.tools.call('observe_cells', { positions: [[0, 0, 0], [1, 0, 0]] });
    assert.equal(sampled.kind, 'cells');
    assert(f.job.observation?.requested >= 1, 'observe_cells must preserve design evidence');
    assert.equal(f.job.observation.cells.length, 1);
}

// A server-side removal that finishes during pause still updates the saved journal.
{
    const f = toolFixture();
    const abort = new AbortController();
    f.job.placed['0,0,0'] = 'glass';
    f.world.digBlock = async pos => {
        f.blocks.set(pos.join(','), 'air');
        abort.abort(new Error('用户暂停'));
        return 'removed';
    };
    await assert.rejects(f.tools.call('dig_block', { position: [0, 0, 0], expectedBlock: 'glass' }, abort.signal), /用户暂停/);
    assert.equal(f.job.removed['0,0,0'], 'glass');
    assert.equal(f.job.placed['0,0,0'], undefined);
}

console.log('Block action checks passed: inspect, look, single placement, actual movement, explicit demolition, stale targets, timeout/cancellation and repair journals.');
