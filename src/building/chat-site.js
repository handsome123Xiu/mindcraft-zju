import { coordinates } from './blueprint.js';
import { resolveGroundOrigin } from './site.js';

// Selecting a candidate worksite must never reject an ordinary conversation.
export function chooseMessageSite(bot, username, explicitOrigin, readBlock) {
    const position = bot.entity.position;
    const fallback = [position.x, position.y, position.z].map(Math.floor);
    const site = { origin: fallback, dimension: bot.game.dimension, siteIssue: null };
    try {
        if (explicitOrigin) site.origin = coordinates(explicitOrigin, '施工原点');
        else {
            const player = bot.players[username]?.entity?.position;
            if (!player) throw new Error('玩家不在可见范围，施工前需要确认位置');
            const anchor = [Math.floor(player.x) + 6, Math.floor(player.y), Math.floor(player.z)];
            site.origin = resolveGroundOrigin(anchor, readBlock, bot.game.minY, bot.game.height);
        }
        if (Math.hypot(...site.origin.map((n, i) => n - fallback[i])) > 256) throw new Error('候选施工原点过远');
        if (site.origin[1] < bot.game.minY || site.origin[1] >= bot.game.minY + bot.game.height) {
            throw new Error('施工原点高度超出世界范围');
        }
    } catch (error) {
        site.origin = fallback;
        site.siteIssue = error.message;
    }
    return site;
}
