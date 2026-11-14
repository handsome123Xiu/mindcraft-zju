import { setTimeout as delay } from 'node:timers/promises';
import { coordinates } from './blueprint.js';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const OFFSETS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const add = (position, offset) => position.map((n, i) => n + offset[i]);
const equal = (position, other) => position.every((n, i) => n === other[i]);
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));

// Mineflayer block operations with injectable movement/vector adapters for offline QA.
export function createBlockActions(bot, { vector, walkTo, flyTo, canOccupy, isFlying = () => false, digTimeoutMs = 8000, settleMs = 100 }) {
    const readBlock = position => bot.blockAt(vector(position));
    const isAir = block => block && AIR.has(block.name);
    const body = () => ['x', 'y', 'z'].map(key => bot.entity.position[key]);
    const eye = () => add(body(), [0, bot.entity.eyeHeight || 1.62, 0]);

    async function look(point, signal) {
        signal?.throwIfAborted();
        await bot.lookAt(vector(point), true);
        signal?.throwIfAborted();
    }

    async function seeTarget(position, signal) {
        const center = add(position, [0.5, 0.5, 0.5]);
        for (const offset of OFFSETS) {
            const point = add(center, offset.map(n => n * 0.5));
            if (distance(eye(), point) > 4.5) continue;
            await look(point, signal);
            const visible = bot.blockAtCursor(4.5);
            if (visible?.position && equal(position, ['x', 'y', 'z'].map(key => visible.position[key]))) return true;
        }
        return false;
    }

    function stands(position, airborne = false) {
        const current = body();
        const candidates = [];
        for (let dx = -4; dx <= 4; dx++) {
            for (let dz = -4; dz <= 4; dz++) {
                for (let dy = -3; dy <= 3; dy++) {
                    const candidate = add(position, [dx, dy, dz]);
                    if (equal(current.map(Math.floor), candidate) || equal(add(candidate, [0, -1, 0]), position) || !isAir(readBlock(candidate)) ||
                        !isAir(readBlock(add(candidate, [0, 1, 0]))) ||
                        (canOccupy && !canOccupy(add(candidate, [0.5, 0, 0.5]))) ||
                        (!airborne && readBlock(add(candidate, [0, -1, 0]))?.boundingBox !== 'block')) continue;
                    if (distance(add(candidate, [0.5, bot.entity.eyeHeight || 1.62, 0.5]), add(position, [0.5, 0.5, 0.5])) <= 4.5) {
                        candidates.push(candidate);
                    }
                }
            }
        }
        return candidates.sort((a, b) => distance(a, current) - distance(b, current)).slice(0, 8);
    }

    return {
        inspectBlock(position) {
            const pos = coordinates(position, '观察坐标');
            const block = readBlock(pos);
            if (!block) return { status: 'unloaded', position: pos, block: null };
            return {
                status: 'observed', position: pos, block: block.name, stateId: block.stateId,
                properties: block.getProperties?.() ?? {}, boundingBox: block.boundingBox,
                shapes: block.shapes ?? [], diggable: block.diggable,
                distance: Math.round(distance(eye(), add(pos, [0.5, 0.5, 0.5])) * 100) / 100,
                neighbors: OFFSETS.map(offset => {
                    const neighborPos = add(pos, offset);
                    const neighbor = readBlock(neighborPos);
                    return { position: neighborPos, block: neighbor?.name ?? null,
                        boundingBox: neighbor?.boundingBox ?? null };
                })
            };
        },
        async lookAt(position, signal) {
            const pos = coordinates(position, '朝向坐标');
            await look(add(pos, [0.5, 0.5, 0.5]), signal);
            return { yaw: bot.entity.yaw, pitch: bot.entity.pitch };
        },
        async digBlock(position, expectedBlock, signal) {
            signal?.throwIfAborted();
            if (bot.game.gameMode !== 'creative') throw new Error('请先将机器人设为创造模式');
            const pos = coordinates(position, '删除坐标');
            let block = readBlock(pos);
            if (!block) return 'unloaded';
            if (isAir(block)) return 'already_air';
            if (block.name !== expectedBlock) return 'target_changed';
            if (distance(body(), pos) > 256) return 'unreachable';
            const standingOnTarget = () => equal(add(body().map(Math.floor), [0, -1, 0]), pos);
            let visible = !standingOnTarget() && await seeTarget(pos, signal);
            if (!visible) {
                const approach = async (airborne) => {
                    const travel = airborne ? flyTo : walkTo;
                    if (!travel) return false;
                    for (const candidate of stands(pos, airborne)) {
                        signal?.throwIfAborted();
                        if (!await travel(candidate, signal)) continue;
                        signal?.throwIfAborted();
                        if (!standingOnTarget() && await seeTarget(pos, signal)) return true;
                    }
                    return false;
                };
                if (isFlying() || pos[1] > body()[1] + 3) visible = await approach(true);
                if (!visible && !isFlying()) visible = await approach(false);
                if (!visible && flyTo) visible = await approach(true);
                if (standingOnTarget()) {
                    // Never destroy the bot's support when relocation failed.
                    return 'standing_on_target';
                }
            }
            if (!visible) return 'unreachable';
            // Moving and looking can take time: bind the actual dig to the latest block.
            block = readBlock(pos);
            if (!block) return 'unloaded';
            if (isAir(block)) return 'already_air';
            if (block.name !== expectedBlock) return 'target_changed';
            if (!bot.canDigBlock(block)) return 'unbreakable';
            if (bot.heldItem) await bot.unequip('hand');
            signal?.throwIfAborted();
            block = readBlock(pos);
            if (!block) return 'unloaded';
            if (isAir(block)) return 'already_air';
            if (block.name !== expectedBlock) return 'target_changed';
            let timedOut = false;
            let rejectInterrupted;
            const interrupted = new Promise((resolve, reject) => { rejectInterrupted = reject; });
            const stop = () => {
                bot.stopDigging();
                rejectInterrupted(signal.reason);
            };
            const timer = setTimeout(() => {
                timedOut = true;
                bot.stopDigging();
                rejectInterrupted(new Error('删除动作超时'));
            }, digTimeoutMs);
            signal?.addEventListener('abort', stop, { once: true });
            try {
                // The visible face was selected above, so preserve that orientation.
                await Promise.race([bot.dig(block, false), interrupted]);
                if (settleMs) await delay(settleMs, undefined, { signal });
                signal?.throwIfAborted();
                return isAir(readBlock(pos)) ? 'removed' : 'dig_unconfirmed';
            } catch {
                signal?.throwIfAborted();
                return timedOut ? 'dig_timeout' : 'dig_rejected';
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', stop);
            }
        }
    };
}
