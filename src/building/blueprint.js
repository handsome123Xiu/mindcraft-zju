import { MATERIALS, KNOWN_MATERIALS, assertMaterial } from './materials.js';
export { MATERIALS, GRAVITY_MATERIALS } from './materials.js';
const MAX_SPAN = 256;
const MAX_VOLUME = 2000000;

export function coordinates(value, label) {
    if (!Array.isArray(value) || value.length !== 3 ||
        !value.every(n => Number.isSafeInteger(n) && Math.abs(n) < 30000000)) {
        throw new Error(label + ' 必须是三个整数坐标');
    }
    return [...value];
}

export function bounds(value, label = 'region') {
    const min = coordinates(value?.min, label + '.min');
    const max = coordinates(value?.max, label + '.max');
    const sizes = max.map((n, i) => n - min[i] + 1);
    if (sizes.some(n => n < 1 || n > MAX_SPAN) || sizes.reduce((a, b) => a * b, 1) > MAX_VOLUME) {
        throw new Error(label + ' 超出范围（每轴最多 256 格，总体积最多 2000000 格）');
    }
    return { min, max };
}

function* cells({ min, max }) {
    for (let y = min[1]; y <= max[1]; y++) {
        for (let x = min[0]; x <= max[0]; x++) {
            const reverse = (x - min[0]) % 2 !== 0;
            for (let z = min[2]; z <= max[2]; z++) {
                yield [x, y, reverse ? max[2] - (z - min[2]) : z];
            }
        }
    }
}

export function compileBlueprint(spec, origin, availableMaterials = MATERIALS) {
    const base = coordinates(origin, 'origin');
    if (!Array.isArray(spec?.shapes) || spec.shapes.length < 1 || spec.shapes.length > 512) {
        throw new Error('蓝图需要 1–512 个 shapes');
    }
    const local = new Map();
    // Air is intentional only inside authored shapes/openings. Empty space
    // between disconnected buildings is not an implicit demolition target.
    const domain = new Map();
    const openings = [];
    const parts = new Map();
    let currentPart;
    let expanded = 0;
    function shapeError(index, field, message) {
        return Object.assign(new Error(message), { field: 'shapes[' + index + '].' + field });
    }
    function validateOffset(pos, index, field) {
        if (pos[1] < 0) throw shapeError(index, field, '蓝图相对坐标 [' + pos + '] 位于施工基准面下方；y=0 对应世界 Y=' + base[1] + '，施工必须在基准面及其上方');
        if (pos.some(n => Math.abs(n) >= MAX_SPAN)) throw shapeError(index, field, '蓝图相对坐标 [' + pos + '] 超出 -255..255');
    }
    function write(pos, material, index, replaceFrom) {
        if (++expanded > MAX_VOLUME * 2) throw new Error('蓝图超出几何预算');
        const key = pos.join(',');
        domain.set(key, pos);
        const old = local.get(key);
        if (replaceFrom && old?.block !== replaceFrom) throw shapeError(index, 'from', '蓝图 replace 的 from 不匹配：' + key +
            '，预期 ' + replaceFrom + '，实际 ' + (old?.block ?? 'air'));
        if (old && old.block !== material && !replaceFrom) throw shapeError(index, 'block', '蓝图材料冲突：' + key +
            ' 同时为 ' + old.block + ' 和 ' + material + '。请划分不重叠区域，或用 kind=replace、from=' + old.block + ' 显式替换设计材料');
        local.set(key, { pos, block: material, part: currentPart });
    }
    for (const [index, shape] of spec.shapes.entries()) {
        const kind = shape?.kind;
        const fields = { point: ['kind', 'at', 'block'], box: ['kind', 'min', 'max', 'block'],
            shell: ['kind', 'min', 'max', 'block'], frame: ['kind', 'min', 'max', 'block'],
            replace: ['kind', 'min', 'max', 'from', 'block'], opening: ['kind', 'min', 'max'] };
        if (Object.hasOwn(fields, kind)) {
            const unsupported = Object.keys(shape).filter(key => key !== 'part' && !fields[kind].includes(key));
            if (unsupported.length) throw shapeError(index, unsupported[0], '蓝图形状未知字段 ' + unsupported.join(',') + '；当前不支持方块朝向、状态、隐式 hollow 或其他扩展字段');
        }
        if (kind === 'opening') {
            const region = bounds(shape, kind);
            validateOffset(region.min, index, 'min');
            validateOffset(region.max, index, 'max');
            openings.push(region);
            continue;
        }
        assertMaterial(shape?.block, availableMaterials);
        if (shape.part != null && (typeof shape.part !== 'string' || !shape.part.trim() || shape.part.length > 80)) throw new Error('part 必须为 1–80 字的部件名称');
        const title = shape.part?.trim() ?? `形状 ${index + 1} (${kind})`;
        if (!parts.has(title)) parts.set(title, { id: 'part-' + (parts.size + 1), title });
        currentPart = parts.get(title).id;
        if (kind === 'point') {
            const pos = coordinates(shape.at, 'point.at');
            validateOffset(pos, index, 'at');
            write(pos, shape.block, index);
        } else if (['box', 'shell', 'frame', 'replace'].includes(kind)) {
            const region = bounds(shape, kind);
            validateOffset(region.min, index, 'min');
            validateOffset(region.max, index, 'max');
            const axes = region.min.map((n, i) => n === region.max[i] ? -1 : i).filter(i => i !== -1);
            if (kind === 'shell' && axes.length !== 3) throw new Error('shell 表示含底和顶的三维外壳，各轴至少 2 格；平面边框请用 frame，实心平面请用 box');
            if (kind === 'frame' && axes.length !== 2) throw new Error('frame 必须是有两个非零跨度的平面边框');
            if (kind === 'replace') assertMaterial(shape.from, availableMaterials);
            for (const pos of cells(region)) {
                domain.set(pos.join(','), pos);
                if (domain.size > MAX_VOLUME) throw new Error('蓝图超出几何预算');
                if (kind === 'box' || kind === 'replace' ||
                    (kind === 'frame' ? axes : [0, 1, 2]).some(i => pos[i] === region.min[i] || pos[i] === region.max[i])) {
                    write(pos, shape.block, index, kind === 'replace' ? shape.from : undefined);
                }
            }
        } else {
            throw new Error('不支持的蓝图形状');
        }
    }
    for (const region of openings) {
        for (const pos of cells(region)) {
            if (++expanded > MAX_VOLUME * 2) throw new Error('开口超出几何预算');
            domain.set(pos.join(','), pos);
            local.delete(pos.join(','));
        }
    }
    const blocks = [...local.values()].map(({ pos, block }) => ({ pos: pos.map((n, i) => n + base[i]), block }));
    if (!blocks.length) throw new Error('蓝图没有待建方块');
    const min = [...blocks[0].pos];
    const max = [...min];
    const clearance = [...domain].filter(([key]) => !local.has(key)).map(([, pos]) => pos.map((n, i) => n + base[i]));
    for (const pos of [...blocks.map(cell => cell.pos), ...clearance]) {
        pos.forEach((n, i) => {
            min[i] = Math.min(min[i], n);
            max[i] = Math.max(max[i], n);
        });
    }
    const grouped = [...parts.values()].map(part => ({ ...part, positions: [...local.values()]
        .filter(cell => cell.part === part.id).map(cell => cell.pos.map((n, i) => n + base[i])) })).filter(part => part.positions.length);
    return { version: 1, bounds: bounds({ min, max }, 'blueprint.bounds'), blocks, clearance, parts: grouped };
}

