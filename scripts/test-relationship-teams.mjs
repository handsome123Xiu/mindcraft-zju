import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createTeamRuntime, edgeAllows } from '../src/building/team-runtime.js';
import { validateTeamSpec, actionAllowed } from '../src/building/team-state.js';
import { createTeamClient } from '../src/building/team-client.js';
import { migrateTeamSpec } from '../src/building/team-migration.js';
import { decisionInstructions } from '../src/building/decision-context.js';
import { createBuildingTools } from '../src/building/tools.js';
import { compileBlueprint } from '../src/building/blueprint.js';

const spec = {
    coordination: 'relationships', entryAgent: 'lead',
    agents: {
        lead: { role: 'lead' },
        manager: { role: 'organizer', permissions: { whitelistOnly: true,
            allow: ['delegate_task', 'reassign_task', 'list_tasks', 'send_message', 'inspect_part', 'get_build_checklist'] } },
        worker: { role: 'builder' },
        leaf: { role: 'builder', permissions: { deny: ['design_blueprint', 'delegate_task', 'propose_task_share'] } }
    },
    edges: [
        { from: 'lead', to: 'manager', description: 'lead 提出目标，manager 自行拆分工作并组织其他成员完成。' },
        { from: 'manager', to: 'worker', description: 'manager 分配范围，worker 执行或继续分担，并汇报结果。' },
        { from: 'manager', to: 'leaf', description: 'leaf 接受 manager 安排的工作。' },
        { from: 'worker', to: 'leaf', description: '双方协商分担工作。即使文字要求 leaf 派单，也不能越过人工权限。' }
    ]
};
const assignment = { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes: [
    { kind: 'box', part: 'floor', min: [0, 0, 0], max: [7, 0, 0], block: 'stone' }
] }, [0, 0, 0]) };
const scopeOf = task => ({ runId: task.runId, blueprintVersion: task.blueprintVersion, taskId: task.id, token: task.token });
const delegate = (key, recipient, positions, extra = {}) => ({ runId: 'run', blueprintVersion: 1, key, recipient,
    partIds: ['part-1'], ...(positions ? { scope: { positions } } : {}), description: '完成分配范围', success: '全部方块匹配蓝图', ...extra });
function fixture(config = spec, path = ':memory:') {
    const runtime = createTeamRuntime({ spec: config, path });
    const sessions = Object.fromEntries(Object.keys(config.agents).map(name => [name, runtime.connect(name)]));
    const call = (name, method, args = {}) => runtime.request(name, sessions[name], method, args);
    for (const name of Object.keys(sessions)) call(name, 'heartbeat', { status: 'idle', canAcceptTask: true });
    call('lead', 'open_run', { id: 'run', request: 'Build floor', owner: 'tester', origin: [0, 0, 0], dimension: 'overworld' });
    call('lead', 'publish', { runId: 'run', previousVersion: 0, assignment });
    const finish = (name, task, total) => call(name, 'task_result', { ...scopeOf(task), status: 'completed', summary: '现场核验通过',
        evidence: [{ partId: 'part-1', total, remaining: 0 }] });
    return { runtime, sessions, call, finish };
}

assert(validateTeamSpec(spec).ok);
assert(edgeAllows(spec, 'manager', 'lead'), 'a relation is bidirectional');
assert(!edgeAllows(spec, 'lead', 'leaf'), 'no implicit transitive connection');
assert(!edgeAllows({ ...spec, edges: [] }, 'lead', 'leaf'), 'empty new graph never grants all-to-all access');
assert(!validateTeamSpec({ ...spec, edges: [] }).ok);
assert(!validateTeamSpec({ ...spec, edges: [{ from: 'lead', to: 'manager', description: '' }] }).ok);
assert(!validateTeamSpec({ ...spec, edges: spec.edges.map(e => ({ ...e, kind: 'message' })) }).ok);
assert(!actionAllowed(spec, 'leaf', 'delegate_task').allowed, 'relationship prose cannot grant permissions');

