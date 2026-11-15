import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateTeamSpec } from '../src/building/team-migration.js';
import { TEAM_PRESETS, validateTeamSpec, edgeAllows } from '../src/building/team-state.js';
import { openTeamStore } from '../src/building/team-store.js';
import { createTeamRuntime } from '../src/building/team-runtime.js';

const legacy = { entryAgent: 'lead', agents: { lead: { role: 'lead' }, worker: { role: 'builder',
    profile: 'worker.json', instructions: '保留职责', permissions: { deny: ['design_blueprint', 'delegate_task'] } } },
    edges: [{ from: 'lead', to: 'worker', kind: 'delegate', label: '师徒' },
        { from: 'worker', to: 'lead', type: 'report', note: '每完成一层汇报' },
        { from: 'lead', to: 'worker', type: 'message' }], rules: { assignment: 'lead-assigns', finish: 'lead-gates' } };
const before = JSON.stringify(legacy);
const converted = migrateTeamSpec(legacy);
assert.equal(JSON.stringify(legacy), before, 'migration is a read-only preview');
assert(validateTeamSpec(converted).ok);
assert.equal(converted.edges.length, 1);
assert(converted.edges[0].description.includes('每完成一层汇报'));
assert.deepEqual(converted.agents, legacy.agents, 'migration cannot grant permissions or rewrite responsibilities');
assert.equal(converted.rules, undefined);
assert.deepEqual(migrateTeamSpec(converted), converted, 'conversion is idempotent');
assert(!validateTeamSpec(legacy).ok);
assert.throws(() => createTeamRuntime({ spec: legacy }), /转换旧配置/);
assert.throws(() => migrateTeamSpec({ ...legacy, edges: [{ from: 'lead', to: 'worker', type: 'unknown' }] }), /未知旧连线/);
const openGraph = migrateTeamSpec({ ...legacy, edges: [] });
assert(edgeAllows(openGraph, 'worker', 'lead'));
assert(!edgeAllows({ ...openGraph, edges: [] }, 'worker', 'lead'));
assert(!validateTeamSpec({ ...converted, rules: {} }).ok);

// Historical active runs cannot silently acquire the new graph semantics.
const directory = await mkdtemp(join(tmpdir(), 'mindcraft-migrate-'));
const path = join(directory, 'runtime.sqlite');
const run = { id: 'old', spec: legacy, status: 'active', root: 'lead', blueprintVersion: 0 };
let store = openTeamStore(path), runtime;
try {
    store.transaction('runtime', {}, state => Object.assign(state, { runs: { old: run }, tasks: {}, claims: {}, proposals: {}, messages: [] }));
    store.close(); store = null;
    assert.throws(() => createTeamRuntime({ spec: converted, path }), /旧版工程不能/);
    store = openTeamStore(path);
    assert.deepEqual(store.read('runtime').runs.old, run, 'failed restore leaves history untouched');
    assert(!store.read('owner', {}).pid, 'failed restore leaves no runtime lock');
    store.close(); store = null;
    runtime = createTeamRuntime({ spec: converted, path, archiveLegacyRuns: true });
    const archived = runtime.snapshot().runs.find(r => r.id === 'old');
    assert.equal(archived.status, 'cancelled');
    assert.deepEqual(archived.spec, legacy, 'fresh start keeps the exact historical definition');
    runtime.close(); runtime = null;
    runtime = createTeamRuntime({ spec: converted, path });
    assert.equal(runtime.snapshot().runs[0].status, 'cancelled', 'archived legacy records remain readable');
} finally { runtime?.close(); store?.close(); await rm(directory, { recursive: true, force: true }); }
for (const preset of Object.values(TEAM_PRESETS)) assert(validateTeamSpec(preset(['a', 'b', 'c'])).ok);
console.log('Team migration passed: preview, explicit conversion, preserved permissions/history, old-run fencing, archive and new-only presets.');
