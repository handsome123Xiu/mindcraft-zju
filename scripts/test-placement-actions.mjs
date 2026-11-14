import assert from 'node:assert/strict';
import { compileBlueprint } from '../src/building/blueprint.js';
import { compilePlacement, executePlacement } from '../src/building/placement-actions.js';
import { createBuildingTools, TOOL_CATALOG } from '../src/building/tools.js';

function fixture(overrides = {}) {
    const blocks = new Map();
    const placed = [];
    const world = {
        read: pos => blocks.get(pos.join(',')) ?? (pos[1] < 0 ? 'stone' : 'air'),
        snapshot: () => ({ dimension: 'overworld', position: [0, 0, 4], gameMode: 'creative' }),
        async prepare() {},
        async place(cell) {
            placed.push([...cell.pos]);
            blocks.set(cell.pos.join(','), cell.block);
            return 'placed';
        },
        ...overrides
    };
    const run = (name, args, options = {}) => executePlacement(compilePlacement(name, args), world,
        { dimension: 'overworld', ...options });
    return { world, blocks, placed, run };
}

// Inclusive reversed rows, exact coordinates, idempotent retries and vertical support.
{
    const f = fixture();
    const args = { start: [4, 0, 0], end: [1, 0, 0], block: 'stone' };
    const result = await f.run('place_row', args);
    assert.equal(result.status, 'completed');
    assert.equal(result.verified, 4);
    assert.deepEqual(f.placed, [[4, 0, 0], [3, 0, 0], [2, 0, 0], [1, 0, 0]]);
    assert.equal((await f.run('place_row', args)).attempts, 0);
    assert.equal(f.placed.length, 4);
    const vertical = fixture();
    vertical.world.place = async cell => {
        assert.notEqual(vertical.world.read([cell.pos[0], cell.pos[1] - 1, cell.pos[2]]), 'air');
        vertical.placed.push(cell.pos);
        vertical.blocks.set(cell.pos.join(','), cell.block);
        return 'placed';
    };
    await vertical.run('place_row', { start: [0, 3, 0], end: [0, 0, 0], block: 'stone' });
    assert.deepEqual(vertical.placed.map(pos => pos[1]), [0, 1, 2, 3]);
}

// Every plane is filled, including interior cells, without introducing thickness.
for (const [min, max, fixedAxis] of [
    [[0, 0, 0], [2, 0, 2], 1], [[0, 0, 0], [2, 2, 0], 2], [[0, 0, 0], [0, 2, 2], 0]
]) {
    const f = fixture();
    const result = await f.run('place_rectangle', { min, max, block: 'glass' });
    assert.equal(result.status, 'completed');
    assert.equal(f.blocks.size, 9);
    assert(f.placed.every(pos => pos[fixedAxis] === 0));
    assert.equal(f.world.read(min.map((n, i) => i === fixedAxis ? n : n + 1)), 'glass');
}

// A cube is a solid equal-sided volume, built from lower attachment points.
{
    const f = fixture();
    f.world.place = async cell => {
        assert.notEqual(f.world.read([cell.pos[0], cell.pos[1] - 1, cell.pos[2]]), 'air');
        f.placed.push(cell.pos);
        f.blocks.set(cell.pos.join(','), cell.block);
        return 'placed';
    };
    const result = await f.run('place_cube', { origin: [0, 0, 0], size: 3, block: 'stone' });
    assert.equal(result.verified, 27);
    assert.equal(f.blocks.get('1,1,1'), 'stone');
    assert(f.placed.every((pos, index) => !index || pos[1] >= f.placed[index - 1][1]));
}

// Geometry is rejected before placement rather than silently becoming another shape.
for (const [name, args] of [
    ['place_row', { start: [0, 0, 0], end: [1, 0, 1], block: 'stone' }],
    ['place_row', { start: [0, 0, 0], end: [256, 0, 0], block: 'stone' }],
    ['place_rectangle', { min: [0, 0, 0], max: [1, 1, 1], block: 'stone' }],
    ['place_rectangle', { min: [0, 0, 0], max: [255, 0, 255], block: 'stone' }],
    ['place_cube', { origin: [0, 0, 0], size: 33, block: 'stone' }],
    ['place_cube', { origin: [0, 0, 0], size: 0, block: 'stone' }],
    ['place_cube', { origin: [0.5, 0, 0], size: 1, block: 'stone' }],
    ['place_cube', { origin: [0, 0, 0], size: 1, block: 'no_such_block_ever' }]
]) assert.throws(() => compilePlacement(name, args));

