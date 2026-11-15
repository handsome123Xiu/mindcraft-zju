import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createTeamRuntime, edgeAllows } from '../src/building/team-runtime.js';
import { validateTeamSpec, actionAllowed, TEAM_PRESETS } from '../src/building/team-state.js';
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
function fixture(config = spec, path = ':memory:', publishInitially = true) {
    const runtime = createTeamRuntime({ spec: config, path });
    const sessions = Object.fromEntries(Object.keys(config.agents).map(name => [name, runtime.connect(name)]));
    const call = (name, method, args = {}) => runtime.request(name, sessions[name], method, args);
    for (const name of Object.keys(sessions)) call(name, 'heartbeat', { status: 'idle', canAcceptTask: true });
    call('lead', 'open_run', { id: 'run', request: 'Build floor', owner: 'tester', origin: [0, 0, 0], dimension: 'overworld' });
    if (publishInitially) call('lead', 'publish', { runId: 'run', previousVersion: 0, assignment });
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

// Review and revision can reuse one scope for construction, semantic review and then a new-version repair.
{
    const reviewRevision = TEAM_PRESETS.review_revision();
    assert(validateTeamSpec(reviewRevision).ok);
    assert(!actionAllowed(reviewRevision, 'builder', 'delegate_task').allowed);
    assert(!actionAllowed(reviewRevision, 'reviewer', 'design_blueprint').allowed);
    assert(!actionAllowed(reviewRevision, 'reviewer', 'dig_block').allowed);
    const f = fixture(reviewRevision);
    try {
        const build = f.call('lead', 'delegate', delegate('build', 'builder'));
        const buildTask = f.call('builder', 'take_task').task;
        assert.throws(() => f.call('lead', 'delegate', delegate('review', 'reviewer', undefined, { dependsOn: [build.taskId] })), /未完成委托/);
        f.finish('builder', buildTask, 8);
        f.call('lead', 'delegate', delegate('review', 'reviewer', undefined, { dependsOn: [build.taskId] }));
        const review = f.call('reviewer', 'take_task');
        assert.equal(review.run.request, 'Build floor', 'reviewer receives the project goal alongside the assigned task');
        assert.throws(() => f.call('reviewer', 'publish', { runId: 'run' }), /design_blueprint/);
        const summary = '必须修复：入口缺少阶梯。可选点缀：增加照明。';
        f.call('reviewer', 'task_result', { ...scopeOf(review.task), status: 'completed', summary,
            evidence: [{ partId: 'part-1', total: 8, remaining: 0 }] });
        const leadContext = f.call('lead', 'context', { runId: 'run' });
        assert(leadContext.tasks.some(task => task.key === 'review' && task.summary === summary));
        const revised = { ...assignment, blueprint: compileBlueprint({ shapes: [
            { kind: 'box', part: 'floor', min: [0, 0, 0], max: [7, 0, 0], block: 'stone' },
            { kind: 'point', part: 'fix', at: [0, 1, 0], block: 'stone_bricks' }
        ] }, [0, 0, 0]) };
        const removal = { runId: 'run', blueprintVersion: 1, partId: 'part-1' };
        assert.equal(f.call('lead', 'claim', removal).status, 'claimed');
        assert.equal(f.call('lead', 'assert_write', { ...removal, positions: [[0, 0, 0]] }).status, 'allowed');
        const revision = { runId: 'run', previousVersion: 1, assignment: revised };
        assert.throws(() => f.call('lead', 'publish', revision), /先释放施工租约/);
        f.call('lead', 'release', removal);
        assert.deepEqual(f.call('lead', 'publish', revision), { assignmentVersion: 2 });
        f.call('lead', 'delegate', delegate('repair', 'reviewer', [[0, 1, 0]], { blueprintVersion: 2, partIds: ['part-2'] }));
        const repair = f.call('reviewer', 'take_task').task;
        assert.equal(repair.blueprintVersion, 2);
        assert.equal(f.call('reviewer', 'assert_write', { ...scopeOf(repair), partId: 'part-2', positions: [[0, 1, 0]] }).status, 'allowed');
        assert.throws(() => f.call('reviewer', 'assert_write', { ...scopeOf(repair), partId: 'part-2', positions: [[1, 1, 0]] }), /超出认领部件/);
        f.call('reviewer', 'task_result', { ...scopeOf(repair), status: 'completed', summary: '已加台阶并复核入口。',
            evidence: [{ partId: 'part-2', total: 1, remaining: 0 }] });
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
    } finally { f.runtime.close(); }
}

// Router delegates its parent scope to the chosen workers without construction rights.
{
    const routing = TEAM_PRESETS.router();
    routing.edges.find(edge => edge.to === 'builder_2').note = '模型档案：model-b（deepseek_responses）';
    assert(validateTeamSpec(routing).ok);
    const decision = decisionInstructions({ assignment, teamTask: { id: 'scope' }, events: [] },
        { runtime: true, self: 'router', spec: () => routing }, 'router');
    assert.match(decision.instructions, /model-b/);
    assert(decision.nativeFunctions.some(fn => fn.name === 'delegate_task'));
    assert(!decision.nativeFunctions.some(fn => fn.name === 'place_block' || fn.name === 'design_blueprint'));
    const f = fixture(routing);
    try {
        assert.throws(() => f.call('lead', 'delegate', delegate('skip-router', 'builder_2')), /没有允许此委托的连线/);
        f.call('lead', 'delegate', delegate('route', 'router'));
        const parent = f.call('router', 'take_task').task;
        assert.throws(() => f.call('router', 'assert_write', { ...scopeOf(parent), partId: 'part-1', positions: [[0, 0, 0]] }), /施工权限/);
        f.call('router', 'delegate', delegate('left', 'builder_2', [[0,0,0], [1,0,0]], scopeOf(parent)));
        f.call('router', 'delegate', delegate('right', 'builder_1', Array.from({ length: 6 }, (_, i) => [i + 2,0,0]), scopeOf(parent)));
        assert.equal(f.call('router', 'context', scopeOf(parent)).currentTask.workScope.positions.length, 0);
        assert.throws(() => f.finish('router', parent, 8), /子任务尚未完成/);
        const left = f.call('builder_2', 'take_task').task;
        const right = f.call('builder_1', 'take_task').task;
        assert.equal(left.parentId, parent.id);
        assert.equal(right.parentId, parent.id);
        f.finish('builder_2', left, 2);
        f.finish('builder_1', right, 6);
        f.finish('router', parent, 8);
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
    } finally { f.runtime.close(); }
}

// Competitive candidates have separate inboxes, and only the chosen candidate gets a build lease.
{
    const competition = TEAM_PRESETS.competitive();
    assert(validateTeamSpec(competition).ok);
    const f = fixture(competition, ':memory:', false);
    try {
        const candidates = ['candidate_a', 'candidate_b'];
        const brief = '【方案征集】观察到平地，请提交一座木屋的布局、材料、施工顺序和风险。';
        for (const [index, candidate] of candidates.entries()) {
            f.call('lead', 'message', { runId: 'run', recipient: candidate, text: brief });
            const [invitation] = f.call(candidate, 'inbox');
            assert.equal(invitation.payload.text, brief);
            assert.equal(invitation.payload.context.request, 'Build floor');
            f.call(candidate, 'ack', { ids: [invitation.id] });
            f.call(candidate, 'message', { runId: 'run', recipient: 'lead', text: '【参赛方案】候选方案 ' + (index + 1) });
        }
        assert.throws(() => f.call('candidate_a', 'message', { runId: 'run', recipient: 'candidate_b', text: 'Share my proposal' }), /没有允许此消息的连线/);
        assert.throws(() => f.call('lead', 'delegate', delegate('early', 'candidate_b')), /先发布当前蓝图/);
        assert.deepEqual(f.call('lead', 'inbox').map(event => event.from), candidates);
        assert.deepEqual(f.call('candidate_b', 'inbox'), []);
        f.call('lead', 'publish', { runId: 'run', previousVersion: 0, assignment });
        f.call('lead', 'delegate', delegate('winning-proposal', 'candidate_b'));
        assert.equal(f.call('candidate_a', 'take_task'), null);
        const winner = f.call('candidate_b', 'take_task').task;
        const grant = { ...scopeOf(winner), partId: 'part-1', positions: [[0, 0, 0]] };
        assert.equal(f.call('candidate_b', 'assert_write', grant).status, 'allowed');
        assert.throws(() => f.call('candidate_a', 'assert_write', grant), /任务或执行租约已失效/);
        f.finish('candidate_b', winner, 8);
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
    } finally { f.runtime.close(); }
}

// Exercise the original basic presets with their actual topology, not a substitute graph.
for (const mode of ['centralized', 'peers', 'hierarchy']) {
    const f = fixture(TEAM_PRESETS[mode](['lead', 'worker', 'leaf']));
    try {
        f.call('lead', 'delegate', delegate('first', 'worker', mode === 'hierarchy' ? undefined : [[0,0,0], [1,0,0]]));
        const worker = f.call('worker', 'take_task').task;
        if (mode === 'hierarchy') {
            assert.throws(() => f.call('lead', 'delegate', delegate('skip', 'leaf')), /连线/);
            f.call('worker', 'delegate', delegate('next-stage', 'leaf', undefined, scopeOf(worker)));
            const leaf = f.call('leaf', 'take_task').task;
            assert.equal(leaf.parentId, worker.id);
            assert.throws(() => f.finish('worker', worker, 8), /子任务尚未完成/);
            f.finish('leaf', leaf, 8);
            f.finish('worker', worker, 8);
        } else {
            f.call('lead', 'delegate', delegate('second', 'leaf', Array.from({ length: 6 }, (_, i) => [i + 2,0,0])));
            const leaf = f.call('leaf', 'take_task').task;
            assert.equal(f.call('worker', 'assert_write', { ...scopeOf(worker), partId: 'part-1', positions: [[0,0,0]] }).status, 'allowed');
            assert.throws(() => f.call('worker', 'assert_write', { ...scopeOf(worker), partId: 'part-1', positions: [[2,0,0]] }), /超出/);
            f.finish('worker', worker, 2);
            f.finish('leaf', leaf, 6);
        }
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed', mode);
    } finally { f.runtime.close(); }
}

// Voting transport and execution path. Ballots are scripted: this tests framework
// wiring and permissions, not an LLM's tally or a nonexistent automatic vote gate.
{
    const voting = TEAM_PRESETS.voting();
    const f = fixture(voting, ':memory:', false);
    try {
        const voters = ['voter_1', 'voter_2', 'voter_3'];
        const brief = '【征集投票#1】A 石地板，B 木地板；同一平坦场地，按原始要求投票。';
        for (const [index, voter] of voters.entries()) {
            f.call('lead', 'message', { runId: 'run', recipient: voter, text: brief });
            const [invitation] = f.call(voter, 'inbox');
            assert.equal(invitation.payload.text, brief);
            assert.equal(invitation.payload.context.request, 'Build floor');
            f.call(voter, 'ack', { ids: [invitation.id] });
            f.call(voter, 'message', { runId: 'run', recipient: 'lead', text: '【投票#1】' + (index === 0 ? 'B' : 'A') + '｜独立选择' });
            assert.equal(f.call(voter, 'take_task'), null, 'ballot alone grants no construction task');
            assert.throws(() => f.call(voter, 'publish', { runId: 'run', previousVersion: 0, assignment }), /design_blueprint/);
            const prompt = decisionInstructions({ teamCoordination: true, events: [], plan: { steps: [] } },
                { runtime: true, self: voter, spec: () => voting }, voter);
            assert(prompt.nativeFunctions.some(fn => fn.name === 'send_message'));
            assert(!prompt.nativeFunctions.some(fn => ['place_block', 'delegate_task', 'design_blueprint'].includes(fn.name)),
                'coordination turn cannot construct, delegate or publish');
        }
        assert.throws(() => f.call('voter_1', 'message', { runId: 'run', recipient: 'voter_2', text: '看我的选票' }), /连线/);
        assert.throws(() => f.call('lead', 'delegate', delegate('before-blueprint', 'voter_1')), /先发布当前蓝图/);
        const ballots = f.call('lead', 'inbox').filter(event => event.kind === 'message');
        assert.deepEqual(ballots.map(event => event.from), voters, 'sender identity remains available to the Lead');
        assert.equal(ballots.length, 3);
        for (const voter of voters) assert.deepEqual(f.call(voter, 'inbox'), [], 'private ballots do not leak to other voters');
        // Script the Lead accepting A (two votes), then selecting the B voter to build.
        f.call('lead', 'publish', { runId: 'run', previousVersion: 0, assignment });
        f.call('lead', 'delegate', delegate('voted-build', 'voter_1'));
        const builder = f.call('voter_1', 'take_task').task;
        assert.equal(f.call('voter_2', 'take_task'), null);
        assert.equal(f.call('voter_3', 'take_task'), null);
        const grant = { ...scopeOf(builder), partId: 'part-1', positions: [[0,0,0]] };
        assert.equal(f.call('voter_1', 'assert_write', grant).status, 'allowed');
        assert.throws(() => f.call('voter_2', 'assert_write', grant), /任务或执行租约已失效/);
        assert.throws(() => f.call('voter_1', 'delegate', delegate('unauthorized-child', 'lead', undefined, scopeOf(builder))), /权限不足/);
        assert.throws(() => f.call('lead', 'finish_run', { runId: 'run' }), /未完成子任务/);
        f.finish('voter_1', builder, 8);
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
        assert.equal(f.runtime.snapshot().tasks.length, 1, 'one selected builder, no redundant build tasks');
    } finally { f.runtime.close(); }
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
