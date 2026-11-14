import pathfinderModule from 'mineflayer-pathfinder';
import vec3 from 'vec3';
import { coordinates } from './blueprint.js';
import { materialNames, assertMaterial, verticalPair } from './materials.js';
import { installCreativeItemAdapter } from '../agent/library/creative_items.js';
import { createBlockActions } from './block-actions.js';
import { createFlightActions } from './flight-actions.js';
import { createWalkingNavigation } from './navigation.js';

const { Vec3 } = vec3;
const { Movements, goals } = pathfinderModule;
const { GoalPlaceBlock, GoalNear, GoalBlock, GoalCompositeAny } = goals;
const BELOW = new Vec3(0, -1, 0);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const isAir = block => block && AIR.has(block.name);

export function createMineflayerWorld(bot, { flightOptions = {}, movementOptions = {}, onNavigation = () => {} } = {}) {
    const materials = materialNames(bot.registry);
    installCreativeItemAdapter(bot);
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.canOpenDoors = false;
    movements.scafoldingBlocks = [];
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.thinkTimeout = 1200;
    bot.pathfinder.searchRadius = 256;
    const flight = createFlightActions(bot, { ...flightOptions, passThroughWalls: true, vector: position => new Vec3(...position) });

    let navigation = null;
    function reportNavigation(info) { navigation = info; onNavigation(info); }
    const move = createWalkingNavigation(bot, { ...movementOptions, canOccupy: flight.canOccupy, report: reportNavigation });
    async function fly(position, signal, landing = false) {
        reportNavigation({ mode: 'flying', status: 'moving', target: position });
        try {
            const reached = await (landing ? flight.landAt(position, signal) : flight.flyTo(position, signal));
            reportNavigation({ mode: 'flying', status: reached ? 'completed' : 'blocked', target: position,
                reason: reached ? null : flight.lastFailure() ?? (landing ? 'landing_unconfirmed' : 'flight_unconfirmed') });
            return reached;
        } catch (error) {
            reportNavigation({ mode: 'flying', status: signal?.aborted ? 'cancelled' : 'blocked',
                target: position, reason: signal?.aborted ? 'cancelled' : 'flight_error' });
            throw error;
        }
    }

    function assertCreative() {
        if (bot.game.gameMode !== 'creative') throw new Error('请先将机器人设为创造模式');
    }

    function read(position) {
        const block = bot.blockAt(new Vec3(...position));
        return isAir(block) ? 'air' : block?.name ?? null;
    }

    function obstructed(target) {
        return [bot.entity, ...Object.values(bot.entities)].some(entity => {
            if (!entity.position || entity.isValid === false ||
                (entity !== bot.entity && !['player', 'mob', 'animal', 'hostile'].includes(entity.type))) return false;
            const { x, y, z } = entity.position;
            const halfWidth = (entity.width || 0.6) / 2;
            return x + halfWidth > target.x && x - halfWidth < target.x + 1 &&
                z + halfWidth > target.z && z - halfWidth < target.z + 1 &&
                y + (entity.height || 1.8) > target.y && y < target.y + 1;
        });
    }

    function nearbyStands(target, goal, airborne = false) {
        const current = bot.entity.position.floored();
        const eyeHeight = bot.entity.eyeHeight || 1.62;
        const candidates = [];
        for (let dx = -4; dx <= 4; dx++) {
            for (let dz = -4; dz <= 4; dz++) {
                if (dx === 0 && dz === 0) continue;
                for (let dy = -3; dy <= 3; dy++) {
                    const stand = target.offset(dx, dy, dz);
                    if (stand.equals(current) || !flight.canOccupy([stand.x + 0.5, stand.y, stand.z + 0.5]) ||
                        (!airborne && bot.blockAt(stand.plus(BELOW))?.boundingBox !== 'block')) continue;
                    const eye = stand.offset(0.5, eyeHeight, 0.5);
                    if (goal.getFaceAndRef(eye)) candidates.push(stand);
                }
            }
        }
        candidates.sort((a, b) => a.distanceTo(current) - b.distanceTo(current));
        return candidates;
    }

    async function findPlacementFace(target, goal, signal) {
        const currentFace = () => obstructed(target) ? null :
            goal.getFaceAndRef(bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0));
        let face = currentFace();
        if (face) return face;
        // A broad pathfinder goal can terminate at a predicted pose that misses the real face.
        // Move to a tested standing cell instead, excluding the failed cell on the next attempt.
        // Prefer flight at height or while already hovering. Every flight checks
        // the body's route; a visible placement face alone cannot authorize it.
        const tryFlight = async () => {
            for (const stand of nearbyStands(target, goal, true).slice(0, 8)) {
                if (!await fly([stand.x, stand.y, stand.z], signal)) continue;
                face = currentFace();
                if (face) return face;
            }
            return null;
        };
        if (flight.isFlying() || target.y > bot.entity.position.y + 3) {
            const airborneFace = await tryFlight();
            if (airborneFace) return airborneFace;
            // Never run the ground pathfinder while hover physics is active.
            if (flight.isFlying()) return null;
        }
        const candidates = nearbyStands(target, goal).slice(0, 20);
        for (let i = 0; i < candidates.length; i += 10) {
            const group = candidates.slice(i, i + 10).map(stand => new GoalBlock(stand.x, stand.y, stand.z));
            await move(new GoalCompositeAny(group), signal);
            face = currentFace();
            if (face) return face;
        }
        return await tryFlight();
    }

    async function equip(material) {
        if (bot.heldItem?.name === material) return;
        let item = bot.inventory.items().find(item => item.name === material);
        if (!item) {
            const type = bot.registry.itemsByName[material]?.id;
            if (type == null) throw new Error('该游戏版本没有材料 ' + material);
            await bot.creative.setInventorySlot(36, { type, count: 64 }, 2000);
            item = bot.inventory.slots[36];
            if (item?.name !== material) throw new Error('创造模式取料未生效');
        }
        await bot.equip(item, 'hand');
    }

    async function moveTo(position, signal) {
        const [x, y, z] = coordinates(position, '移动目标');
        const target = new Vec3(x, y, z);
        if (target.distanceTo(bot.entity.position) > 256) throw new Error('移动目标距离机器人过远');
        const feet = bot.blockAt(target), head = bot.blockAt(target.offset(0, 1, 0)), support = bot.blockAt(target.plus(BELOW));
        if (!feet || !head || !support) throw new Error('移动目标区块未加载，请先靠近');
        if (!isAir(feet)) throw new Error('移动目标脚下已有方块：' + feet.name + '，请先清理或换位');
        if (!isAir(head)) throw new Error('移动目标头顶已有方块：' + head.name + '，请先清理或换位');
        if (support.boundingBox !== 'block') throw new Error('移动目标下方没有实体支撑（' + (support.name ?? 'air') + '），无法站立');
        if (flight.isFlying()) return await fly(position, signal, true);
        if (await move(new GoalBlock(x, y, z), signal) && bot.entity.position.floored().equals(target)) return true;
        signal?.throwIfAborted();
        if (bot.game.gameMode !== 'creative') return false;
        return await fly(position, signal, true);
    }

    return {
        read,
        supportedMaterials: () => materials,
        materialInfo(name) {
            return { name, displayName: bot.registry.blocksByName[name]?.displayName,
                placement: verticalPair(name) ? 'two_vertical_cells' : name.endsWith('_bed') ? 'two_horizontal_cells' : 'default_game_state',
                stateFields: bot.registry.blocksByName[name]?.states?.map(state => state.name) ?? [],
                exactStateSelection: false };
        },
        attachmentFailure({ pos, block }) {
            const target = new Vec3(...pos);
            return new GoalPlaceBlock(target, bot.world, { range: 4.25 }).facesPos.length ? null : 'missing_reference';
        },
        moveTo,
        flyTo: (position, signal) => fly(position, signal),
        landAt: (position, signal) => fly(position, signal, true),
        setWorksite: flight.setWorksite,
        ...createBlockActions(bot, { vector: position => new Vec3(...position), walkTo: moveTo,
            flyTo: (position, signal) => fly(position, signal), canOccupy: flight.canOccupy, isFlying: flight.isFlying }),
        snapshot() {
            const position = entity => entity?.position ? ['x', 'y', 'z'].map(key =>
                Math.round(entity.position[key] * 100) / 100) : null;
            return {
                name: bot.username, dimension: bot.game.dimension, gameMode: bot.game.gameMode,
                position: position(bot.entity), flying: flight.isFlying(), navigation, minY: bot.game.minY, height: bot.game.height,
                players: Object.entries(bot.players).slice(0, 32).map(([name, player]) => ({ name, position: position(player.entity) })),
                entities: Object.values(bot.entities).filter(entity => entity.isValid !== false &&
                    ['player', 'mob', 'animal', 'hostile'].includes(entity.type)).slice(0, 32)
                    .map(entity => ({ name: entity.username ?? entity.name ?? entity.type, position: position(entity) }))
            };
        },
        async prepare(dimension, region, signal) {
            assertCreative();
            if (bot.game.dimension !== dimension) throw new Error('当前维度与蓝图维度不一致');
            if (region.min[1] < bot.game.minY || region.max[1] >= bot.game.minY + bot.game.height) {
                throw new Error('施工高度超出世界范围');
            }
            const center = region.min.map((n, i) => Math.floor((n + region.max[i]) / 2));
            if (bot.entity.position.distanceTo(new Vec3(...center)) > 256) {
                throw new Error('施工区域过远，请先让机器人靠近工地');
            }
            const [x, y, z] = region.min;
            if (!bot.blockAt(new Vec3(x, y, z))) await move(new GoalNear(x, y, z, 4), signal);
        },
        async place({ pos, block: material, expectedAt }, signal) {
            signal?.throwIfAborted();
            assertCreative();
            assertMaterial(material, materials);
            const target = new Vec3(...pos);
            const current = read(pos);
            if (current === material) return 'already_present';
            if (current !== 'air') return current == null ? 'unloaded' : 'occupied';
            let extra, bedDirection;
            if (verticalPair(material)) extra = pos.map((n, i) => n + (i === 1 ? 1 : 0));
            if (material.endsWith('_bed')) {
                bedDirection = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]].find(offset => {
                    const other = pos.map((n, i) => n + offset[i]);
                    return expectedAt?.(other) === material && read(other) === 'air' &&
                        bot.blockAt(new Vec3(...other).plus(BELOW))?.boundingBox === 'block';
                });
                if (!bedDirection) return 'multiblock_blueprint_required';
                extra = pos.map((n, i) => n + bedDirection[i]);
            }
            if (extra && (expectedAt?.(extra) !== material || read(extra) !== 'air')) return 'multiblock_blueprint_required';
            const floorPlacement = !!extra || ['torch', 'soul_torch', 'redstone_torch'].includes(material);
            const goal = new GoalPlaceBlock(target, bot.world, { range: 4.25, ...(floorPlacement ? { faces: [BELOW] } : {}) });
            if (!goal.facesPos.length) return 'missing_reference';
            const initialFace = await findPlacementFace(target, goal, signal);
            if (!initialFace) return obstructed(target) ? 'entity_in_way' : 'unreachable';
            await equip(material);
            signal?.throwIfAborted();
            if (read(pos) !== 'air') return 'changed_during_placement';
            if (obstructed(target)) return 'entity_in_way';
            const face = goal.getFaceAndRef(bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0));
            if (!face) return 'unreachable';
            const reference = bot.blockAt(face.ref);
            if (!reference || reference.boundingBox !== 'block') return 'missing_reference';
            if (extra && (read(extra) !== 'air' || expectedAt?.(extra) !== material)) return 'changed_during_placement';
            if (extra && obstructed(new Vec3(...extra))) return 'entity_in_way';
            const wasSneaking = bot.controlState?.sneak ?? false;
            try {
                bot.setControlState?.('sneak', true);
                if (bedDirection) {
                    if (!bot._placeBlockWithOptions) return 'placement_state_unavailable';
                    await bot.look(Math.atan2(-bedDirection[0], -bedDirection[2]), 0, true);
                    signal?.throwIfAborted();
                    await bot._placeBlockWithOptions(reference, face.face.scaled(-1), { forceLook: 'ignore', swingArm: 'right' });
                } else await bot.placeBlock(reference, face.face.scaled(-1));
            } catch {
                signal?.throwIfAborted();
                return 'placement_rejected';
            } finally {
                bot.setControlState?.('sneak', wasSneaking);
            }
            return 'placement_unconfirmed';
        }
    };
}
