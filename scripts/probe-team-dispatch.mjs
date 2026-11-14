// Explicit live-model diagnostic, isolated from Minecraft and persisted runtime.
// Replays a saved coordinator on a synthetic flat world and in-memory queue.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { createTeamRuntime } from '../src/building/team-runtime.js';
import { createTeamClient } from '../src/building/team-client.js';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { createLazyBuildingModel } from '../src/building/model.js';

const path = process.argv[2];
if (!path || !process.argv.includes('--probe')) throw new Error('Usage: node scripts/probe-team-dispatch.mjs <lead-state.json> --probe');
const saved = JSON.parse(await readFile(path, 'utf8'));
const spec = JSON.parse(await readFile('bots/team.json', 'utf8'));
const name = 'lead';
const profile = JSON.parse(await readFile(spec.agents[name].profile ?? 'andy.json', 'utf8'));
const model = createLazyBuildingModel(profile.model);
const runtime = createTeamRuntime({ spec }); // no SQLite path: in memory only
const session = runtime.connect(name);
const direct = (method, args) => runtime.request(name, session, method, args);
const channel = new EventEmitter();
channel.connected = true;
channel.send = (message, callback) => queueMicrotask(() => {
    callback?.();
    try { channel.emit('message', { type: 'team_response', id: message.id, result: direct(message.method, message.args) }); }
    catch (error) { channel.emit('message', { type: 'team_response', id: message.id, error: error.message }); }
});
const team = createTeamClient({ name, spec, channel });
const sessions = Object.fromEntries(Object.keys(spec.agents).filter(n => n !== name).map(n => [n, runtime.connect(n)]));
const world = {
    snapshot: () => ({ dimension: saved.dimension, gameMode: 'creative', position: saved.origin.map((n,i) => n + (i === 2 ? 10 : 0)) }),
    read: pos => saved.placed[pos.join(',')] ?? (pos[1] < saved.origin[1] ? 'stone' : 'air'),
    async place() { throw new Error('Diagnostic forbids physical construction'); },
    async digBlock() { throw new Error('Diagnostic forbids physical demolition'); }
};
const controller = createBuildingLoop({ world, model, team, peers: team.peers, agentName: name,
    maxModelRequests: 10, timeLimitMs: 120000, save: async () => {}, sendMessage: async () => ({ status: 'sent' }),
    report(event, data) {
        if (event === 'step' && data.kind === 'feedback') console.log(JSON.stringify({ event, name: data.name, status: data.output?.status, message: data.output?.message }));
        if (event === 'result') console.log(JSON.stringify({ event, status: data.status, reason: data.reason }));
    }
});
try {
    direct('open_run', { id: saved.id, request: saved.request, owner: saved.owner, origin: saved.origin, dimension: saved.dimension });
    direct('publish', { runId: saved.id, previousVersion: 0, assignment: saved.assignment, design: saved.design });
    // Publication version starts at 1 in the diagnostic's new in-memory run.
    saved.assignmentVersion = 1;
    controller.restore(saved);
    await controller.resume();
    const snapshot = runtime.snapshot();
    const runnable = Object.entries(sessions).map(([worker, token]) => ({ worker,
        task: runtime.request(worker, token, 'take_task')?.task?.id ?? null }));
    const state = controller.snapshot();
    console.log(JSON.stringify({ diagnostic: 'No Minecraft connection, no persisted queue/state changes',
        status: state.status, decisions: state.modelRequests - saved.modelRequests,
        tasks: snapshot.tasks.map(({ id, to, partIds, scope, dependsOn }) => ({ id, to, partIds, scope, dependsOn })), runnable }, null, 2));
    assert(runnable.filter(worker => worker.task).length >= 2, 'Expected independently runnable work for at least two builders');
} finally { team.close(); runtime.close(); }
