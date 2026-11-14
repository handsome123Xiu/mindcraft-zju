import { prepareAssignment } from './blueprint.js';

// Partition metadata only: every vertical column stays with one worker, and
// geometry/materials remain identical to the coordinator's approved design.
export function partitionBuilding(assignment, count, axis = 'auto') {
    if (!Number.isInteger(count) || count < 2 || count > 8) throw new Error('并行施工需要 2–8 名施工成员');
    if (!['auto', 'x', 'z'].includes(axis)) throw new Error('分区方向必须为 auto/x/z');
    const { targets } = prepareAssignment(assignment);
    const candidates = (axis === 'auto' ? [0, 2] : [axis === 'x' ? 0 : 2]).flatMap(index => {
        const values = [...new Set(targets.map(cell => cell.pos[index]))].sort((a, b) => a - b);
        if (values.length < count) return [];
        const weights = values.map(value => targets.filter(cell => cell.pos[index] === value).length);
        const ends = [];
        let start = 0, remaining = targets.length;
        for (let zone = 0; zone < count - 1; zone++) {
            const ideal = remaining / (count - zone);
            let end = start, weight = weights[start];
            while (end + 1 < values.length - (count - zone - 1) &&
                Math.abs(weight + weights[end + 1] - ideal) < Math.abs(weight - ideal)) weight += weights[++end];
            ends.push(values[end]); start = end + 1; remaining -= weight;
        }
        const groups = Array.from({ length: count }, () => []);
        const owners = new Map();
        for (const cell of targets) {
            const found = ends.findIndex(end => cell.pos[index] <= end);
            const zone = found < 0 ? count - 1 : found;
            groups[zone].push(cell); owners.set(cell.pos.join(','), zone);
        }
        // A bed is placed as a pair. Never split neighboring bed cells, even
        // when their default facing cannot be determined from the blueprint.
        for (const [zone, cells] of groups.entries()) for (const cell of cells) if (cell.block.endsWith('_bed')) {
            for (const offset of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
                const neighbor = owners.get(cell.pos.map((n, i) => n + offset[i]).join(','));
                if (neighbor != null && neighbor !== zone) return [];
            }
        }
        return [{ index, groups, score: Math.max(...groups.map(cells => cells.length)) }];
    }).sort((a, b) => a.score - b.score);
    if (!candidates.length) throw new Error('无法切成独立施工区：建筑过窄或切分会拆开连体方块，请手动规划依赖');
    const { index, groups } = candidates[0];
    const result = structuredClone(assignment);
    result.blueprint.parts = groups.map((cells, i) => ({ id: 'part-' + (i + 1),
        title: `并行施工区 ${i + 1}（${index === 0 ? 'X' : 'Z'}=${Math.min(...cells.map(c => c.pos[index]))}..${Math.max(...cells.map(c => c.pos[index]))}，自下而上）`,
        positions: cells.map(cell => cell.pos) }));
    return result;
}

export function verifyParallelSite(assignment, world) {
    const { targets, expected } = prepareAssignment(assignment);
    if (expected.some(cell => cell.block === 'air' && world.read(cell.pos) !== 'air')) {
        throw new Error('先完成 clearance 清理并加载场地，再 prepare_parallel_build；最终空位仍由 lead 全局验收');
    }
    const targetMap = new Map(targets.map(cell => [cell.pos.join(','), cell]));
    for (const part of assignment.blueprint.parts) {
        const pending = new Set(part.positions.map(pos => pos.join(',')));
        while (pending.size) {
            const queue = [pending.values().next().value];
            pending.delete(queue[0]);
            let supported = false;
            for (let i = 0; i < queue.length; i++) {
                const cell = targetMap.get(queue[i]);
                const actual = world.read(cell.pos);
                if (actual == null || (actual !== 'air' && actual !== cell.block)) throw new Error('施工区有未加载或需替换的方块，请先处理：' + queue[i]);
                if (actual === cell.block) supported = true;
                const below = [cell.pos[0], cell.pos[1] - 1, cell.pos[2]];
                if (!targetMap.has(below.join(','))) {
                    const support = world.inspectBlock?.(below);
                    if (support?.boundingBox === 'block' || (!support && ['stone', 'dirt', 'grass_block', 'bedrock'].includes(world.read(below)))) supported = true;
                }
                for (const offset of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
                    const key = cell.pos.map((n, j) => n + offset[j]).join(',');
                    if (pending.delete(key)) queue.push(key);
                }
            }
            if (!supported) throw new Error(part.title + ' 有悬空区域，无法确认独立支撑；请调整蓝图或手动设置真实依赖');
        }
    }
}
