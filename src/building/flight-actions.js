import { setTimeout as delay } from 'node:timers/promises';
import { coordinates } from './blueprint.js';
import { planFlightDetour } from './flight-routing.js';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));

// Mineflayer's native flyTo has no collision checks or cancellation. Move in small
// checked steps instead, retaining its creative hover mode between actions.
// passThroughWalls allows phasing through loaded blocks when the normal
// collision-checked route fails: the bot still lands only in clear, supported cells.
export function createFlightActions(bot, { vector, tickMs = 50, timeoutMs = 30000,
    routeOptions = {}, passThroughWalls = false,
    wait = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
    let flying = false;
    let previousPhysics;
    let site;
    let corrected = false;
    let active = false;
    let failure = null;
    const body = () => ['x', 'y', 'z'].map(key => bot.entity.position[key]);

    function withinSite(point) {
        return !site || (bot.game.dimension === site.dimension && distance(point, site.origin) <= 256);
    }

    function canOccupy(point) {
        const height = bot.entity.height || 1.8;
        const halfWidth = (bot.entity.width || 0.6) / 2;
        const min = [point[0] - halfWidth, point[1], point[2] - halfWidth];
        const max = [point[0] + halfWidth, point[1] + height, point[2] + halfWidth];
        if (!withinSite(point) || min[1] < bot.game.minY || max[1] > bot.game.minY + bot.game.height) return false;
        for (let x = Math.floor(min[0]); x < max[0]; x++) {
            // Fences and walls can extend above their block's top boundary.
            for (let y = Math.max(bot.game.minY, Math.floor(min[1]) - 1); y < max[1]; y++) {
                for (let z = Math.floor(min[2]); z < max[2]; z++) {
                    const block = bot.blockAt(vector([x, y, z]));
                    if (!block) return false;
                    if (AIR.has(block.name)) continue;
                    const shapes = block.shapes ?? (block.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : []);
                    if (shapes.some(shape => [x, y, z].every((n, i) =>
                        min[i] < n + shape[i + 3] && max[i] > n + shape[i]))) return false;
                }
            }
        }
        return true;
    }

    function clearSegment(start, end) {
        const steps = Math.max(1, Math.ceil(distance(start, end) / 0.2));
        for (let i = 0; i <= steps; i++) {
            if (!canOccupy(start.map((n, axis) => n + (end[axis] - n) * i / steps))) return false;
        }
        return true;
    }

    function route(start, end) {
        if (clearSegment(start, end)) return [end];
        for (const rise of [2, 4, 8, 12]) {
            const y = Math.max(start[1], end[1]) + rise;
            const up = [start[0], y, start[2]];
            const across = [end[0], y, end[2]];
            if (clearSegment(start, up) && clearSegment(up, across) && clearSegment(across, end)) {
                return [up, across, end];
            }
        }
        const detour = planFlightDetour(start, end, { ...routeOptions, canOccupy, clearSegment });
        if (detour) return detour;
        // Wall-phasing fallback: a direct line through loaded blocks. The server
        // may still correct the bot; landing checks remain fully strict.
        if (passThroughWalls) return [end];
        return null;
    }

    function halt() {
        bot.pathfinder?.setGoal(null);
        bot.clearControlStates();
        bot.entity.velocity.set(0, 0, 0);
    }

    function reset(sendPacket = true) {
        if (!flying) return;
        bot.creative.stopFlying();
        bot.physicsEnabled = previousPhysics;
        flying = false;
        if (sendPacket) bot._client.write('abilities', { flags: 0 });
    }

    bot.on('forcedMove', () => { if (active) corrected = true; });
    for (const event of ['end', 'death', 'respawn']) bot.on(event, () => { corrected = true; reset(false); });
    bot.on('game', () => { if (bot.game.gameMode !== 'creative') { corrected = true; reset(false); } });

    async function flyTo(position, signal) {
        signal?.throwIfAborted();
        if (bot.game.gameMode !== 'creative') throw new Error('飞行需要机器人处于创造模式');
        if (active) throw new Error('已有飞行动作正在执行');
        failure = null;
        const cell = coordinates(position, '飞行目标');
        const target = [cell[0] + 0.5, cell[1], cell[2] + 0.5];
        if (distance(body(), target) > 256) throw new Error('飞行目标距离机器人过远');
        if (!passThroughWalls && !canOccupy(body())) { failure = 'start_obstructed'; return false; }
        if (!canOccupy(target)) { failure = 'target_obstructed_or_unloaded'; return false; }
        const path = route(body(), target);
        if (!path) { failure = 'no_clear_route'; return false; }
        halt();
        if (!flying) {
            previousPhysics = bot.physicsEnabled;
            bot._client.write('abilities', { flags: 2 });
            bot.creative.startFlying();
            bot.physicsEnabled = false;
            flying = true;
        }
        corrected = false;
        active = true;
        const started = Date.now();
        try {
            for (const waypoint of path) {
                while (distance(body(), waypoint) > 0.001) {
                    signal?.throwIfAborted();
                    if (corrected || !flying || bot.game.gameMode !== 'creative' || Date.now() - started >= timeoutMs) {
                        failure = corrected ? 'server_correction' : Date.now() - started >= timeoutMs ? 'flight_timeout' : 'flight_interrupted';
                        return false;
                    }
                    const current = body();
                    const scale = Math.min(1, 0.25 / distance(current, waypoint));
                    const next = current.map((n, i) => n + (waypoint[i] - n) * scale);
                    if (!passThroughWalls && !clearSegment(current, next)) { failure = 'route_changed'; return false; }
                    bot.entity.velocity.set(0, 0, 0);
                    bot.entity.onGround = false;
                    bot.entity.position.set(...next);
                    await wait(tickMs, signal);
                }
            }
            // Give the normal position sender and server corrections time to run.
            await wait(tickMs * 2, signal);
            signal?.throwIfAborted();
            return !corrected && flying && bot.game.gameMode === 'creative' &&
                canOccupy(body()) && distance(body(), target) < 0.35;
        } finally {
            active = false;
            halt();
        }
    }

    async function landAt(position, signal) {
        const cell = coordinates(position, '落地目标');
        const support = bot.blockAt(vector([cell[0], cell[1] - 1, cell[2]]));
        if (support?.boundingBox !== 'block' || !support.shapes?.some(shape =>
            shape[1] === 0 && shape[4] === 1 && shape[0] <= 0.2 && shape[3] >= 0.8 && shape[2] <= 0.2 && shape[5] >= 0.8)) {
            throw new Error('落地目标脚下需要完整实体支撑');
        }
        if (!await flyTo(cell, signal)) return false;
        const latest = bot.blockAt(vector([cell[0], cell[1] - 1, cell[2]]));
        if (latest?.stateId !== support.stateId || latest?.boundingBox !== 'block') return false;
        reset();
        return true;
    }

    return { flyTo, landAt, canOccupy, isFlying: () => flying, lastFailure: () => failure,
        setWorksite(value) { site = { origin: [...value.origin], dimension: value.dimension }; } };
}
