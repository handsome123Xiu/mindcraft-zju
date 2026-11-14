import { bounds, coordinates } from './blueprint.js';
import { compilePlacement } from './placement-actions.js';
import { inspectCells } from './inspection.js';

export const DEMOLITION_ACTIONS = Object.freeze(['dig_block', 'dig_row', 'dig_rectangle', 'dig_cube']);

export function compileDemolition(name, args) {
    if (!DEMOLITION_ACTIONS.includes(name)) throw new Error('未知拆除动作');
    if (typeof args.expectedBlock !== 'string' || !/^[a-z0-9_]+$/.test(args.expectedBlock) ||
        ['air', 'cave_air', 'void_air'].includes(args.expectedBlock)) throw new Error('expectedBlock 必须是观察到的非空气方块名称');
    const primitive = compilePlacement(name.replace('dig_', 'place_'), { ...args, block: 'stone' });
    return { ...primitive, name, cells: primitive.cells.map(cell => ({ pos: cell.pos, block: args.expectedBlock }))
        .sort((a, b) => b.pos[1] - a.pos[1]) };
}

export function validateDemolitionTarget(target, origin) {
    if (!target || target.version !== 1 || !target.targets || typeof target.targets !== 'object' || Array.isArray(target.targets) ||
        !Object.keys(target.targets).length || Object.keys(target.targets).length > 2000000) throw new Error('拆除目标清单无效');
    for (const [key, block] of Object.entries(target.targets)) {
        const pos = coordinates(key.split(',').map(Number), '拆除目标');
        if (key !== pos.join(',') || Math.hypot(...pos.map((n, i) => n - origin[i])) > 256 || !/^[a-z0-9_]+$/.test(block)) throw new Error('拆除目标超出工地或材料无效');
    }
    return target;
}

export function extendDemolitionTarget(previous, args, world, nearSite) {
    const region = bounds(args.region);
    nearSite(region.min);
    nearSite(region.max);
    const targets = { ...previous?.targets };
    let selected = 0;
    for (let x = region.min[0]; x <= region.max[0]; x++) {
        for (let y = region.min[1]; y <= region.max[1]; y++) {
            for (let z = region.min[2]; z <= region.max[2]; z++) {
                const pos = [x, y, z];
                const block = world.read(pos);
                if (block == null) throw new Error('拆除范围包含未加载坐标 ' + pos.join(',') + '，请先靠近并观察');
                if (args.blocks && !args.blocks.includes(block)) continue;
                targets[pos.join(',')] ??= block;
                selected++;
            }
        }
    }
    if (!selected) throw new Error('指定范围没有匹配目标；请观察或调整 blocks 筛选');
    if (Object.keys(targets).length > 2000000) throw new Error('累计拆除目标最多 2000000 格');
    return { version: 1, targets };
}

export function inspectDemolition(target, world) {
    const expected = Object.keys(target.targets).map(key => ({ pos: key.split(',').map(Number), block: 'air' }));
    const result = inspectCells(expected, world);
    return { ...result, total: expected.length, verified: expected.length - result.differences.length,
        outcome: 'demolition', status: result.differences.length ? 'blocked' : 'completed' };
}
