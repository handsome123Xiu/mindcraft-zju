import { coordinates, prepareAssignment } from './blueprint.js';
import { inspectCells } from './inspection.js';
import { scopedParts, taskScope } from './task-scope.js';

export function taskChecklistParts(job, full = false) {
    const parts = checklistParts(job);
    return job.teamTask ? scopedParts(parts, job.teamTask.partIds, taskScope(job.teamTask, full)) : parts;
}

export function checklistParts(job) {
    const { targets, expected } = prepareAssignment(job.assignment);
    const byKey = new Map(targets.map(cell => [cell.pos.join(','), cell]));
    const source = job.assignment.blueprint.parts;
    let parts;
    if (source !== undefined) {
        if (!Array.isArray(source) || !source.length || source.length > 512) throw new Error('蓝图部件清单无效');
        const ids = new Set(), covered = new Set();
        parts = source.map(part => {
            if (!part || !/^part-[1-9]\d*$/.test(part.id) || ids.has(part.id) || typeof part.title !== 'string' ||
                !part.title.trim() || part.title.length > 100 || !Array.isArray(part.positions) || !part.positions.length) throw new Error('蓝图部件 ID、名称或坐标无效');
            ids.add(part.id);
            const cells = part.positions.map(position => {
                const key = coordinates(position, '部件坐标').join(',');
                if (!byKey.has(key) || covered.has(key)) throw new Error('部件清单包含重复或不属于蓝图的坐标 ' + key);
                covered.add(key);
                return byKey.get(key);
            });
            return { id: part.id, title: part.title, cells };
        });
        if (covered.size !== targets.length) throw new Error('部件清单遗漏蓝图目标方块');
    } else {
        // Old saved tasks acquire a complete checklist without changing geometry.
        const layers = new Map();
        for (const cell of targets) {
            if (!layers.has(cell.pos[1])) layers.set(cell.pos[1], []);
            layers.get(cell.pos[1]).push(cell);
        }
        parts = [...layers].sort(([a], [b]) => a - b).map(([y, cells], i) => ({
            id: 'part-' + (i + 1), title: '世界 Y=' + y + ' 层', cells
        }));
    }
    const air = expected.filter(cell => cell.block === 'air');
    const keys = new Set(expected.map(cell => cell.pos.join(',')));
    for (const key of Object.keys(job.removed ?? {})) if (!keys.has(key)) air.push({ pos: key.split(',').map(Number), block: 'air' });
    if (air.length) parts.push({ id: 'clearance', title: '开口、内部空位及已清理区域', cells: air });
    return parts;
}

function describePart(part, world, origin) {
    const inspection = inspectCells(part.cells, world);
    const reasons = {};
    for (const cell of inspection.differences) reasons[cell.reason] = (reasons[cell.reason] ?? 0) + 1;
    const verified = part.cells.length - inspection.differences.length;
    const min = part.cells[0].pos.map((_, i) => Math.min(...part.cells.map(cell => cell.pos[i])) - origin[i]);
    const max = part.cells[0].pos.map((_, i) => Math.max(...part.cells.map(cell => cell.pos[i])) - origin[i]);
    return { id: part.id, title: part.title, status: !inspection.differences.length ? 'verified' :
        reasons.occupied || reasons.unloaded ? 'blocked' : verified ? 'partial' : 'pending',
        total: part.cells.length, verified, remaining: inspection.differences.length, reasons,
        relativeBounds: { min, max }, missingSample: inspection.differences.slice(0, 2).map(cell => ({
            relative: cell.pos.map((n, i) => n - origin[i]), block: cell.block, actual: cell.actual
        })) };
}

export function refreshChecklist(job, world) {
    if (!job.assignment) { job.checklist = null; return null; }
    const parts = taskChecklistParts(job);
    const origin = job.design?.origin ?? job.origin;
    const summaries = parts.map(part => describePart(part, world, origin));
    job.checklist = { assignmentVersion: job.assignmentVersion, origin,
        verifiedParts: summaries.filter(part => part.status === 'verified').length, totalParts: summaries.length,
        remainingCells: summaries.reduce((n, part) => n + part.remaining, 0),
        nextPartId: summaries.find(part => part.status !== 'verified')?.id ?? null, parts: summaries };
    return job.checklist;
}

