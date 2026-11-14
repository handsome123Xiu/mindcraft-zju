import { bounds, coordinates } from './blueprint.js';

export function scopedParts(parts, partIds, scope) {
    const keys = scope?.positions && new Set(scope.positions.map(pos => pos.join(',')));
    return parts.filter(part => partIds.includes(part.id)).map(part => ({ ...part,
        cells: keys ? part.cells.filter(cell => keys.has(cell.pos.join(','))) : part.cells
    })).filter(part => part.cells.length);
}

// Persist exact world cells, not a mutable selector. A module keeps its identity
// while independent tasks can own different subsets of it.
export function normalizeScope(parts, partIds, scope) {
    const selected = parts.filter(part => partIds.includes(part.id));
    if (!partIds.length || selected.length !== partIds.length) throw new Error('任务包含未知部件');
    if (scope == null) return null;
    if (!!scope.region === !!scope.positions) throw new Error('scope 必须且只能指定 region 或 positions');
    const cells = selected.flatMap(part => part.cells);
    const known = new Map(cells.map(cell => [cell.pos.join(','), cell.pos]));
    let positions;
    if (scope.region) {
        const region = bounds(scope.region);
        positions = cells.filter(cell => cell.pos.every((n, i) => n >= region.min[i] && n <= region.max[i])).map(cell => cell.pos);
    } else {
        if (!Array.isArray(scope.positions) || scope.positions.length > 2000000) throw new Error('施工坐标列表无效');
        positions = scope.positions.map(pos => coordinates(pos, '施工范围坐标'));
        if (positions.some(pos => !known.has(pos.join(',')))) throw new Error('施工范围超出指定部件');
    }
    positions = [...new Map(positions.map(pos => [pos.join(','), pos])).values()].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
    const keys = new Set(positions.map(pos => pos.join(',')));
    if (!positions.length) throw new Error('施工范围为空：请用清单 relativeBounds 或 inspect_blueprint 核对区域及 coordinateSpace');
    const pairedPlants = new Set(['tall_grass', 'large_fern', 'sunflower', 'lilac', 'rose_bush', 'peony', 'small_dripleaf']);
    const all = new Map(parts.flatMap(part => part.cells.map(cell => [cell.pos.join(','), cell])));
    for (const key of keys) {
        const cell = all.get(key);
        const offsets = cell.block.endsWith('_bed') ? [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]] :
            cell.block.endsWith('_door') || pairedPlants.has(cell.block) ? [[0,1,0],[0,-1,0]] : [];
        for (const offset of offsets) {
            const neighbor = cell.pos.map((n, i) => n + offset[i]).join(',');
            if (all.get(neighbor)?.block === cell.block && !keys.has(neighbor)) throw new Error('施工范围不能拆开床、门或双格植物，请把相连方块一并分配');
        }
    }
    return { positions };
}

export function taskScope(task, full = false) {
    return full ? task.scope : task.workScope ?? task.scope;
}

export function scopeSummary(scope) {
    if (!scope) return { kind: 'whole-module' };
    const positions = scope.positions;
    if (!positions.length) return { kind: 'cells', count: 0 };
    const min = [...positions[0]], max = [...positions[0]];
    for (const pos of positions) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], pos[i]); max[i] = Math.max(max[i], pos[i]); }
    return { kind: 'cells', count: positions.length, bounds: { min, max } };
}
