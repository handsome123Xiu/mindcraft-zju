const MAX_SPAN = 32;
const MAX_VOLUME = 12000;

export const MATERIALS = Object.freeze([
    'stone', 'cobblestone', 'smooth_stone', 'stone_bricks', 'bricks',
    'sandstone', 'smooth_sandstone', 'red_sandstone', 'smooth_red_sandstone',
    'sand', 'red_sand', 'gravel', 'glass', 'quartz_block',
    ...['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove'].map(name => name + '_planks'),
    ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
        'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(name => name + '_concrete')
]);
export const GRAVITY_MATERIALS = new Set(['sand', 'red_sand', 'gravel']);

export function coordinates(value, label) {
    if (!Array.isArray(value) || value.length !== 3 ||
        !value.every(n => Number.isSafeInteger(n) && Math.abs(n) < 30000000)) {
        throw new Error(label + ' 必须是三个整数坐标');
    }
    return [...value];
}

function bounds(value, label) {
    const min = coordinates(value?.min, label + '.min');
    const max = coordinates(value?.max, label + '.max');
    const sizes = max.map((n, i) => n - min[i] + 1);
    if (sizes.some(n => n < 1 || n > MAX_SPAN) || sizes.reduce((a, b) => a * b, 1) > MAX_VOLUME) {
        throw new Error(label + ' 超出范围（每轴最多 32 格，总体积最多 12000 格）');
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

export function compileBlueprint(spec, origin) {
    const base = coordinates(origin, 'origin');
    if (!Array.isArray(spec?.shapes) || spec.shapes.length < 1 || spec.shapes.length > 64) {
        throw new Error('蓝图需要 1–64 个 shapes');
    }
    const local = new Map();
    const openings = [];
    let expanded = 0;
    function write(pos, material) {
        if (++expanded > MAX_VOLUME * 2 || pos.some(n => Math.abs(n) >= MAX_SPAN) || pos[1] < 0) {
            throw new Error('蓝图超出几何预算或位于施工基准面下方');
        }
        const key = pos.join(',');
        const old = local.get(key);
        if (old && old.block !== material) throw new Error('蓝图材料冲突：' + key);
        local.set(key, { pos, block: material });
    }
    for (const shape of spec.shapes) {
        const kind = shape?.kind;
        if (kind === 'opening') {
            openings.push(bounds(shape, 'opening'));
            continue;
        }
        if (!MATERIALS.includes(shape?.block)) throw new Error('蓝图包含不支持的材料');
        if (kind === 'point') {
            write(coordinates(shape.at, 'point.at'), shape.block);
        } else if (kind === 'box' || kind === 'shell') {
            const region = bounds(shape, kind);
            for (const pos of cells(region)) {
                if (kind === 'box' || pos.some((n, i) => n === region.min[i] || n === region.max[i])) {
                    write(pos, shape.block);
                }
            }
        } else {
            throw new Error('不支持的蓝图形状');
        }
    }
    for (const region of openings) {
        for (const pos of cells(region)) {
            if (++expanded > MAX_VOLUME * 2) throw new Error('开口超出几何预算');
            local.delete(pos.join(','));
        }
    }
    const blocks = [...local.values()].map(({ pos, block }) => ({ pos: pos.map((n, i) => n + base[i]), block }));
    if (!blocks.length) throw new Error('蓝图没有待建方块');
    const min = [...blocks[0].pos];
    const max = [...min];
    for (const { pos } of blocks) {
        pos.forEach((n, i) => {
            min[i] = Math.min(min[i], n);
            max[i] = Math.max(max[i], n);
        });
    }
    return { version: 1, bounds: bounds({ min, max }, 'blueprint.bounds'), blocks };
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
        if (!includes(whole, pos) || !MATERIALS.includes(block.block) || blockByPosition.has(pos.join(','))) {
            throw new Error('蓝图包含越界、不支持或重复的方块');
        }
        blockByPosition.set(pos.join(','), block.block);
    }
    const expected = [...cells(region)].map(pos => ({ pos, block: blockByPosition.get(pos.join(',')) ?? 'air' }));
    return { region, expected, targets: expected.filter(cell => cell.block !== 'air') };
}