// Suggestions contain only missing cells in ONE selected part, after all design
// replacement/opening operations. They are never executed by this function.
// Extra/wrong-material blocks become dig suggestions with the
// actually observed material as expectedBlock.
export function suggestPartActions(part, world, origin, assignmentVersion, limit = 8) {
    const pending = new Map(part.cells.filter(cell => cell.block !== 'air' && world.read(cell.pos) === 'air')
        .sort((a, b) => a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0] || a.pos[2] - b.pos[2])
        .map(cell => [cell.pos.join(','), cell.block]));
    const extra = new Map(part.cells.filter(cell => world.read(cell.pos) != null &&
        world.read(cell.pos) !== 'air' && world.read(cell.pos) !== cell.block)
        .sort((a, b) => b.pos[1] - a.pos[1] || a.pos[0] - b.pos[0] || a.pos[2] - b.pos[2])
        .map(cell => [cell.pos.join(','), world.read(cell.pos)]));
    const actions = [];
    // Extra (occupied) cells become dig suggestions, top-down first so covering
    // blocks are removed before partially hidden ones become reachable.
    while (extra.size && actions.length < limit) {
        const [key, block] = extra.entries().next().value;
        const [x, y, z] = key.split(',').map(Number);
        let width = 1;
        while (extra.get([x + width, y, z].join(',')) === block) width++;
        for (let dx = 0; dx < width; dx++) extra.delete([x + dx, y, z].join(','));
        const args = { expectedBlock: block, coordinateSpace: 'blueprint', partId: part.id, assignmentVersion };
        const name = width === 1 ? 'dig_block' : 'dig_row';
        Object.assign(args, name === 'dig_block' ? { position: [x, y, z].map((n, i) => n - origin[i]) }
            : { start: [x, y, z].map((n, i) => n - origin[i]), end: [x + width - 1, y, z].map((n, i) => n - origin[i]) });
        actions.push({ action: 'tool', name, args });
    }
    while (pending.size && actions.length < limit) {
        const [key, block] = pending.entries().next().value;
        const [x, y, z] = key.split(',').map(Number);
        let width = 1, depth = 1;
        while (width < 256 && pending.get([x + width, y, z].join(',')) === block) width++;
        while (depth < 256 && width * (depth + 1) <= 32768 && Array.from({ length: width }, (_, dx) => dx)
            .every(dx => pending.get([x + dx, y, z + depth].join(',')) === block)) depth++;
        for (let dx = 0; dx < width; dx++) for (let dz = 0; dz < depth; dz++) pending.delete([x + dx, y, z + dz].join(','));
        const min = [x, y, z].map((n, i) => n - origin[i]);
        const max = [x + width - 1, y, z + depth - 1].map((n, i) => n - origin[i]);
        const args = { block, coordinateSpace: 'blueprint', partId: part.id, assignmentVersion };
        const name = width * depth === 1 ? 'place_block' : width === 1 || depth === 1 ? 'place_row' : 'place_rectangle';
        Object.assign(args, name === 'place_block' ? { position: min } : name === 'place_row' ? { start: min, end: max } : { min, max });
        actions.push({ action: 'tool', name, args });
    }
    return { actions, moreMissingCells: pending.size + extra.size,
        note: '缺失格子给出 place，多余或材料错误的占位给出 dig（expectedBlock 为现场材料，自上而下）。dig 后重新 inspect_part 确认空气再放置；未知区块先观察。建议不是拆除授权，执行仍受任务范围、租约及站位核验。逐项调用对应函数，不要调用 batch。' };
}

export function inspectPart(job, world, partId, { offset = 0, limit = 32, fullTask = false } = {}) {
    const part = taskChecklistParts(job, fullTask).find(entry => entry.id === partId);
    if (!part) throw new Error('未知部件 ' + partId + '；请先 get_build_checklist 查看当前版本的部件 ID');
    const origin = job.design?.origin ?? job.origin;
    const result = inspectCells(part.cells, world);
    return { ...describePart(part, world, origin), assignmentVersion: job.assignmentVersion,
        differences: result.differences.slice(offset, offset + limit), differenceCount: result.differences.length,
        nextOffset: offset + limit < result.differences.length ? offset + limit : null,
        suggestions: suggestPartActions(part, world, origin, job.assignmentVersion) };
}
