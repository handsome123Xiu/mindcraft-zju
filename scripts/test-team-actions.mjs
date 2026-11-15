import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAction } from '../src/building/action-protocol.js';
import { createBuildingTools, TOOL_CATALOG } from '../src/building/tools.js';
import { compileBlueprint } from '../src/building/blueprint.js';
import { validateTeamSpec, TEAM_PRESETS, actionAllowed, roleOf,
    claimPart, releasePart, queryClaims } from '../src/building/team-state.js';

// Catalog and schemas expose the lease tools.
assert.deepEqual(['claim_part', 'release_part', 'query_claims'].map(name =>
    TOOL_CATALOG.find(tool => tool.name === name)?.name), ['claim_part', 'release_part', 'query_claims']);
parseAction('{"action":"tool","name":"claim_part","args":{"partId":"part-1"}}');
parseAction('{"action":"tool","name":"query_claims","args":{}}');

// Spec validation: presets pass, broken graphs fail with named errors.
for (const [name, preset] of Object.entries(TEAM_PRESETS)) {
    const names = name === 'voting' ? ['alpha', 'beta', 'gamma', 'delta'] : ['alpha', 'beta', 'gamma'];
    assert.equal(validateTeamSpec(preset(names)).ok, true, name + ' 预设应有效');
}
assert.equal(validateTeamSpec(TEAM_PRESETS.hierarchy(['alpha', 'beta'])).ok, true);
{
    const disconnected = validateTeamSpec({ ...TEAM_PRESETS.centralized(['a', 'b', 'c']),
        edges: [{ from: 'a', to: 'b', description: '共同施工' }] });
    assert(!disconnected.ok && disconnected.errors.some(e => e.includes('不连通')));
    const graph = TEAM_PRESETS.peers(['a', 'b', 'c']);
    assert(validateTeamSpec(graph).ok, 'communication cycles are valid');
    const duplicate = validateTeamSpec({ ...graph, edges: [...graph.edges, { from: 'b', to: 'a', description: '重复关系' }] });
    assert(!duplicate.ok && duplicate.errors.some(e => e.includes('一条关系')));
    const leadless = validateTeamSpec({ ...graph, agents: { ...graph.agents, a: { role: 'builder' } } });
    assert(!leadless.ok && leadless.errors.some(e => e.includes('入口')));
    assert(!validateTeamSpec({ coordination: 'relationships', agents: { a: { role: 'wizard' } }, edges: [] }).ok);
}

// Role permissions: lead all, builder no design, inspector read-only.
{
    const spec = TEAM_PRESETS.centralized(['alpha', 'beta']);
    assert.equal(actionAllowed(spec, 'alpha', 'place_block').allowed, true);
    assert.equal(actionAllowed(spec, 'alpha', 'design_blueprint').allowed, true);
    assert.equal(actionAllowed(spec, 'beta', 'place_block').allowed, true);
    assert.equal(actionAllowed(spec, 'beta', 'design_blueprint').allowed, false);
    const inspecting = TEAM_PRESETS.centralized(['alpha', 'beta', 'gamma']);
    inspecting.agents.gamma = { role: 'inspector' };
    assert.equal(actionAllowed(inspecting, 'gamma', 'inspect_part').allowed, true);
    assert.equal(actionAllowed(inspecting, 'gamma', 'place_block').allowed, false);
    assert.equal(actionAllowed(inspecting, 'gamma', 'set_demolition_target').allowed, false);
    assert.equal(roleOf(inspecting, 'gamma').name, 'inspector');
}

// Lease table: exclusivity, self-reclaim, release, expiry.
{
    const dir = await mkdtemp(join(tmpdir(), 'claims-'));
    assert.equal((await claimPart(dir, 'alpha', 'part-1')).status, 'claimed');
    const conflict = await claimPart(dir, 'beta', 'part-1');
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.owner, 'alpha');
    // 自己可以续租。
    assert.equal((await claimPart(dir, 'alpha', 'part-1')).status, 'claimed');
    // 别人不能释放我的租约。
    assert.equal((await releasePart(dir, 'beta', 'part-1')).status, 'conflict');
    assert.equal((await releasePart(dir, 'alpha', 'part-1')).status, 'released');
    assert.equal((await claimPart(dir, 'beta', 'part-1')).status, 'claimed');
    // TTL 过期后可被抢走。
    await claimPart(dir, 'beta', 'part-2', { ttlMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await claimPart(dir, 'alpha', 'part-2')).status, 'claimed');
    assert.equal(Object.keys((await queryClaims(dir)).claims).length, 2);
    await rm(dir, { recursive: true, force: true });
}

