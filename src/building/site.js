import { coordinates } from './blueprint.js';

const AIR = new Set(['air', 'cave_air', 'void_air']);

// Anchor chooses horizontal location. Read the loaded world to find the first
// buildable cell above a solid surface, even when the requesting player is flying.
export function resolveGroundOrigin(anchor, readBlock, minY, height) {
    const [x, anchorY, z] = coordinates(anchor, '施工锚点');
    const startY = Math.min(anchorY, minY + height - 3);
    for (let groundY = startY; groundY >= minY; groundY--) {
        const ground = readBlock([x, groundY, z]);
        if (!ground) throw new Error('施工位置的区块尚未加载，请靠近空地后再试');
        if (AIR.has(ground.name)) continue;
        const fullCube = ground.shapes?.some(shape =>
            shape.length === 6 && shape.every((n, i) => n === (i < 3 ? 0 : 1)));
        if (!fullCube || ground.boundingBox !== 'block') {
            throw new Error('施工位置下方不是完整的实体地面，请选择平整空地');
        }
        for (const offset of [1, 2]) {
            const above = readBlock([x, groundY + offset, z]);
            if (!above) throw new Error('施工位置的区块尚未加载，请靠近空地后再试');
            if (!AIR.has(above.name)) throw new Error('施工位置上方有障碍，请选择空地');
        }
        return [x, groundY + 1, z];
    }
    throw new Error('施工位置下方没有找到地面，请换一块空地');
}
