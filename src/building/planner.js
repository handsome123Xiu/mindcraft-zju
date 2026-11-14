import { readFileSync } from 'node:fs';
import { compileBlueprint, MATERIALS } from './blueprint.js';
import { materialSummary } from './materials.js';
import { SHAPE_ACTION_GUIDE } from './construction-guidance.js';

export const BLUEPRINT_SKILL = Object.freeze({
    name: 'design_blueprint',
    description: 'Design or revise a blueprint using the goal, requirements, observations and failure feedback.',
    path: new URL('./skills/design-blueprint/SKILL.md', import.meta.url)
});

// Shared skill instructions serve both the agent loop and standalone planner.
export function createBlueprintSkill(model) {
    const instructions = readFileSync(BLUEPRINT_SKILL.path, 'utf8');
    return async ({ request, origin, signal, runId, context }) => {
        if (typeof request !== 'string' || !request.trim() || request.length > 1000) {
            throw new Error('建筑描述需为 1–1000 个字符');
        }
        signal?.throwIfAborted();
        const { supportedMaterials = MATERIALS, ...details } = context ?? {};
        const system = instructions + '\nMATERIAL_CATALOG_POLICY: ' + JSON.stringify(materialSummary(supportedMaterials)) +
            '\nSHAPE_TO_ACTION_GUIDE: ' + JSON.stringify(SHAPE_ACTION_GUIDE) +
            '\nOrigin: ' + JSON.stringify(origin) +
            (context ? '\nTASK_CONTEXT_JSON:\n' + JSON.stringify(details) : '');
        const text = await model.sendRequest([{ role: 'user', content: request }], system, null, { signal, runId, purpose: 'blueprint' });
        signal?.throwIfAborted();
        const json = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
        let spec;
        try { spec = JSON.parse(json); } catch { throw Object.assign(new Error('模型没有返回有效的蓝图 JSON；返回单个包含 summary、coverage、shapes 的对象'), { code: 'INVALID_BLUEPRINT_JSON' }); }
        let blueprint;
        try { blueprint = compileBlueprint(spec, origin, supportedMaterials); }
        catch (error) { error.code ??= 'INVALID_BLUEPRINT_GEOMETRY'; throw error; }
        return {
            blueprint,
            summary: typeof spec.summary === 'string' ? spec.summary.slice(0, 1000) : '',
            coverage: Array.isArray(spec.coverage) ? spec.coverage : [],
            shapes: spec.shapes
        };
    };
}

export function createPlanner(model) {
    const design = createBlueprintSkill(model);
    return async options => (await design(options)).blueprint;
}