// Tool layer with a team spec: builder cannot design, inspector cannot place,
// placement on a teammate-leased part is rejected, claim enables it again.
function fixture({ role = 'builder', othersHeld = {} } = {}) {
    const blocks = new Map();
    const world = {
        read: pos => blocks.get(pos.join(',')) ?? (pos[1] < 0 ? 'stone' : 'air'),
        snapshot: () => ({ dimension: 'overworld', position: [0, 0, 4], gameMode: 'creative' }),
        async prepare() {}, inspectBlock: () => ({ status: 'observed' }), async lookAt() { return {}; },
        async place(cell) { blocks.set(cell.pos.join(','), cell.block); return 'placed'; }
    };
    const blueprint = compileBlueprint({ shapes: [{ kind: 'box', part: '地板', min: [0, 0, 0], max: [1, 0, 0], block: 'stone' }] }, [0, 0, 0]);
    const job = { origin: [0, 0, 0], dimension: 'overworld', owner: 'user', placed: {}, removed: {}, placementAttempts: 0,
        assignment: { version: 1, dimension: 'overworld', blueprint }, assignmentVersion: 1,
        plan: { requirements: [{ id: 'goal', description: '团队测试' }], steps: [] }, events: [] };
    const spec = { coordination: 'relationships', entryAgent: 'beta', agents: { alpha: { role }, beta: { role: 'lead' } },
        edges: [{ from: 'beta', to: 'alpha', description: '协作施工' }] };
    const claims = { version: 1, claims: othersHeld };
    const team = {
        self: 'alpha',
        spec: () => spec,
        claim: (partId, assignmentVersion) => Promise.resolve(claims.claims[partId]?.owner === 'alpha'
            ? { status: 'claimed', partId } : claims.claims[partId] ? { status: 'conflict', partId, owner: claims.claims[partId].owner }
            : (claims.claims[partId] = { partId, owner: 'alpha', expiresAt: Date.now() + 300000, assignmentVersion }, { status: 'claimed', partId })),
        release: partId => (delete claims.claims[partId], Promise.resolve({ status: 'released', partId })),
        queryClaims: () => Promise.resolve(claims)
    };
    const tools = createBuildingTools({ world, job, team });
    return { tools, job, claims, blocks };
}

{
    const builder = fixture();
    await assert.rejects(builder.tools.useSkill('design_blueprint', {}), /lead 统一设计/);
    const inspector = fixture({ role: 'inspector' });
    await assert.rejects(inspector.tools.call('place_block', { position: [0, 0, 0], block: 'stone' }), /团队角色 inspector 不允许/);
    // beta 持有 part-1 租约时，alpha 施工该部件被拒；claim 抢不到（conflict 由模型换部件）。
    const blocked = fixture({ othersHeld: { 'part-1': { partId: 'part-1', owner: 'beta', expiresAt: Date.now() + 300000 } } });
    await assert.rejects(blocked.tools.call('place_block', { position: [0, 0, 0], block: 'stone', partId: 'part-1' }), /正被队友 beta 认领/);
    assert.equal((await blocked.tools.call('claim_part', { partId: 'part-1' })).status, 'conflict');
    // 正常路径：claim → place → release。
    const happy = fixture();
    assert.equal((await happy.tools.call('claim_part', { partId: 'part-1' })).status, 'claimed');
    assert.equal((await happy.tools.call('place_block', { position: [0, 0, 0], block: 'stone', partId: 'part-1' })).status, 'completed');
    assert.equal((await happy.tools.call('release_part', { partId: 'part-1' })).status, 'released');
    assert.equal(Object.keys((await happy.tools.call('query_claims')).claims).length, 0);
    // 无团队时所有行为照旧。
    const solo = createBuildingTools({ world: {
        read: () => 'air', snapshot: () => ({ dimension: 'overworld', position: [0, 0, 4], gameMode: 'creative' }),
        async prepare() {}, inspectBlock: () => ({ status: 'observed' }), async lookAt() { return {}; }
    }, job: { origin: [0, 0, 0], dimension: 'overworld', owner: 'user', placed: {}, removed: {}, placementAttempts: 0,
        assignment: { version: 1, dimension: 'overworld', blueprint: compileBlueprint({ shapes: [{ kind: 'point', at: [0, 0, 0], block: 'stone' }] }, [0, 0, 0]) }, assignmentVersion: 1,
        plan: { requirements: [{ id: 'goal', description: 'x' }], steps: [] }, events: [] } });
    assert.equal((await solo.call('query_claims')).claims !== undefined, true);
}