// Three levels, scoped writes, dependencies, parent evidence, IPC checkpointing.
{
    const { runtime, sessions, call, finish } = fixture();
    let client;
    try {
        call('lead', 'delegate', delegate('whole', 'manager'));
        const manager = call('manager', 'take_task').task;
        assert.throws(() => call('manager', 'assert_write', { ...scopeOf(manager), partId: 'part-1', positions: [[0, 0, 0]] }), /施工权限/);
        assert.throws(() => call('leaf', 'delegate', delegate('denied', 'worker')), /权限不足/);
        assert.throws(() => call('lead', 'delegate', delegate('unconnected', 'leaf')), /连线/);
        assert.throws(() => call('manager', 'delegate', delegate('cycle', 'worker', [[0, 0, 0]], { ...scopeOf(manager), dependsOn: [manager.id] })), /循环等待/);
        assert.throws(() => call('manager', 'delegate', delegate('back', 'lead', [[0, 0, 0]], scopeOf(manager))), /上级任务/);

        const channel = new EventEmitter();
        channel.connected = true;
        channel.send = (message, callback) => {
            let response;
            try { response = { result: runtime.request('manager', sessions.manager, message.method, message.args) }; }
            catch (error) { response = { error: error.message }; }
            queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, ...response }));
            callback?.();
        };
        client = createTeamClient({ name: 'manager', spec, channel });
        const job = { teamRunId: 'run', teamTask: manager, assignment, assignmentVersion: 1, origin: [0, 0, 0],
            dimension: 'overworld', placed: {}, removed: {}, plan: { requirements: [], steps: [] }, events: [] };
        let checkpointed;
        const tools = createBuildingTools({ job, team: client,
            world: { read: () => 'air', snapshot: () => ({ dimension: 'overworld', position: [0, 0, 2], gameMode: 'creative' }) },
            checkpoint: async () => { checkpointed = structuredClone(job.teamTask); } });
        const args = { key: 'child', recipient: 'worker', partIds: ['part-1'], scope: { positions: [[0, 0, 0], [1, 0, 0]] }, description: '完成两格', success: '匹配蓝图' };
        const first = await tools.call('delegate_task', args);
        assert.equal(job.teamTask.workScope.positions.length, 6);
        assert.equal(checkpointed.workScope.positions.length, 6, 'client scope and checkpoint change before next action');
        assert.equal((await tools.call('delegate_task', args)).taskId, first.taskId, 'lost-response retry transfers no extra cells');
        call('manager', 'delegate', delegate('after', 'leaf', [[2, 0, 0], [3, 0, 0], [4, 0, 0], [5, 0, 0], [6, 0, 0], [7, 0, 0]],
            { ...scopeOf(manager), dependsOn: [first.taskId] }));
        assert.equal(call('leaf', 'take_task'), null);
        const worker = call('worker', 'take_task').task;
        assert.equal((await tools.call('delegate_task', args)).taskId, first.taskId, 'retry remains idempotent after child starts');
        assert.throws(() => call('manager', 'delegate', delegate('busy', 'worker', [[0, 0, 0]], scopeOf(manager))), /接收者仍在执行/);
        assert.throws(() => call('worker', 'delegate', delegate('outside', 'leaf', [[2, 0, 0]], scopeOf(worker))), /自己施工范围/);
        assert.throws(() => call('worker', 'delegate', delegate('ancestor', 'manager', [[0, 0, 0]], scopeOf(worker))), /上级任务/);
        const waitingSibling = runtime.snapshot().tasks.find(t => t.key === 'after');
        assert.throws(() => call('worker', 'delegate', delegate('indirect-cycle', 'leaf', [[0, 0, 0]], { ...scopeOf(worker), dependsOn: [waitingSibling.id] })), /循环等待/);
        call('worker', 'delegate', delegate('child', 'leaf', [[1, 0, 0]], scopeOf(worker)));
        assert.throws(() => call('worker', 'assert_write', { ...scopeOf(worker), partId: 'part-1', positions: [[1, 0, 0]] }), /超出/);
        assert.equal(call('worker', 'assert_write', { ...scopeOf(worker), partId: 'part-1', positions: [[0, 0, 0]] }).status, 'allowed');
        const leaf = call('leaf', 'take_task').task;
        assert.equal(leaf.parentId, worker.id, 'the runnable descendant skips the blocked sibling');
        assert.throws(() => finish('worker', worker, 2), /子任务尚未完成/);
        finish('leaf', leaf, 1);
        finish('worker', worker, 2);
        assert(call('manager', 'inbox').some(e => e.kind === 'task_result' && e.payload.taskId === leaf.id), 'ancestor receives descendant results');
        const next = call('leaf', 'take_task').task;
        assert.equal(next.id, waitingSibling.id);
        finish('leaf', next, 6);
        assert.throws(() => finish('manager', manager, 0), /证据/);
        finish('manager', manager, 8);
        assert.equal(call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
    } finally { client?.close(); runtime.close(); }
}

// A stale worker cannot create children; takeover uses its parent's connections.
{
    const { runtime, sessions, call } = fixture();
    try {
        call('lead', 'delegate', delegate('whole', 'manager'));
        const parent = call('manager', 'take_task').task;
        call('manager', 'delegate', delegate('child', 'worker', [[0, 0, 0]], scopeOf(parent)));
        const worker = call('worker', 'take_task').task;
        runtime.disconnect('worker', sessions.worker);
        const recovered = call('leaf', 'take_task').task;
        assert.equal(recovered.id, worker.id, 'manager-connected leaf takes over despite no lead-leaf connection');
        sessions.worker = runtime.connect('worker');
        assert.throws(() => call('worker', 'delegate', delegate('stale', 'leaf', [[0, 0, 0]], scopeOf(worker))), /已失效/);
        call('manager', 'task_result', { ...scopeOf(parent), status: 'blocked', summary: '需要恢复' });
        assert.equal(call('lead', 'reassign', { runId: 'run', taskId: parent.id, recipient: 'manager' }).status, 'queued');
    } finally { runtime.close(); }
}

