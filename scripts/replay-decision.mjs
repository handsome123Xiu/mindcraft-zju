// Read-only replay of a saved decision context. --probe calls the configured
// model, but NEVER invokes game tools, sends messages or changes saved jobs.
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createDecisionRequest } from '../src/building/loop-agent.js';
import { createLazyBuildingModel } from '../src/building/model.js';
import { parseAction, validateSchema } from '../src/building/action-protocol.js';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/replay-decision.mjs <state.json> [--probe]');
const job = JSON.parse(await readFile(path, 'utf8'));
const agentName = basename(dirname(dirname(path)));
const spec = job.teamRunId ? JSON.parse(await readFile('bots/team.json', 'utf8')) : null;
const team = spec ? { runtime: true, self: agentName, spec: () => spec } : null;
// Saved files have no fresh live world snapshot. This diagnostic uses the
// worksite as the position and labels it; replay token counts are representative.
const world = { position: job.origin, dimension: job.dimension, diagnostic: 'Saved worksite position, not a fresh world observation.' };
const request = createDecisionRequest(job, world, { remainingModelRequests: 30 }, agentName, team);
const metrics = { state: basename(path), agentName, ...request.contextMetrics };
if (process.argv.includes('--probe')) {
    const profile = JSON.parse(await readFile(spec?.agents[agentName]?.profile ?? 'andy.json', 'utf8'));
    const model = createLazyBuildingModel(profile.model);
    const started = Date.now();
    const instructions = model.provider === 'DeepSeek' ? request.nativeInstructions : request.instructions;
    metrics.instructionsChars = instructions.length;
    const text = await model.sendRequest(request.turns, instructions, null, {
        purpose: 'decision', nativeFunctions: request.nativeFunctions, contextMetrics: request.contextMetrics,
        onUsage: usage => { metrics.usage = usage; }
    });
    let action;
    try { action = parseAction(text); }
    catch (error) {
        console.log(JSON.stringify({ ...metrics, rawResponse: text, error: error.message, executed: false }, null, 2));
        throw error;
    }
    const schema = request.actionContract.anyOf.find(s => s.properties.action.const === action.action);
    if (!schema) throw new Error('Model selected an action unavailable to this role/phase');
    if (model.provider !== 'DeepSeek') validateSchema(action, schema); // native extraction already validates every offered function
    metrics.elapsedMs = Date.now() - started;
    metrics.action = action;
    metrics.executed = false;
}
console.log(JSON.stringify(metrics, null, 2));
