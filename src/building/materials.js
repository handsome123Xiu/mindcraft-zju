import minecraftData from 'minecraft-data';
import settings from '../../settings.js';

export const GRAVITY_MATERIALS = new Set([
    'sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel',
    'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'scaffolding', 'pointed_dripstone',
    ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
        'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(color => color + '_concrete_powder')
]);

export function materialNames(registry, { includeGravity = false } = {}) {
    // Block-state aliases with no inventory item are not independent placeable
    // materials (e.g. air, flowing water, wall_torch). No full-cube whitelist.
    return Object.keys(registry.blocksByName).filter(name => registry.itemsByName[name] &&
        (includeGravity || !GRAVITY_MATERIALS.has(name))).sort();
}

const defaultRegistry = minecraftData(settings.minecraft_version) ?? minecraftData('1.21.6');
export const MATERIALS = Object.freeze(materialNames(defaultRegistry));
export const KNOWN_MATERIALS = Object.freeze(materialNames(defaultRegistry, { includeGravity: true }));
export const COMMON_MATERIALS = Object.freeze(['stone', 'stone_bricks', 'quartz_block', 'white_concrete',
    'pink_concrete', 'red_concrete', 'white_wool', 'red_terracotta', 'glass', 'oak_planks',
    'oak_log', 'oak_stairs', 'oak_slab', 'oak_door', 'torch', 'lantern', 'sea_lantern',
    'gold_block', 'iron_block', 'brick_slab', 'bricks', 'copper_block', 'moss_block', 'cherry_planks']);

export function assertMaterial(name, available = MATERIALS) {
    if (GRAVITY_MATERIALS.has(name)) throw Object.assign(new Error('已禁用会下坠的重力材料：' + name + '；请改用不会下坠的方块'), { code: 'GRAVITY_MATERIAL_DISABLED' });
    if (typeof name !== 'string' || !available.includes(name)) throw new Error('当前版本没有可用的方块物品：' + name + '；可用 list_materials 查询准确名称');
}

export function materialSummary(names) {
    return { count: names.length, policy: 'All registry blocks with an obtainable block item, excluding gravity/falling blocks.',
        commonExamples: COMMON_MATERIALS.filter(name => names.includes(name)),
        disabledGravity: [...GRAVITY_MATERIALS], lookup: 'list_materials',
        statePlacement: 'Default game placement state; exact facing/half/axis is not currently selectable. Doors/tall plants need two planned vertical cells; beds need two planned horizontal cells.' };
}

export function verticalPair(name) {
    return name.endsWith('_door') || ['sunflower', 'lilac', 'rose_bush', 'peony', 'tall_grass', 'large_fern', 'pitcher_plant'].includes(name);
}