// 团队生命周期事件进短 teamFeed 而不是聊天窗口；真人消息仍进 messages 且更紧凑。
{
    const { createBuildingLoop } = await import('../src/building/loop-agent.js');
    const files = new Map();
    const controller = createBuildingLoop({ world: {
        read: () => 'air', snapshot: () => ({ dimension: 'overworld', position: [0, 0, 4], gameMode: 'creative' }), async prepare() {}
    }, model: { async sendRequest() { return JSON.stringify({ action: 'blocked', reason: 'fixture' }); } },
        async save(id, type, data) { files.set(type, structuredClone(data)); } });
    controller.restore({ version: 1, kind: 'building-loop', id: 'feed-run', teamRunId: 'feed-run', request: 'build', owner: 'tester',
        origin: [0,0,0], dimension: 'overworld', status: 'waiting_team', inputRevision: 0,
        messages: [{ role: 'user', from: 'tester', content: 'build' }], clarifications: [],
        teamEvents: [], teamFeed: [], plan: { requirements: [{ id: 'goal', description: 'build' }], steps: [] },
        placed: {}, removed: {}, events: [], modelRequests: 0, decisions: 0, elapsedMs: 0,
        placementAttempts: 0, assignmentVersion: 0, demolitionAttempts: 0, removalCount: 0 });
    const receive = controller.receiveTeamEvent;
    for (let i = 0; i < 15; i++) await receive({ id: 'e' + i, runId: 'feed-run', kind: 'task_status', from: 'runtime', payload: { reason: '生命周期事件 ' + i + ' ' + '长'.repeat(200) } });
    const snapshot = controller.snapshot();
    assert.equal(snapshot.messages.length, 1, '生命周期事件不进聊天窗口');
    assert.equal(snapshot.teamFeed.length, 12, 'feed 保留最近 12 条');
    assert(snapshot.teamFeed.at(-1).text.length <= 160);
    assert(snapshot.teamFeed.at(-1).text.includes('task_status'), 'feed 文本保留事件 kind 标识');
    await receive({ id: 'msg1', runId: 'feed-run', kind: 'message', from: 'beta', payload: { text: '你好，这里能施工吗？'.repeat(40) } });
    const after = controller.snapshot();
    assert.equal(after.messages.length, 2, '队友消息仍进聊天窗口');
    assert(after.messages.at(-1).content.length <= 300, '队友消息截断到 300 字符');
    assert.equal(after.teamFeed.length, 12, '真人消息不进 feed');
}

// 复现 pyramid 死锁：builder_2 范围 45/45 已验收却 wait_for_team 等一个不会发给
// 执行者的 task_result 事件。守卫必须拒绝等待并指路 complete_task。
{
    const { createBuildingLoop } = await import('../src/building/loop-agent.js');
    const { compileBlueprint } = await import('../src/building/blueprint.js');
    const assignment = { version: 1, dimension: 'overworld',
        blueprint: compileBlueprint({ shapes: [{ kind: 'point', at: [0, 0, 0], part: 'base', block: 'stone' }] }, [0, 0, 0]) };
    const blocks = new Map([['0,0,0', 'stone']]);
    const script = [
        JSON.stringify({ action: 'wait_for_team', reason: '等 pyr-b1 完成再做上层' }),
        JSON.stringify({ action: 'update_plan', steps: [{ id: 's1', title: '施工', success: '45 格全部验收', status: 'done', evidence: 'inspect verified 45/45' }] }),
        JSON.stringify({ action: 'complete_task', summary: '底层东半完成' })];
    const calls = [];
    const controller = createBuildingLoop({ world: {
        read: pos => blocks.get(pos.join(',')) ?? 'air',
        snapshot: () => ({ dimension: 'overworld', position: [0, 0, 4], gameMode: 'creative' }), async prepare() {}
    }, model: { async sendRequest(turns) { calls.push(turns); return script.shift() ?? JSON.stringify({ action: 'blocked', reason: 'end' }); } },
        team: { self: 'builder_2', runtime: true, spec: () => ({ coordination: 'relationships', agents: {}, edges: [] }),
            async refresh(job) { job.teamContext = { tasks: [{ id: 'other', status: 'running', to: 'builder_1', dependsOn: [], parentId: null }] }; } },
        async save() {} });
    controller.restore({ version: 1, kind: 'building-loop', id: 'dead-run', teamRunId: 'dead-run',
        request: '底层东半', owner: 'tester', origin: [0,0,0], dimension: 'overworld', status: 'waiting_user',
        messages: [{ role: 'user', from: 'tester', content: '底层东半' }], clarifications: [],
        teamEvents: [], teamFeed: [], assignment, assignmentVersion: 1, design: { origin: [0,0,0] },
        teamTask: { id: 'pyr-b2', partIds: ['part-1'], from: 'lead', success: '45 格',
            scope: { positions: [[0,0,0]] }, workScope: { positions: [[0,0,0]] } },
        plan: { requirements: [{ id: 'goal', description: '底层东半' }], steps: [] },
        placed: { '0,0,0': 'stone' }, removed: {}, events: [], modelRequests: 0, decisions: 0, elapsedMs: 0,
        placementAttempts: 1, demolitionAttempts: 0, removalCount: 0 });
    const result = await controller.resume();
    assert.equal(result.status, 'completed', 'wait_for_team 被拒绝并指路 complete_task，任务正常完成');
    const feedbacks = controller.snapshot().events.filter(e => e.kind === 'feedback');
    assert(feedbacks.some(e => String(e.output?.message ?? '').includes('complete_task')), '守卫反馈指明 complete_task');
    assert(feedbacks.some(e => String(e.output?.message ?? '').includes('后续层属于其他排队任务')), '反馈说明范围外层不是完成条件');
}

