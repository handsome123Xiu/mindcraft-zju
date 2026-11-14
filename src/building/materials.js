import minecraftData from 'minecraft-data';
import settings from '../../settings.js';

// 重力/易碎方块不再禁止：只要注册表里有对应物品就可以选择。
// 风险由材料说明提示，失败后 agent 自行分析处理，而不是程序拦截。
export const GRAVITY_MATERIALS = new Set([
    'sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel',
    'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'scaffolding', 'pointed_dripstone',
    ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
        'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(color => color + '_concrete_powder')
]);

export function materialNames(registry) {
    // Block-state aliases with no inventory item are not independent placeable
    // materials (e.g. air, flowing water, wall_torch). No full-cube whitelist.
    return Object.keys(registry.blocksByName).filter(name => registry.itemsByName[name]).sort();
}

const defaultRegistry = minecraftData(settings.minecraft_version) ?? minecraftData('1.21.6');
export const MATERIALS = Object.freeze(materialNames(defaultRegistry));
export const KNOWN_MATERIALS = Object.freeze(materialNames(defaultRegistry));
export const COMMON_MATERIALS = Object.freeze(['stone', 'stone_bricks', 'quartz_block', 'white_concrete',
    'pink_concrete', 'red_concrete', 'white_wool', 'red_terracotta', 'glass', 'oak_planks',
    'oak_log', 'oak_stairs', 'oak_slab', 'oak_door', 'torch', 'lantern', 'sea_lantern',
    'gold_block', 'iron_block', 'brick_slab', 'bricks', 'copper_block', 'moss_block', 'cherry_planks']);

// 唯一的硬性要求：物品存在于当前注册表。其余特性只作提示。
export function assertMaterial(name, available = MATERIALS) {
    if (typeof name !== 'string' || !available.includes(name)) throw new Error('当前版本没有可用的方块物品：' + name + '；可用 list_materials 查询准确名称');
}

// 特殊放置方式的提示（不是限制）：失败时 agent 按此自分析、换等价方块。
export function placementNotes(name) {
    const notes = [];
    if (GRAVITY_MATERIALS.has(name)) notes.push('受重力影响：悬空会下坠，需要下方支撑或改用非重力等价方块');
    if (name === 'cake') notes.push('特殊放置方块：直接放置常被游戏拒绝，失败时改用等价方块（如 white_concrete 主体 + colored_terracotta 装饰）');
    if (name.endsWith('_bed')) notes.push('需要预留水平相邻两格');
    if (verticalPair(name)) notes.push('需要预留上下相邻两格');
    return notes;
}

export function materialSummary(names) {
    return { count: names.length,
        policy: 'All registry blocks with an obtainable block item. Gravity/falling and special-placement blocks (cake, doors, beds) are allowed but carry placement notes; on failure analyze the note and substitute an equivalent block yourself before reporting upward.',
        commonExamples: COMMON_MATERIALS.filter(name => names.includes(name)),
        lookup: 'list_materials',
        statePlacement: 'Default game placement state; exact facing/half/axis is not currently selectable. Doors/tall plants need two planned vertical cells; beds need two planned horizontal cells. Special blocks like cake may be rejected by the game via the adapter; switch to an equivalent block when that happens.' };
}

export function verticalPair(name) {
    return name.endsWith('_door') || ['sunflower', 'lilac', 'rose_bush', 'peony', 'tall_grass', 'large_fern', 'pitcher_plant'].includes(name);
}
