import { compileBlueprint, MATERIALS } from './blueprint.js';

const INSTRUCTIONS = `Turn a Minecraft construction request into one JSON object {"shapes":[...]}. No prose or Markdown.
If it is not a building request or cannot be represented, output {"shapes":[]}.
All coordinates are integers relative to the supplied origin (first buildable cell). y>=0. Center x,z near 0. Use -31..31; total extent at most 32 cells per axis and 12000 volume.
Shapes: {"kind":"point","at":[x,y,z],"block":"stone"}; {"kind":"box"|"shell","min":[x,y,z],"max":[x,y,z],"block":"stone"} (inclusive; shell has floor, walls and roof); {"kind":"opening","min":[x,y,z],"max":[x,y,z]} (subtracts cells from all shapes).
Design the requested structure yourself using these general primitives. Choose its dimensions, materials and component arrangement from the user's request. Use only supported materials. Roofs and overhangs need adjacent blocks and walking access; sand and gravel require solid support below. Assume flat land. Keep the design compact.
Different materials must never occupy the same coordinate. A shell includes its entire boundary, so partition that boundary into non-overlapping boxes if it contains multiple materials. All openings are applied after all solid shapes, regardless of order; an opening cannot be filled by a later shape. Check these geometric constraints before returning your design.
Supported materials: ${MATERIALS.join(', ')}.`;

export function createPlanner(model) {
    return async ({ request, origin, signal, runId }) => {
        if (typeof request !== 'string' || !request.trim() || request.length > 1000) {
            throw new Error('建筑描述需为 1–1000 个字符');
        }
        signal?.throwIfAborted();
        const text = await model.sendRequest([{ role: 'user', content: request }], INSTRUCTIONS, null, { signal, runId });
        signal?.throwIfAborted();
        const json = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
        let spec;
        try { spec = JSON.parse(json); } catch { throw new Error('模型没有返回有效的蓝图 JSON'); }
        return compileBlueprint(spec, origin);
    };
}