// 自定义协作范式：内联 permissions、自由角色名、能力锚定校验、kind 边。
{
    const { validateTeamSpec, capabilities, roleOf } = await import('../src/building/team-state.js');
    // 合法自定义 spec：军师（只读白名单）+ 全权 chief + builder，kind 边带标签。
    const custom = { coordination: 'relationships', agents: {
        chief: { role: 'chief', permissions: { allow: ['*'], deny: [], blueprintAuthority: true, finishGate: true } },
        advisor: { role: 'advisor', permissions: { allow: ['observe_environment', 'send_message'], whitelistOnly: true } },
        w1: { role: 'builder' } },
        edges: [{ from: 'chief', to: 'w1', description: 'chief 分配工作，w1 执行并汇报', label: '师徒' },
            { from: 'chief', to: 'advisor', description: 'chief 向 advisor 咨询意见', label: '问策' }], entryAgent: 'chief' };
    const ok = validateTeamSpec(custom);
    assert(ok.ok, '合法自定义 spec 通过：' + ok.errors.join(';'));
    assert.deepEqual(capabilities(custom, 'chief'), { name: 'chief', canBuild: true, canDelegate: true, blueprintAuthority: true, finishGate: true });
    assert.equal(capabilities(custom, 'advisor').canBuild, false, '白名单军师无施工权');
    assert.equal(roleOf(custom, 'advisor').allow.includes('design_blueprint'), false, '白名单不隐含设计权');
    assert.equal(roleOf(custom, 'chief').name, 'chief', '自定义角色名保留');

    // 非法：自定义角色无 permissions；未知工具名；lead-gates 无 finishGate 持有者。
    const bad1 = validateTeamSpec({ agents: { a: { role: 'wizard' } }, edges: [] });
    assert(bad1.errors.some(e => e.includes('permissions')), '自定义角色必须带 permissions');
    const bad2 = validateTeamSpec({ agents: { a: { role: 'x', permissions: { allow: ['not_a_tool'], whitelistOnly: true } } }, edges: [] });
    assert(bad2.errors.some(e => e.includes('未知工具')), '未知工具名被拒绝');
    const bad3 = validateTeamSpec({ coordination: 'relationships', agents: { a: { role: 'builder' } }, edges: [] });
    assert(bad3.errors.some(e => e.includes('全局验收')), 'lead-gates 锚定 finishGate 而非 lead 头衔');

    const old = { agents: { l: { role: 'lead' }, w: { role: 'builder' } },
        edges: [{ from: 'l', to: 'w', type: 'delegate' }] };
    assert(!validateTeamSpec(old).ok, 'old graphs must cross the explicit migration boundary');
    const coleads = TEAM_PRESETS.peers(['l1', 'l2', 'w']);
    coleads.agents.l2 = { role: 'lead' };
    assert(validateTeamSpec(coleads).ok, 'role titles do not decide the project entry');
    assert(!validateTeamSpec({ ...coleads, rules: { finish: 'any-gates' } }).ok, 'old rule enums are rejected');

}

console.log('Team coordination checks passed: lease tools in catalog, spec validation and presets, role permissions, lease exclusivity/TTL, tool-layer gating with and without a team.');