// Occupancy and unloaded cells abort the entire primitive before the first write.
for (const actual of ['glass', null]) {
    let writes = 0;
    const f = fixture({ read: pos => pos[0] === 2 ? actual : 'air',
        async place() { writes++; return 'placed'; } });
    const result = await f.run('place_row', { start: [0, 0, 0], end: [2, 0, 0], block: 'stone' });
    assert.equal(result.status, 'blocked');
    assert.equal(writes, 0);
}

// A failed block is tried once; later cells wait for the agent's next decision.
{
    const f = fixture();
    f.world.place = async cell => {
        f.placed.push(cell.pos);
        if (cell.pos[0] === 1) return 'unreachable';
        f.blocks.set(cell.pos.join(','), cell.block);
        return 'placed';
    };
    const args = { start: [0, 0, 0], end: [2, 0, 0], block: 'stone' };
    const result = await f.run('place_row', args);
    assert.equal(result.attempts, 2);
    assert.equal(result.verified, 1);
    assert.deepEqual(result.differences.map(cell => cell.reason), ['unreachable', 'not_attempted']);
    assert.deepEqual(f.placed, [[0, 0, 0], [1, 0, 0]]);
    f.world.place = async cell => { f.blocks.set(cell.pos.join(','), cell.block); return 'placed'; };
    assert.equal((await f.run('place_row', args)).attempts, 2);
    assert.equal(f.blocks.size, 3);
}

// Returning success without a real world update cannot verify the action.
{
    const f = fixture({ async place() { return 'placed'; } });
    const result = await f.run('place_cube', { origin: [0, 0, 0], size: 1, block: 'stone' });
    assert.equal(result.status, 'blocked');
    assert.equal(result.verified, 0);
    assert.equal(result.differences[0].reason, 'placement_unconfirmed');
}

// User cancellation interrupts a primitive, leaving already placed cells intact.
{
    const abort = new AbortController();
    const f = fixture();
    f.world.place = async cell => {
        f.blocks.set(cell.pos.join(','), cell.block);
        abort.abort(new Error('用户暂停'));
        return 'placed';
    };
    await assert.rejects(f.run('place_cube', { origin: [0, 0, 0], size: 2, block: 'stone' },
        { signal: abort.signal }), /用户暂停/);
    assert.equal(f.blocks.size, 1);
}

// The agent explicitly composes all three actions. Each is constrained to its own
// coordinates and the intended blueprint, including preserved openings/materials.
{
    const f = fixture();
    const blueprint = compileBlueprint({ shapes: [
        { kind: 'box', min: [0, 0, 0], max: [2, 0, 2], block: 'stone' },
        { kind: 'box', min: [0, 0, 3], max: [2, 0, 3], block: 'stone' },
        { kind: 'box', min: [0, 1, 0], max: [1, 2, 1], block: 'glass' }
    ] }, [0, 0, 0]);
    const job = { origin: [0, 0, 0], dimension: 'overworld', assignment: { version: 1, dimension: 'overworld', blueprint },
        placed: {}, placementAttempts: 0 };
    const tools = createBuildingTools({ world: f.world, job });
    await tools.call('place_rectangle', { min: [0, 0, 0], max: [2, 0, 2], block: 'stone' });
    assert.equal(f.blocks.size, 9);
    assert.equal(tools.inspect().verified, 9);
    assert.equal(tools.inspect().total, 20);
    await tools.call('place_row', { start: [0, 0, 3], end: [2, 0, 3], block: 'stone' });
    await tools.call('place_cube', { origin: [0, 1, 0], size: 2, block: 'glass' });
    assert.equal(f.blocks.size, 20);
    assert.equal(tools.inspect().differences.length, 0);
    const before = f.blocks.size;
    await assert.rejects(tools.call('place_rectangle', { min: [0, 1, 0], max: [2, 1, 2], block: 'glass' }), /动作必须符合当前蓝图/);
    await assert.rejects(tools.call('place_row', { start: [0, 1, 0], end: [1, 1, 0], block: 'stone' }), /动作必须符合当前蓝图/);
    await assert.rejects(tools.call('place_cube', { origin: [10, 0, 0], size: 1, block: 'stone' }), /动作必须符合当前蓝图/);
    await assert.rejects(tools.call('build_blueprint', {}), /未知 tool/);
    assert.equal(f.blocks.size, before);
    assert.equal(job.placementAttempts, 20);
    assert.equal(Object.keys(job.placed).length, 20);
}

assert.deepEqual(TOOL_CATALOG.filter(item => item.name.startsWith('place_')).map(item => item.name),
    ['place_block', 'place_row', 'place_rectangle', 'place_cube']);
assert(!TOOL_CATALOG.some(item => item.name === 'build_blueprint'));
console.log('Placement action checks passed: rows, planar rectangles, solid cubes, bounds, stop-on-failure, retries, pause and blueprint constraints.');
