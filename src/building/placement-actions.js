import { bounds, coordinates } from './blueprint.js';
import { assertMaterial } from './materials.js';
import { inspectCells } from './inspection.js';

export const MAX_ACTION_BLOCKS = 32768;
export const PLACEMENT_ACTIONS = Object.freeze(['place_block', 'place_row', 'place_rectangle', 'place_cube']);
const OFFSETS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export function attachmentFailure(cell, world) {
    if (typeof world.attachmentFailure === 'function') return world.attachmentFailure(cell);
    const solid = pos => { const name = world.read(pos); return name != null && !['air', 'water', 'lava'].includes(name); };
    return OFFSETS.some(offset => solid(cell.pos.map((n, i) => n + offset[i]))) ? null : 'missing_reference';
}

// Compile exactly one explicit primitive, with no blueprint lookup or decomposition.
export function compilePlacement(name, args) {
    if (!PLACEMENT_ACTIONS.includes(name)) throw new Error('未知放置动作：' + name);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('放置参数必须为对象');
    assertMaterial(args.block);
    let region;
    let positions;
    if (name === 'place_block') {
        const position = coordinates(args.position, 'position');
        region = bounds({ min: position, max: position });
        positions = [position];
    } else if (name === 'place_row') {
        const start = coordinates(args.start, 'start');
        const end = coordinates(args.end, 'end');
        const delta = end.map((n, i) => n - start[i]);
        if (delta.filter(n => n !== 0).length > 1) throw new Error('一排方块必须沿 X、Y 或 Z 轴');
        region = bounds({ min: start.map((n, i) => Math.min(n, end[i])),
            max: start.map((n, i) => Math.max(n, end[i])) });
        const length = Math.max(...delta.map(Math.abs)) + 1;
        positions = Array.from({ length }, (_, index) => start.map((n, i) => n + index * Math.sign(delta[i])));
    } else {
        if (name === 'place_rectangle') {
            region = bounds(args);
            if (region.min.every((n, i) => n !== region.max[i])) {
                const size = region.max.map((n, i) => n - region.min[i] + 1);
                throw Object.assign(new Error('矩形必须位于 XY、XZ 或 YZ 平面，不能有三维厚度；当前为 ' + size.join('×') +
                    ' 长方体。蓝图 box 不是 place_rectangle：请固定一个轴后分层放置，或调用 inspect_part 获取合法动作建议'),
                { code: 'PRIMITIVE_GEOMETRY', field: 'args.min/args.max', expected: 'At least one min[i] === max[i]; cube requires equal edge lengths.' });
            }
        } else {
            const origin = coordinates(args.origin, 'origin');
            if (!Number.isInteger(args.size) || args.size < 1 || args.size > 32) throw new Error('立方体边长 size 必须为 1–32');
            region = bounds({ min: origin, max: origin.map(n => n + args.size - 1) });
        }
        const volume = region.max.reduce((total, n, i) => total * (n - region.min[i] + 1), 1);
        if (volume > MAX_ACTION_BLOCKS) throw new Error('单次动作最多 ' + MAX_ACTION_BLOCKS + ' 格，请由 Agent 拆成更小动作');
        positions = [];
        for (let y = region.min[1]; y <= region.max[1]; y++) {
            for (let x = region.min[0]; x <= region.max[0]; x++) {
                const reverse = (x - region.min[0]) % 2 !== 0;
                for (let z = region.min[2]; z <= region.max[2]; z++) {
                    positions.push([x, y, reverse ? region.max[2] - (z - region.min[2]) : z]);
                }
            }
        }
    }
    // Prefer lower attachment points; gravity materials are prohibited.
    positions.sort((a, b) => a[1] - b[1]);
    return { name, region, cells: positions.map(pos => ({ pos, block: args.block })) };
}

// Execute only the supplied primitive. Stop at the first unsuccessful placement;
// observation, retry, repair and selecting the next primitive belong to the agent.
export async function executePlacement(primitive, world, { dimension, signal, onProgress } = {}) {
    signal?.throwIfAborted();
    for (const cell of primitive.cells) assertMaterial(cell.block);
    await world.prepare(dimension, primitive.region, signal);
    signal?.throwIfAborted();
    let attempts = 0;
    const initial = inspectCells(primitive.cells, world);
    const describe = result => ({ action: primitive.name, region: primitive.region, ...result,
        status: result.differences.length ? 'blocked' : 'completed' });
    if (initial.differences.some(cell => cell.reason !== 'missing')) return describe(initial);
    let failed;
    const pending = primitive.cells.filter(cell => world.read(cell.pos) !== cell.block);
    while (pending.length) {
        signal?.throwIfAborted();
        // Pick an attachable cell inside THIS primitive only. This permits an
        // overhang to grow outward from its supported middle, without scaffolds.
        const index = pending.findIndex(cell => world.read(cell.pos) === cell.block || !attachmentFailure(cell, world));
        if (index < 0) {
            failed = { pos: pending[0].pos, reason: attachmentFailure(pending[0], world) };
            break;
        }
        const [cell] = pending.splice(index, 1);
        if (world.read(cell.pos) === cell.block) continue;
        attempts++;
        let reason;
        try { reason = await world.place(cell, signal); }
        catch (error) {
            signal?.throwIfAborted();
            reason = 'placement_error';
            failed = { pos: cell.pos, reason, detail: error.message };
        }
        signal?.throwIfAborted();
        if (attempts % 25 === 0) onProgress?.({ attempts, total: primitive.cells.length });
        if (world.read(cell.pos) !== cell.block) {
            failed ??= { pos: cell.pos, reason: ['placed', 'already_present', null, undefined].includes(reason) ? 'placement_unconfirmed' : reason };
            break;
        }
        failed = null;
    }
    const result = inspectCells(primitive.cells, world, attempts);
    for (const cell of result.differences) {
        if (cell.reason !== 'missing') continue;
        if (failed && cell.pos.every((n, i) => n === failed.pos[i])) {
            cell.reason = failed.reason;
            if (failed.detail) cell.detail = failed.detail;
        } else if (failed) cell.reason = 'not_attempted';
    }
    return describe(result);
}
