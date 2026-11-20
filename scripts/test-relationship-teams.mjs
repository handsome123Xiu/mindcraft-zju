import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createTeamRuntime, edgeAllows } from '../src/building/team-runtime.js';
import { validateTeamSpec, actionAllowed, capabilities, TEAM_PRESETS } from '../src/building/team-state.js';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { createTeamClient } from '../src/building/team-client.js';
import { migrateTeamSpec } from '../src/building/team-migration.js';
import { decisionInstructions } from '../src/building/decision-context.js';
import { createBuildingTools } from '../src/building/tools.js';
import { compileBlueprint } from '../src/building/blueprint.js';
import { createTeamTranscript } from '../console/team-transcript.js';
import { preserveTaskDependencies } from '../console/team-config.js';

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
    const root = Object.keys(config.agents).includes('lead') ? 'lead' : Object.keys(config.agents)[0];
    call(root, 'open_run', { id: 'run', request: 'Build floor', owner: 'tester', origin: [0, 0, 0], dimension: 'overworld' });
    if (publishInitially) call(root, 'publish', { runId: 'run', previousVersion: 0, assignment });
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

// An existing custom spec can reuse one scope for review and a new-version repair.
{
    const reviewRevision = {
        coordination: 'relationships', entryAgent: 'lead',
        agents: { lead: { role: 'lead' },
            builder: { role: 'builder', permissions: { deny: ['design_blueprint', 'delegate_task'] } },
            reviewer: { role: 'builder', permissions: { deny: ['design_blueprint', 'dig_block'] } } },
        edges: ['builder', 'reviewer'].map(to => ({ from: 'lead', to, description: '派工并核验结果' }))
    };
    assert(validateTeamSpec(reviewRevision).ok);
    assert(!actionAllowed(reviewRevision, 'builder', 'delegate_task').allowed);
    assert(!actionAllowed(reviewRevision, 'reviewer', 'design_blueprint').allowed);
    assert(!actionAllowed(reviewRevision, 'reviewer', 'dig_block').allowed);
    const f = fixture(reviewRevision);
    const chat = [];
    const transcript = createTeamTranscript({ snapshot: () => f.runtime.snapshot(), log: () => {},
        notify: (speaker, text) => chat.push({ speaker, text }) });
    function call(speaker, method, args) {
        const result = f.call(speaker, method, args);
        transcript(speaker, method, args, result);
        return result;
    }
    try {
        const build = call('lead', 'delegate', delegate('build', 'builder', undefined, { description: '【初版施工】铺设八格地板' }));
        const buildTask = f.call('builder', 'take_task').task;
        assert.throws(() => f.call('lead', 'delegate', delegate('review', 'reviewer', undefined, { dependsOn: [build.taskId] })), /未完成委托/);
        call('builder', 'task_result', { ...scopeOf(buildTask), status: 'completed', summary: '【初版交接】八格地板验收通过',
            evidence: [{ partId: 'part-1', total: 8, remaining: 0 }] });
        call('lead', 'delegate', delegate('review', 'reviewer', undefined, { dependsOn: [build.taskId],
            description: '【语义审查】初版验收通过，可以审查。检查入口是否方便使用' }));
        const review = f.call('reviewer', 'take_task');
        assert.equal(review.run.request, 'Build floor', 'reviewer receives the project goal alongside the assigned task');
        assert.throws(() => f.call('reviewer', 'publish', { runId: 'run' }), /design_blueprint/);
        const summary = '必须修复：入口缺少阶梯。可选点缀：增加照明。';
        call('reviewer', 'message', { runId: 'run', recipient: 'lead', text: '【审查意见】入口缺少阶梯，建议修订。' });
        call('reviewer', 'task_result', { ...scopeOf(review.task), status: 'completed', summary,
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
        assert.deepEqual(call('lead', 'publish', revision), { assignmentVersion: 2 });
        call('lead', 'delegate', delegate('repair', 'reviewer', [[0, 1, 0]], { blueprintVersion: 2, partIds: ['part-2'],
            description: '【新版修补】修订蓝图已发布，可以施工。v2 加入口阶梯' }));
        const repair = f.call('reviewer', 'take_task').task;
        assert.equal(repair.blueprintVersion, 2);
        assert.equal(f.call('reviewer', 'assert_write', { ...scopeOf(repair), partId: 'part-2', positions: [[0, 1, 0]] }).status, 'allowed');
        assert.throws(() => f.call('reviewer', 'assert_write', { ...scopeOf(repair), partId: 'part-2', positions: [[1, 1, 0]] }), /超出认领部件/);
        call('reviewer', 'task_result', { ...scopeOf(repair), status: 'completed', summary: '【复核结果】已加台阶并复核入口。',
            evidence: [{ partId: 'part-2', total: 1, remaining: 0 }] });
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
        assert.deepEqual(chat.map(event => event.speaker), ['lead', 'builder', 'lead', 'reviewer', 'reviewer', 'lead', 'lead', 'reviewer']);
        assert(chat[1].text.startsWith('[-> lead] [完工') && chat[1].text.includes('【初版交接】'));
        assert(chat[2].text.includes('【语义审查】初版验收通过'));
        assert.equal(chat[3].text, '[-> lead] 【审查意见】入口缺少阶梯，建议修订。');
        assert(chat[5].text.startsWith('[发布蓝图 v2]'));
        assert(chat[6].text.includes('【新版修补】修订蓝图已发布'));
        assert(chat[7].text.includes('【复核结果】'));
    } finally { f.runtime.close(); }
}

// Router (independent mode) selects ONE builder via delegate_site; that builder
// designs its own blueprint and builds; only the delegated site gates the finish.
{
    const routing = TEAM_PRESETS.router();
    assert(validateTeamSpec(routing).ok);
    assert.equal(routing.entryAgent, 'router');
    assert.equal(routing.blueprintMode, 'independent');
    assert.deepEqual(Object.keys(routing.agents), ['router', 'builder_1', 'builder_2', 'builder_3', 'builder_4']);
    // Router routes and inspects but never designs or builds.
    assert(actionAllowed(routing, 'router', 'delegate_site').allowed);
    assert(!actionAllowed(routing, 'router', 'design_blueprint').allowed);
    assert(!actionAllowed(routing, 'router', 'place_block').allowed);
    assert(capabilities(routing, 'router').finishGate);
    // Each builder designs and builds its own site, but never routes.
    for (const name of ['builder_1', 'builder_2', 'builder_3', 'builder_4']) {
        assert(actionAllowed(routing, name, 'design_blueprint').allowed);
        assert(capabilities(routing, name).canBuild);
        assert(!actionAllowed(routing, name, 'delegate_site').allowed);
        assert(!actionAllowed(routing, name, 'delegate_task').allowed);
    }
    // The router prompt surfaces each builder's specialty and the routing tool.
    const team = { runtime: true, self: 'router', spec: () => routing };
    const decision = decisionInstructions({ assignment, teamTask: null, events: [] }, team, 'router');
    assert.match(decision.instructions, /石材与砖类/);
    assert(decision.nativeFunctions.some(fn => fn.name === 'delegate_site'));
    assert(!decision.nativeFunctions.some(fn => fn.name === 'design_blueprint' || fn.name === 'place_block' || fn.name === 'delegate_task'));

    const f = fixture(routing, ':memory:', false);
    try {
        // The router chooses builder_3 and hands over the whole task as one site.
        const { taskId } = f.call('router', 'delegate_site', { runId: 'run', recipient: 'builder_3',
            origin: [0, 0, 0], region: { min: [0, 0, 0], max: [3, 0, 3] } });
        assert(taskId);
        // Unselected builders receive no task.
        assert.equal(f.call('builder_1', 'take_task'), null);
        assert.equal(f.call('builder_2', 'take_task'), null);
        assert.equal(f.call('builder_4', 'take_task'), null);
        // Nothing built yet, so the finish gate is still closed.
        assert.throws(() => f.call('router', 'finish_run', { runId: 'run' }), /所有独立工地/);

        const task = f.call('builder_3', 'take_task').task;
        // The chosen builder designs its own blueprint at the site origin.
        f.call('builder_3', 'publish', { runId: 'run', taskId: task.id, token: task.token, previousVersion: 0,
            design: { origin: [0, 0, 0], summary: '独立设计石质地板' },
            assignment: { version: 1, dimension: 'overworld',
                blueprint: compileBlueprint({ shapes: [
                    { kind: 'box', part: 'floor', min: [0, 0, 0], max: [3, 0, 3], block: 'stone' }
                ] }, [0, 0, 0]) } });
        f.call('builder_3', 'task_result', { runId: 'run', taskId: task.id, token: task.token,
            blueprintVersion: 1, status: 'completed', summary: '石质地板施工验收通过',
            evidence: [{ partId: 'part-1', total: 16, remaining: 0 }] });
        assert.equal(f.call('router', 'finish_run', { runId: 'run' }).status, 'completed');
    } finally { f.runtime.close(); }
}



// Competitive (independent mode) hands TWO candidates their own sites; both design
// and build independently; the lead inspects both and judges. blockLimit caps each
// candidate's blueprint at generation time and at the runtime publish gate.
{
    const competition = TEAM_PRESETS.competitive();
    assert(validateTeamSpec(competition).ok);
    assert.equal(competition.entryAgent, 'lead');
    assert.equal(competition.blueprintMode, 'independent');
    assert.equal(competition.blockLimit, 200);
    assert.deepEqual(Object.keys(competition.agents), ['lead', 'candidate_a', 'candidate_b']);
    // Lead delegates sites and inspects, but never designs, builds, or tasks.
    assert(actionAllowed(competition, 'lead', 'delegate_site').allowed);
    assert(!actionAllowed(competition, 'lead', 'design_blueprint').allowed);
    assert(!actionAllowed(competition, 'lead', 'place_block').allowed);
    assert(!actionAllowed(competition, 'lead', 'delegate_task').allowed);
    assert(capabilities(competition, 'lead').finishGate);
    // Each candidate designs and builds its own site, but never delegates.
    for (const name of ['candidate_a', 'candidate_b']) {
        assert(actionAllowed(competition, name, 'design_blueprint').allowed);
        assert(capabilities(competition, name).canBuild);
        assert(!actionAllowed(competition, name, 'delegate_site').allowed);
        assert(!actionAllowed(competition, name, 'delegate_task').allowed);
    }
    // The lead prompt carries the judging rubric and only the site-delegation tool.
    const team = { runtime: true, self: 'lead', spec: () => competition };
    const decision = decisionInstructions({ assignment, teamTask: null, events: [] }, team, 'lead');
    assert.match(decision.instructions, /美观/);
    assert(decision.nativeFunctions.some(fn => fn.name === 'delegate_site'));
    assert(!decision.nativeFunctions.some(fn => fn.name === 'design_blueprint' || fn.name === 'place_block' || fn.name === 'delegate_task'));

    const f = fixture(competition, ':memory:', false);
    try {
        // The lead gives each candidate its own non-overlapping site.
        const siteA = f.call('lead', 'delegate_site', { runId: 'run', recipient: 'candidate_a',
            origin: [0, 0, 0], region: { min: [0, 0, 0], max: [6, 0, 6] } });
        const siteB = f.call('lead', 'delegate_site', { runId: 'run', recipient: 'candidate_b',
            origin: [0, 0, 10], region: { min: [0, 0, 10], max: [6, 0, 16] } });
        assert(siteA.taskId && siteB.taskId);
        // The lead never publishes a shared blueprint.
        assert.throws(() => f.call('lead', 'publish', { runId: 'run', previousVersion: 0, assignment }), /design_blueprint/);
        // Both candidates design and build their own site.
        for (const [name, site] of [['candidate_a', siteA], ['candidate_b', siteB]]) {
            const task = f.call(name, 'take_task').task;
            assert.equal(task.id, site.taskId);
            // Over-limit blueprints are rejected at the runtime publish gate.
            assert.throws(() => f.call(name, 'publish', { runId: 'run', taskId: task.id, token: task.token,
                previousVersion: 0, design: { origin: task.site.origin, summary: '超限设计' },
                assignment: { version: 1, dimension: 'overworld',
                    blueprint: compileBlueprint({ shapes: [
                        { kind: 'box', part: 'floor', min: [0, 0, 0], max: [19, 0, 19], block: 'stone' }
                    ] }, task.site.origin) } }), /超过上限/);
            // A compliant blueprint fits the site and publishes.
            f.call(name, 'publish', { runId: 'run', taskId: task.id, token: task.token, previousVersion: 0,
                design: { origin: task.site.origin, summary: '独立设计木屋' },
                assignment: { version: 1, dimension: 'overworld',
                    blueprint: compileBlueprint({ shapes: [
                        { kind: 'box', part: 'floor', min: [0, 0, 0], max: [3, 0, 3], block: 'stone' }
                    ] }, task.site.origin) } });
            f.call(name, 'task_result', { runId: 'run', taskId: task.id, token: task.token,
                blueprintVersion: 1, status: 'completed', summary: '本工地施工核验通过',
                evidence: [{ partId: 'part-1', total: 16, remaining: 0 }] });
        }
        // The finish gate only opens once every site is complete.
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
    } finally { f.runtime.close(); }
}

// Pipeline handoff drives the real clients and scoped building tools without entry approval.
{
    const template = TEAM_PRESETS.pipeline();
    const stale = structuredClone(template);
    for (const node of Object.values(stale.agents)) delete node.taskAfter;
    const { spec: pipeline, preserved } = preserveTaskDependencies(stale, template);
    assert.deepEqual(preserved, ['builder2', 'builder3']);
    assert.equal(stale.agents.builder2.taskAfter, undefined, 'save reconciliation must not mutate the request');
    const cleared = structuredClone(template);
    cleared.agents.builder3.taskAfter = null;
    assert.equal(preserveTaskDependencies(cleared, template).spec.agents.builder3.taskAfter, null);
    const centralized = TEAM_PRESETS.centralized();
    assert.deepEqual(preserveTaskDependencies(centralized, template).spec, centralized, 'changing paradigms must not inherit pipeline dependencies');
    const changedRoute = structuredClone(stale);
    changedRoute.agents.builder2.taskReportTo = 'lead';
    assert.equal(preserveTaskDependencies(changedRoute, template).spec.agents.builder2.taskAfter, undefined);
    assert.equal(pipeline.agents.builder1.taskReportTo, 'builder2');
    assert.equal(pipeline.agents.builder2.taskReportTo, 'builder3');
    assert.equal(pipeline.agents.builder3.taskReportTo, 'lead');
    const cyclic = structuredClone(pipeline);
    cyclic.agents.builder1.taskAfter = 'builder2';
    assert(!validateTeamSpec(cyclic).ok, 'workflow prerequisites cannot contain a cycle');
    const invalid = structuredClone(pipeline);
    invalid.agents.builder1.taskReportTo = 'builder3';
    assert(!validateTeamSpec(invalid).ok, 'handoffs require an actual relationship');
    const f = fixture(pipeline);
    const chat = [], events = [], requests = [], started = [], clients = [], errors = [];
    const cells = new Map();
    const world = {
        snapshot: () => ({ dimension: 'overworld', position: [0, 0, 2], gameMode: 'creative' }),
        read: pos => cells.get(pos.join(',')) ?? (pos[1] < 0 ? 'stone' : 'air'),
        async prepare() {},
        async place({ pos, block, authorize }) {
            await authorize([pos]);
            cells.set(pos.join(','), block);
            return 'placed';
        }
    };
    const transcript = createTeamTranscript({ snapshot: () => f.runtime.snapshot(), log: () => {},
        notify: (speaker, text) => chat.push({ speaker, text }) });
    const call = (name, method, args = {}) => {
        requests.push({ name, method });
        const result = f.call(name, method, args);
        transcript(name, method, args, result);
        return result;
    };
    const until = async predicate => {
        const deadline = Date.now() + 10000;
        while (!predicate()) {
            if (errors.length) throw errors[0];
            if (Date.now() >= deadline) throw new Error('pipeline client handoff timed out');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    try {
        assert.throws(() => call('lead', 'delegate', delegate('out-of-order', 'builder3', [[4,0,0]])), /taskAfter/);
        const floor = call('lead', 'delegate', delegate('floor', 'builder1', [[0,0,0], [1,0,0]]));
        const wall = call('lead', 'delegate', delegate('wall', 'builder2', [[2,0,0], [3,0,0]]));
        call('lead', 'delegate', delegate('roof', 'builder3', [[4,0,0], [5,0,0], [6,0,0], [7,0,0]]));
        const queued = f.runtime.snapshot().tasks;
        assert.deepEqual(queued.find(task => task.to === 'builder2').dependsOn, [floor.taskId]);
        assert.deepEqual(queued.find(task => task.to === 'builder3').dependsOn, [wall.taskId]);
        requests.length = 0;
        for (const name of ['builder1', 'builder2', 'builder3']) {
            const channel = new EventEmitter();
            channel.connected = true;
            channel.send = (message, callback) => {
                let response;
                try { response = { result: call(name, message.method, message.args) }; }
                catch (error) { response = { error: error.message }; }
                queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, ...response }));
                callback?.();
            };
            const team = createTeamClient({ name, spec: pipeline, channel, onError: error => errors.push(error) });
            clients.push(team);
            let status = 'idle';
            team.attach({
                status: () => status,
                canAcceptTask: () => status === 'idle' || status === 'completed',
                async receiveTeamEvent(event) {
                    events.push({ recipient: name, ...event });
                    return true;
                },
                async acceptTask({ task, run }) {
                    status = 'building';
                    started.push(name);
                    if (name === 'builder1') await firstGate;
                    const job = { teamRunId: run.id, teamTask: task, request: task.description, origin: run.origin,
                        assignment: run.assignment, assignmentVersion: run.blueprintVersion, design: run.design,
                        dimension: run.dimension, placed: {}, removed: {}, events: [],
                        plan: { requirements: [], steps: [] } };
                    const tools = createBuildingTools({ team, job, world, checkpoint: async () => {} });
                    for (const position of task.scope.positions) {
                        await tools.call('place_block', { position, block: 'stone', partId: 'part-1', assignmentVersion: 1 });
                    }
                    await team.settle(job, { status: 'completed', summary: name + ' 现场 remaining=0',
                        teamEvidence: tools.inspectTask() });
                    status = 'completed';
                },
                async stop() {}
            });
        }
        await until(() => started.length === 1);
        assert.deepEqual(started, ['builder1']);
        assert.equal(f.runtime.snapshot().tasks.find(task => task.to === 'builder2').status, 'queued');
        assert.equal(call('lead', 'inbox').length, 0, 'entry stays asleep while stages run');
        requests.length = 0;
        releaseFirst();
        await until(() => f.runtime.snapshot().tasks.every(task => task.status === 'completed'));
        await until(() => events.some(event => event.recipient === 'builder3' && event.kind === 'task_result'));
        assert.deepEqual(started, ['builder1', 'builder2', 'builder3']);
        assert(!requests.some(request => request.name === 'lead'), 'all stages advance without another entry request');
        assert(!requests.some(request => request.method === 'message'), 'completion itself delivers the handoff');
        assert(events.some(event => event.recipient === 'builder2' && event.from === 'builder1' && event.payload.status === 'completed'));
        assert(events.some(event => event.recipient === 'builder3' && event.from === 'builder2' && event.payload.status === 'completed'));
        assert.deepEqual(call('lead', 'inbox').map(event => [event.from, event.kind]), [['builder3', 'task_result']]);
        assert.equal(cells.size, 8);
        for (const [speaker, recipient] of [['builder1', 'builder2'], ['builder2', 'builder3'], ['builder3', 'lead']]) {
            assert(chat.some(item => item.speaker === speaker && item.text.includes('[-> ' + recipient + ']') && item.text.includes('阶段交付')));
        }
        assert(!chat.some(item => ['builder1', 'builder2'].includes(item.speaker) && item.text.includes('[-> lead]')));
        assert.equal(call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
        assert.deepEqual(errors, []);
    } finally {
        releaseFirst();
        for (const client of clients) client.close();
        f.runtime.close();
    }
}

{
    const parallel = TEAM_PRESETS.parallel();
    const f = fixture(parallel, ':memory:', false);
    const names = ['builder1', 'builder2', 'builder3'];
    const materials = ['stone', 'sandstone', 'oak_planks'];
    const cells = new Map();
    const world = { read: pos => cells.get(pos.join(',')) ?? (pos[1] < 0 ? 'stone' : 'air'),
        snapshot: () => ({ dimension: 'overworld', position: [0, 0, 2], gameMode: 'creative' }),
        async prepare() {},
        async place({ pos, block, authorize }) {
            await authorize([pos]);
            cells.set(pos.join(','), block);
            return true;
        } };
    const clients = [];
    const chat = [];
    const transcript = createTeamTranscript({ snapshot: () => f.runtime.snapshot(), log: () => {},
        notify: (speaker, text) => chat.push({ speaker, text }) });
    const call = (name, method, args) => {
        const result = f.call(name, method, args);
        transcript(name, method, args ?? {}, result);
        return result;
    };
    const run = { runId: 'run' };
    const setup = (name, claimed) => {
        const channel = new EventEmitter();
        channel.connected = true;
        channel.send = (message, callback) => {
            let response;
            try { response = { result: call(name, message.method, message.args) }; }
            catch (error) { response = { error: error.message }; }
            queueMicrotask(() => channel.emit('message', { type: 'team_response', id: message.id, ...response }));
            callback?.();
        };
        const team = createTeamClient({ name, spec: parallel, channel });
        clients.push(team);
        const job = { teamRunId: 'run', teamTask: claimed?.task, origin: claimed?.run.origin ?? [0, 0, 0],
            originLocked: true, request: claimed?.run.request ?? 'Build floor', assignment: null, assignmentVersion: 0,
            dimension: 'overworld', placed: {}, removed: {}, plan: { requirements: [{ id: 'goal', description: 'Build floor' }], steps: [] }, events: [] };
        return { team, job };
    };
    const site = (index, x = 10 * index, y = 0) => ({ recipient: names[index],
        origin: [x, y, 0], region: { min: [x, y, 0], max: [x + 3, y + 3, 3] } });
    try {
        assert.deepEqual(Object.keys(parallel.agents), ['lead', ...names]);
        const lead = setup('lead');
        const dispatch = createBuildingTools({ ...lead, world, checkpoint: async () => {} });
        const capabilitiesFor = ({ job, team }) => decisionInstructions(job, team, team.self).nativeFunctions.map(fn => fn.name);
        assert(capabilitiesFor(lead).includes('delegate_site'));
        assert(!capabilitiesFor(lead).includes('design_blueprint'));
        assert.throws(() => call('lead', 'publish', { ...run, previousVersion: 0, assignment }), /design_blueprint/);
        const first = await dispatch.call('delegate_site', site(0));
        await assert.rejects(dispatch.call('delegate_site', site(1, 0, 20)), /水平投影/);
        assert.equal((await dispatch.call('delegate_site', site(0))).taskId, first.taskId);
        await dispatch.call('delegate_site', site(1));
        await dispatch.call('delegate_site', site(2));

        const workers = names.map(name => setup(name, call(name, 'take_task')));
        assert.equal(f.runtime.snapshot().tasks.filter(task => task.status === 'running').length, 3);
        assert.throws(() => call('builder1', 'message', { ...run, recipient: 'builder2', text: '试发' }), /连线/);
        assert.throws(() => f.finish('builder1', workers[0].job.teamTask, 0), /独立|当前蓝图/);
        assert.throws(() => call('builder1', 'assert_write', { ...scopeOf(workers[0].job.teamTask), partId: 'part-1', positions: [[0, 0, 0]] }), /独立蓝图/);

        const published = await Promise.all(workers.map(async (worker, index) => {
            const name = names[index], job = worker.job;
            assert.equal(job.request, 'Build floor');
            assert(capabilitiesFor(worker).includes('design_blueprint'));
            assert(!capabilitiesFor(worker).includes('place_block'));
            let designTooWide = index === 0;
            const tools = createBuildingTools({ ...worker, world, checkpoint: async () => {},
                design: async ({ request, origin, context }) => {
                    assert.equal(request, 'Build floor');
                    assert.deepEqual(context.assignedSite.region, site(index).region);
                    const shapes = [{ kind: 'box', min: [0, 0, 0], max: [designTooWide ? 4 : index, 0, 0], block: materials[index] }];
                    return { blueprint: compileBlueprint({ shapes }, origin), shapes, summary: '独立设计 ' + name,
                        coverage: [{ requirementId: 'goal', evidence: '设计完成' }] };
                } });
            if (designTooWide) {
                await assert.rejects(tools.useSkill('design_blueprint', {}), { code: 'SITE_BOUNDS' });
                designTooWide = false;
            }
            await tools.useSkill('design_blueprint', {});
            assert.equal(job.assignmentVersion, 1);
            assert.deepEqual(job.teamTask.partIds, ['part-1']);
            assert.equal(call(name, 'context', scopeOf(job.teamTask)).sharedAssignment.blueprint.blocks[0].block, materials[index]);
            return tools;
        }));

        assert.equal(call('lead', 'context', run).sharedAssignment, undefined);
        assert.throws(() => call('builder1', 'assert_write', { ...scopeOf(workers[0].job.teamTask), partId: 'part-1', positions: [[10, 0, 0]] }), /超出/);
        for (const [index, { job, team }] of workers.entries()) {
            const tools = published[index];
            for (const cell of job.assignment.blueprint.blocks) {
                await tools.call('place_block', { position: cell.pos, block: cell.block, partId: 'part-1', assignmentVersion: 1 });
            }
            await team.settle(job, { status: 'completed', summary: '现场核验通过', teamEvidence: tools.inspectTask() });
            if (index < 2) assert.throws(() => call('lead', 'finish_run', run), /所有独立工地/);
        }

        await lead.team.refresh(lead.job);
        const combined = lead.job.assignment.blueprint;
        assert.deepEqual(combined.parts.map(part => part.title), names.map(name => name + ' 的建筑'));
        assert.deepEqual(combined.blocks.map(cell => cell.block), ['stone', 'sandstone', 'sandstone', 'oak_planks', 'oak_planks', 'oak_planks']);
        assert.deepEqual(combined.clearance, [], 'unused gaps between sites are not demolition targets');
        cells.delete('10,0,0');
        assert.equal(dispatch.inspect().differences.length, 1, 'entry sees post-completion changes in another site');
        cells.set('10,0,0', 'sandstone');
        assert.equal(dispatch.inspect().differences.length, 0);
        assert.equal(call('lead', 'finish_run', run).status, 'completed');
        assert(chat.some(item => item.speaker === 'lead' && item.text.includes('[-> builder3]') && item.text.includes('划定工地')));
        assert(chat.some(item => item.speaker === 'builder2' && item.text.includes('[-> lead]') && item.text.includes('发布独立蓝图')));
    } finally {
        for (const client of clients) client.close();
        f.runtime.close();
    }
}
{
    const f = fixture(TEAM_PRESETS.handoff());
    const chat = [];
    const transcript = createTeamTranscript({ snapshot: () => f.runtime.snapshot(), log: () => {},
        notify: (speaker, text) => chat.push({ speaker, text }) });
    function call(speaker, method, args) {
        const result = f.call(speaker, method, args);
        transcript(speaker, method, args, result);
        return result;
    }
    try {
        f.call('lead', 'delegate', delegate('wall', 'builder_a'));
        const first = f.call('builder_a', 'take_task').task;
        const remaining = [[4,0,0], [5,0,0], [6,0,0], [7,0,0]];
        const offer = call('builder_a', 'propose_share', delegate('baton', 'builder_b', remaining,
            { ...scopeOf(first), description: '续建后半段，前四格已验收' })).proposal;
        call('builder_b', 'respond_share', { runId: 'run', proposalId: offer.id, accept: true });
        assert.equal(f.call('builder_b', 'take_task'), null, 'acceptance does not grant write scope');
        const child = call('builder_a', 'commit_share', { ...scopeOf(first), proposalId: offer.id });
        const second = f.call('builder_b', 'take_task').task;
        assert.equal(second.id, child.taskId);
        assert.throws(() => f.call('builder_a', 'assert_write', { ...scopeOf(first), partId: 'part-1', positions: [[4,0,0]] }), /超出/);
        assert.throws(() => f.finish('builder_a', first, 8), /子任务尚未完成/);
        call('builder_b', 'task_result', { ...scopeOf(second), status: 'blocked', summary: '接棒位置前有障碍' });
        const resume = { runId: 'run', taskId: second.id, recipient: 'builder_b' };
        assert.throws(() => f.call('lead', 'reassign', resume), /连线/);
        call('builder_a', 'reassign', resume);
        const resumed = f.call('builder_b', 'take_task').task;
        assert.equal(resumed.id, second.id);
        assert.equal(resumed.parentId, first.id);
        f.finish('builder_b', resumed, 4);
        f.finish('builder_a', first, 8);
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
        assert.deepEqual(chat.map(({ speaker }) => speaker), ['builder_a', 'builder_b', 'builder_a', 'builder_b', 'builder_a']);
        assert(chat[3].text.startsWith('[-> builder_a] [阻塞'));
        assert(chat[4].text.startsWith('[-> builder_b] [重派'));
        assert(chat[0].text.startsWith('[-> builder_b] [提议协作]'));
        assert(chat[1].text.startsWith('[-> builder_a] [接受协作]'));
        assert(chat[2].text.startsWith('[-> builder_b] [交接'));
    } finally { f.runtime.close(); }
}
{
    const f = fixture(TEAM_PRESETS.blackboard());
    const board = name => f.call(name, 'context', { runId: 'run' }).tasks;
    const dispatch = (area, prep, x) => {
        const record = board('lead').find(item => item.to === prep);
        if (record.status !== 'completed') return null;
        return f.call('lead', 'delegate', delegate('finish-' + area, 'finisher', [[x,0,0]], {
            description: '依据准备条目 ' + record.id + '：' + record.summary
        }));
    };
    try {
        f.call('lead', 'delegate', delegate('prep-a', 'prep_a', [[0,0,0]]));
        f.call('lead', 'delegate', delegate('prep-b', 'prep_b', [[4,0,0]]));
        const a = f.call('prep_a', 'take_task').task;
        const b = f.call('prep_b', 'take_task').task;
        f.call('prep_a', 'task_result', { ...scopeOf(a), status: 'blocked', summary: 'A 区入口被挡，坐标 0,0,0' });
        f.finish('prep_b', b, 1);
        assert.deepEqual(board('finisher').map(task => [task.key, task.status]), [['prep-a', 'blocked'], ['prep-b', 'completed']]);
        assert.match(board('finisher')[0].summary, /入口被挡/);
        assert.equal(board('finisher')[1].evidence[0].remaining, 0);
        assert.equal(dispatch('a', 'prep_a', 1), null);
        dispatch('b', 'prep_b', 5);
        const finishB = f.call('finisher', 'take_task').task;
        assert.match(finishB.description, new RegExp(b.id));
        f.finish('finisher', finishB, 1);
        f.call('lead', 'reassign', { runId: 'run', taskId: a.id, recipient: 'prep_a' });
        f.finish('prep_a', f.call('prep_a', 'take_task').task, 1);
        dispatch('a', 'prep_a', 1);
        f.finish('finisher', f.call('finisher', 'take_task').task, 1);
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
    } finally { f.runtime.close(); }
}
{
    const f = fixture(TEAM_PRESETS.swarm());
    try {
        f.call('lead', 'delegate', delegate('area-a', 'builder_a', [[0,0,0], [1,0,0]]));
        f.call('lead', 'delegate', delegate('area-b', 'builder_b', [[2,0,0], [3,0,0], [4,0,0]]));
        f.call('lead', 'delegate', delegate('area-c', 'builder_c', [[5,0,0], [6,0,0], [7,0,0]]));
        const a = f.call('builder_a', 'take_task').task;
        const b = f.call('builder_b', 'take_task').task;
        const c = f.call('builder_c', 'take_task').task;
        const broadcast = { runId: 'run', text: 'A 区已经验收，邻区有需要可找我。' };
        const chat = [];
        const transcript = createTeamTranscript({ snapshot: () => f.runtime.snapshot(), log: () => {},
            notify: (speaker, text) => chat.push([speaker, text]) });
        transcript('builder_a', 'message', broadcast, f.call('builder_a', 'message', broadcast));
        assert.deepEqual(chat, [['builder_a', '[-> lead、builder_b] ' + broadcast.text]]);
        assert.throws(() => f.call('builder_a', 'message', { ...broadcast, recipient: 'builder_c' }), /连线/);
        f.finish('builder_a', a, 2);
        const offer = f.call('builder_b', 'propose_share', delegate('assist-neighbor', 'builder_a', [[2,0,0]], scopeOf(b))).proposal;
        f.call('builder_a', 'respond_share', { runId: 'run', proposalId: offer.id, accept: true });
        f.call('builder_b', 'commit_share', { ...scopeOf(b), proposalId: offer.id });
        const assistance = f.call('builder_a', 'take_task').task;
        assert.equal(assistance.parentId, b.id);
        assert.equal(f.runtime.snapshot().tasks.find(task => task.id === c.id).status, 'running');
        f.finish('builder_a', assistance, 1);
        f.finish('builder_b', b, 3);
        f.finish('builder_c', c, 3);
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
    } finally { f.runtime.close(); }
}



// A task description naming the upper layer does not grant that layer.
{
    const oldChain = TEAM_PRESETS.centralized();
    oldChain.edges = [{ from: 'lead', to: 'builder_1', description: '委托完整工作' },
        { from: 'builder_1', to: 'builder_2', description: '正式转派子任务' }];
    const f = fixture(oldChain, ':memory:', false);
    try {
        const pyramid = { ...assignment, blueprint: compileBlueprint({ shapes: [
            { kind: 'box', part: 'base', min: [0,0,0], max: [1,0,0], block: 'stone' },
            { kind: 'point', part: 'upper', at: [0,1,0], block: 'stone' }
        ] }, [0,0,0]) };
        f.call('lead', 'publish', { runId: 'run', previousVersion: 0, assignment: pyramid });
        f.call('lead', 'delegate', delegate('base-only', 'builder_1', undefined, { description: '建底层，并把 part-2 交给 builder_2' }));
        const base = f.call('builder_1', 'take_task').task;
        assert.throws(() => f.call('builder_1', 'delegate', delegate('upper', 'builder_2', undefined,
            { ...scopeOf(base), partIds: ['part-2'] })), /自己施工范围以外/);
        f.finish('builder_1', base, 2);
        f.call('lead', 'delegate', delegate('whole-chain', 'builder_1', undefined, { partIds: ['part-1', 'part-2'] }));
        const parent = f.call('builder_1', 'take_task').task;
        f.call('builder_1', 'delegate', delegate('upper', 'builder_2', undefined,
            { ...scopeOf(parent), partIds: ['part-2'] }));
        const upper = f.call('builder_2', 'take_task').task;
        assert.equal(upper.parentId, parent.id);
        assert.deepEqual(upper.partIds, ['part-2']);
        f.call('builder_2', 'task_result', { ...scopeOf(upper), status: 'completed', summary: '上层验收通过',
            evidence: [{ partId: 'part-2', total: 1, remaining: 0 }] });
        f.call('builder_1', 'task_result', { ...scopeOf(parent), status: 'completed', summary: '底层和上层验收通过',
            evidence: [{ partId: 'part-1', total: 2, remaining: 0 }, { partId: 'part-2', total: 1, remaining: 0 }] });
        assert.equal(f.call('lead', 'finish_run', { runId: 'run' }).status, 'completed');
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

// Entry can wait for teammate replies on either side of blueprint publication.
{
    const config = TEAM_PRESETS.peers();
    const channel = new EventEmitter();
    const inbox = [];
    channel.connected = true;
    let status = 'thinking';
    let reason = '';
    let resumed = 0;
    let sharedBlueprint = null;
    const received = [];
    channel.send = (message, callback) => {
        const { method, args, id } = message;
        const result = method === 'inbox' ? [...inbox] : null;
        if (method === 'ack') {
            for (const ack of args.ids) inbox.splice(inbox.findIndex(event => event.id === ack), 1);
        }
        queueMicrotask(() => channel.emit('message', { type: 'team_response', id, result }));
        callback?.();
    };
    const errors = [];
    const client = createTeamClient({ name: 'arch_1', spec: config, channel, onError: error => errors.push(error) });
    const receive = (id, kind = 'message', runId = 'run') => inbox.push({ id, from: 'arch_2', kind, runId });
    async function until(condition) {
        const deadline = Date.now() + 3500;
        while (!condition()) {
            assert(Date.now() < deadline, 'timed out waiting for team communication');
            await new Promise(resolve => setTimeout(resolve, 30));
        }
    }
    try {
        receive('arrives-early');
        client.attach({
            status: () => status,
            stop: async () => {},
            canAcceptTask: () => false,
            snapshot: () => ({ teamRunId: 'run', assignment: sharedBlueprint, result: { reason } }),
            receiveTeamEvent: async event => { received.push(event.id); return true; },
            resume: async () => { resumed++; status = 'thinking'; }
        });
        await until(() => received.includes('arrives-early'));
        status = 'waiting_user';
        reason = '【等队友】待收协作方案';
        await until(() => resumed === 1);
        status = 'waiting_user';
        receive('not-a-reply', 'task_result');
        await until(() => received.includes('not-a-reply'));
        assert.equal(resumed, 1);
        sharedBlueprint = assignment;
        reason = '【等队友】蓝图已发布，等待分工确认';
        receive('arrives-late');
        await until(() => resumed === 2);
        status = 'waiting_user';
        reason = '需要用户选择施工位置';
        receive('during-user-question');
        await until(() => received.includes('during-user-question'));
        assert.equal(resumed, 2, 'a genuine player question stays pending');
        assert.deepEqual(errors, []);
    } finally { client.close(); }
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
    vm.runInContext(script.slice(script.indexOf("$('#convertRelationships').onclick"), script.indexOf("document.addEventListener('keydown'")), context);
    vm.runInContext(script.slice(script.indexOf('function graphToSpec('), script.indexOf("$('#teamEditor').onblur")), context);
    context.spec = structuredClone(spec);
    vm.runInContext('specToGraph(spec); result = graphToSpec()', context);
    assert.deepEqual(JSON.parse(JSON.stringify(context.result.edges)), spec.edges);
    assert.deepEqual(JSON.parse(JSON.stringify(context.result.agents.manager.permissions)), spec.agents.manager.permissions);
    assert(context.result.coordination === 'relationships');
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

// A discussion can end after publication and yield to an already queued build task.
{
    const peers = TEAM_PRESETS.peers();
    const f = fixture(peers);
    const channel = new EventEmitter();
    channel.connected = true;
    const errors = [];
    channel.send = ({ method, args, id }, callback) => {
        let response;
        try { response = { result: f.call('arch_2', method, args) }; }
        catch (error) { response = { error: error.message }; }
        queueMicrotask(() => channel.emit('message', { type: 'team_response', id, ...response }));
        callback?.();
    };
    const client = createTeamClient({ name: 'arch_2', spec: peers, channel, onError: error => errors.push(error.message) });
    const states = [];
    try {
        f.call('arch_1', 'message', { runId: 'run', recipient: 'arch_2', text: '【协商定稿】接受你提出的分工。' });
        const { taskId } = f.call('arch_1', 'delegate', delegate('agreed-section', 'arch_2', [[0,0,0], [1,0,0]]));
        const controller = createBuildingLoop({
            team: client, peers: client.peers, agentName: 'arch_2',
            world: {
                snapshot: () => ({ dimension: 'overworld', gameMode: 'creative', position: [0,0,4] }),
                read: ([x,y,z]) => y < 0 || (y === 0 && z === 0 && (x === 0 || x === 1)) ? 'stone' : 'air'
            },
            async save(id, type, state) {
                if (type === 'state' && state.status === 'completed') {
                    states.push({ coordination: state.teamCoordination === true, outcome: state.result?.outcome });
                }
            },
            model: { async sendRequest(turns) {
                const context = JSON.parse(turns[0].content);
                if (context.coordinationOnly) return JSON.stringify({ action: 'end_turn' });
                if (!context.plan.steps.length) return JSON.stringify({ action: 'update_plan', steps: [
                    { id: 'verify', title: '核验范围', success: '两格均为石头', status: 'done', evidence: '实测两格均为石头' }
                ] });
                return JSON.stringify({ action: 'complete_task', summary: '两格现场验收通过' });
            } }
        });
        client.attach(controller);
        const deadline = Date.now() + 5000;
        while (f.runtime.snapshot().tasks[0].status !== 'completed' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        const [task] = f.runtime.snapshot().tasks;
        assert.equal(task.id, taskId);
        assert.equal(task.status, 'completed');
        assert.equal(task.attempt, 1);
        assert(states.some(state => state.coordination && state.outcome === 'conversation'));
        assert.equal(controller.snapshot().assignmentVersion, 1);
        assert.deepEqual(errors, []);
    } finally { client.close(); f.runtime.close(); }
}



// Peers 模式：设计者由协商推选。任何有 design_blueprint 权限的成员（含非 entry）都能
// publish；entry 拿到别人发布的蓝图后立即可派单（context 同步共享蓝图）。
{
    const peers = TEAM_PRESETS.peers(['arch_1', 'arch_2', 'arch_3']);
    assert(actionAllowed(peers, 'arch_2', 'design_blueprint').allowed, 'peer members can all design');
    assert(capabilities(peers, 'arch_1').finishGate && !capabilities(peers, 'arch_2').finishGate, 'only the entry gates final acceptance');
    const f = fixture(peers, ':memory:', false);
    try {
        // entry 先广播协商，推选 arch_2 设计
        f.call('arch_1', 'message', { runId: 'run', recipient: 'arch_2', text: '场地平坦，请你设计蓝图。' });
        const [talk] = f.call('arch_2', 'inbox');
        assert.equal(talk.kind, 'message');
        f.call('arch_2', 'ack', { ids: [talk.id] });
        // 非权威成员（voting 的 voter 角色）仍被拒；arch_2 被推选后可以发布
        assert.deepEqual(f.call('arch_2', 'publish', { runId: 'run', previousVersion: 0, assignment }), { assignmentVersion: 1 });
        // entry 未自己发布，但 context 已同步共享蓝图，可立即派单
        const entryContext = f.call('arch_1', 'context', { runId: 'run' });
        assert.equal(entryContext.blueprintVersion, 1);
        assert(entryContext.sharedAssignment, 'context materializes the peer-published blueprint');
        const dispatch = f.call('arch_1', 'delegate', delegate('north', 'arch_2', [[0,0,0], [1,0,0]]));
        assert(dispatch.taskId, 'entry dispatches against a blueprint another member published');
        const worker = f.call('arch_2', 'take_task').task;
        f.finish('arch_2', worker, 2);
        assert.equal(f.call('arch_1', 'finish_run', { runId: 'run' }).status, 'completed');
    } finally { f.runtime.close(); }
}
// 非设计成员发布仍被拒（voting preset 的 voter 无 design_blueprint 权限）
{
    const voting = TEAM_PRESETS.voting();
    const f = fixture(voting, ':memory:', false);
    try {
        assert.throws(() => f.call('voter_1', 'publish', { runId: 'run', previousVersion: 0, assignment }), /蓝图设计权限|design_blueprint/);
    } finally { f.runtime.close(); }
}

console.log('Relationship teams passed: natural-language graph, explicit permissions, recursive delegation, scope fencing, dependencies, IPC/checkpoints, recovery, persistence, model context and canvas round trips.');