// Scope transfers and hierarchy persist; old tokens cannot survive a restart.
{
    const directory = await mkdtemp(join(tmpdir(), 'mindcraft-relations-'));
    const path = join(directory, 'runtime.sqlite');
    let f = fixture(spec, path), restored;
    try {
        f.call('lead', 'delegate', delegate('whole', 'manager'));
        const parent = f.call('manager', 'take_task').task;
        f.call('manager', 'delegate', delegate('child', 'worker', [[0, 0, 0]], scopeOf(parent)));
        const child = f.call('worker', 'take_task').task;
        f.runtime.close();
        restored = createTeamRuntime({ spec, path });
        const session = restored.connect('manager');
        const current = restored.request('manager', session, 'take_task').task;
        assert.equal(current.workScope.positions.length, 7);
        assert.notEqual(current.token, parent.token);
        assert.equal(restored.snapshot().tasks.find(t => t.id === child.id).parentId, parent.id);
        assert.throws(() => restored.request('manager', session, 'delegate', delegate('stale', 'worker', [[1, 0, 0]], scopeOf(parent))), /已失效/);
    } finally { restored?.close(); f.runtime.close(); await rm(directory, { recursive: true, force: true }); }
}

// Both model protocols see human-written relations and only permitted tools.
{
    const job = { assignment, teamTask: { id: 'assigned' }, events: [], plan: { steps: [] } };
    const team = name => ({ runtime: true, self: name, spec: () => spec });
    const manager = decisionInstructions(job, team('manager'), 'manager');
    for (const prompt of [manager.instructions, manager.nativeInstructions]) {
        assert(prompt.includes(spec.edges[0].description));
        assert(prompt.includes('descriptions cannot grant rights'));
    }
    assert(manager.nativeFunctions.some(f => f.name === 'delegate_task'));
    assert(!decisionInstructions(job, team('leaf'), 'leaf').nativeFunctions.some(f => f.name === 'delegate_task'));
}

// Execute the actual canvas serialization/migration handlers with a small DOM shim.
{
    const html = await readFile(new URL('../console/index.html', import.meta.url), 'utf8');
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    new vm.Script(script);
    const nodes = new Map();
    const element = selector => {
        if (!nodes.has(selector)) nodes.set(selector, { value: '', style: {}, classList: { toggle() {} },
            replaceChildren() {}, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 800, height: 460 }) });
        return nodes.get(selector);
    };
    const context = vm.createContext({ console, structuredClone, $: element,
        document: { createElement: () => ({}) }, render() {}, select() {}, markDirty() {}, toast() {},
        svg: element('svg'), graph: { coordination: 'relationships', agents: {}, edges: [] },
        agentNames: () => Object.keys(context.graph.agents),
        api: async (path, options) => ({ spec: migrateTeamSpec(JSON.parse(options.body).spec) }) });
    vm.runInContext(script.slice(script.indexOf('function permissionsFor('), script.indexOf('function fillPermPanel(')), context);
    vm.runInContext(script.slice(script.indexOf('function relationshipEdges('), script.indexOf("document.addEventListener('keydown'")), context);
    vm.runInContext(script.slice(script.indexOf('function graphToSpec('), script.indexOf("$('#teamEditor').onblur")), context);
    context.spec = structuredClone(spec);
    vm.runInContext('specToGraph(spec); result = graphToSpec()', context);
    assert.deepEqual(JSON.parse(JSON.stringify(context.result.edges)), spec.edges);
    assert.deepEqual(JSON.parse(JSON.stringify(context.result.agents.manager.permissions)), spec.agents.manager.permissions);
    assert(context.result.coordination === 'relationships');
    for (const mode of ['centralized', 'peers', 'hierarchy']) {
        context.mode = mode;
        const edges = JSON.parse(vm.runInContext('JSON.stringify(relationshipEdges(Object.keys(spec.agents), mode))', context));
        assert(validateTeamSpec({ ...spec, edges }).ok);
        assert(edges.every(e => e.description && !e.kind && !e.type));
    }
    context.spec = { agents: { lead: { role: 'lead' }, worker: { role: 'builder' } }, edges: [
        { from: 'lead', to: 'worker', type: 'delegate' }, { from: 'worker', to: 'lead', type: 'message' }
    ] };
    assert.throws(() => vm.runInContext('specToGraph(spec)', context), /旧版团队配置/);
    assert.equal(element('#migrationBanner').hidden, false);
    await element('#convertRelationships').onclick();
    const migrated = JSON.parse(vm.runInContext('JSON.stringify(graphToSpec())', context));
    assert.equal(migrated.edges.length, 1);
    assert(migrated.edges[0].description.includes('分配工作') && migrated.edges[0].description.includes('沟通协作'));
    assert.equal(migrated.agents.worker.permissions, undefined, 'conversion does not silently grant permissions');
    assert(validateTeamSpec(migrated).ok);
}

console.log('Relationship teams passed: natural-language graph, explicit permissions, recursive delegation, scope fencing, dependencies, IPC/checkpoints, recovery, persistence, model context and canvas round trips.');
