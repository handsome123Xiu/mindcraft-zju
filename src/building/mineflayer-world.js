import pathfinderModule from 'mineflayer-pathfinder';
import vec3 from 'vec3';
import { setTimeout as delay } from 'node:timers/promises';
import { GRAVITY_MATERIALS } from './blueprint.js';
import { installCreativeItemAdapter } from '../agent/library/creative_items.js';

const { Vec3 } = vec3;
const { Movements, goals } = pathfinderModule;
const { GoalPlaceBlock, GoalNear, GoalBlock, GoalCompositeAny } = goals;
const BELOW = new Vec3(0, -1, 0);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const isAir = block => block && AIR.has(block.name);

export function createMineflayerWorld(bot) {
    installCreativeItemAdapter(bot);
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.canOpenDoors = false;
    movements.scafoldingBlocks = [];
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.thinkTimeout = 1200;
    bot.pathfinder.searchRadius = 40;

    function stop() {
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
    }

    async function move(goal, signal) {
        signal?.throwIfAborted();
        const timeout = setTimeout(stop, 8000);
        signal?.addEventListener('abort', stop, { once: true });
        try {
            await bot.pathfinder.goto(goal);
            signal?.throwIfAborted();
            return true;
        } catch {
            signal?.throwIfAborted();
            return false;
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', stop);
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

    function nearbyStands(target, goal) {
        const current = bot.entity.position.floored();
        const eyeHeight = bot.entity.eyeHeight || 1.62;
        const candidates = [];
        for (let dx = -4; dx <= 4; dx++) {
            for (let dz = -4; dz <= 4; dz++) {
                if (dx === 0 && dz === 0) continue;
                for (let dy = -3; dy <= 3; dy++) {
                    const stand = target.offset(dx, dy, dz);
                    if (stand.equals(current) || !isAir(bot.blockAt(stand)) ||
                        !isAir(bot.blockAt(stand.offset(0, 1, 0))) ||
                        bot.blockAt(stand.plus(BELOW))?.boundingBox !== 'block') continue;
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
        const candidates = nearbyStands(target, goal).slice(0, 20);
        for (let i = 0; i < candidates.length; i += 10) {
            const group = candidates.slice(i, i + 10).map(stand => new GoalBlock(stand.x, stand.y, stand.z));
            await move(new GoalCompositeAny(group), signal);
            face = currentFace();
            if (face) return face;
        }
        return null;
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

    return {
        read,
        async prepare(dimension, region, signal) {
            assertCreative();
            if (bot.game.dimension !== dimension) throw new Error('当前维度与蓝图维度不一致');
            if (region.min[1] < bot.game.minY || region.max[1] >= bot.game.minY + bot.game.height) {
                throw new Error('施工高度超出世界范围');
            }
            const center = region.min.map((n, i) => Math.floor((n + region.max[i]) / 2));
            if (bot.entity.position.distanceTo(new Vec3(...center)) > 48) {
                throw new Error('施工区域过远，请先让机器人靠近工地');
            }
            const [x, y, z] = region.min;
            if (!bot.blockAt(new Vec3(x, y, z))) await move(new GoalNear(x, y, z, 4), signal);
        },
        async place({ pos, block: material }, signal) {
            signal?.throwIfAborted();
            assertCreative();
            const target = new Vec3(...pos);
            const current = read(pos);
            if (current === material) return 'already_present';
            if (current !== 'air') return current == null ? 'unloaded' : 'occupied';
            const gravity = GRAVITY_MATERIALS.has(material);
            if (gravity && bot.blockAt(target.plus(BELOW))?.boundingBox !== 'block') return 'missing_support';
            // Sand needs support underneath, but may be placed against any adjacent face.
            const goal = new GoalPlaceBlock(target, bot.world, { range: 4.25 });
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
            try {
                await bot.placeBlock(reference, face.face.scaled(-1));
                if (gravity) await delay(200, undefined, { signal });
            } catch {
                signal?.throwIfAborted();
                return 'placement_rejected';
            }
            return 'placement_unconfirmed';
        }
    };
}