// An assignment is plain JSON. All coordinates below are absolute world coordinates.
export function prepareAssignment(assignment) {
    const blueprint = assignment?.blueprint;
    if (assignment?.version !== 1 || blueprint?.version !== 1 ||
        typeof assignment.dimension !== 'string' || !assignment.dimension ||
        !Array.isArray(blueprint.blocks) || !blueprint.blocks.length || blueprint.blocks.length > MAX_VOLUME) {
        throw new Error('无效的施工任务版本、维度或蓝图');
    }
    const whole = bounds(blueprint.bounds, 'blueprint.bounds');
    const region = assignment.region == null ? whole : bounds(assignment.region, 'assignment.region');
    const includes = (box, pos) => pos.every((n, i) => n >= box.min[i] && n <= box.max[i]);
    if (!includes(whole, region.min) || !includes(whole, region.max)) throw new Error('分工超出蓝图范围');
    const blockByPosition = new Map();
    for (const block of blueprint.blocks) {
        const pos = coordinates(block?.pos, 'block.pos');
        if (!includes(whole, pos) || !KNOWN_MATERIALS.includes(block.block) || blockByPosition.has(pos.join(','))) {
            throw new Error('蓝图包含越界、不支持或重复的方块');
        }
        blockByPosition.set(pos.join(','), block.block);
    }
    let expected;
    if (blueprint.clearance !== undefined) {
        if (!Array.isArray(blueprint.clearance) || blueprint.clearance.length > MAX_VOLUME) throw new Error('无效的蓝图空位');
        const airKeys = new Set();
        for (const value of blueprint.clearance) {
            const pos = coordinates(value, 'clearance');
            const key = pos.join(',');
            if (!includes(whole, pos) || blockByPosition.has(key) || airKeys.has(key)) throw new Error('蓝图空位越界、重复或与实体冲突');
            airKeys.add(key);
        }
        expected = [...blueprint.blocks.map(cell => ({ pos: [...cell.pos], block: cell.block })),
            ...blueprint.clearance.map(pos => ({ pos: [...pos], block: 'air' }))].filter(cell => includes(region, cell.pos));
    } else {
        // Saved assignments keep their original verification contract.
        expected = [...cells(region)].map(pos => ({ pos, block: blockByPosition.get(pos.join(',')) ?? 'air' }));
    }
    return { region, expected, targets: expected.filter(cell => cell.block !== 'air') };
}
