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
    assert.equal(validateTeamSpec(preset(['alpha', 'beta', 'gamma'])).ok, true, name + ' 预设应有效');
}
assert.equal(validateTeamSpec(TEAM_PRESETS.pipeline(['alpha', 'beta'])).ok, true);
{
    const disconnected = validateTeamSpec({ agents: { a: { role: 'builder' }, b: { role: 'builder' }, c: { role: 'builder' } },
        edges: [{ from: 'a', to: 'b', type: 'message' }], rules: {} });
    assert(!disconnected.ok && disconnected.errors.some(e => e.includes('不连通')));
    const cyclic = validateTeamSpec({ agents: { a: { role: 'builder' }, b: { role: 'builder' } },
        edges: [{ from: 'a', to: 'b', type: 'delegate' }, { from: 'b', to: 'a', type: 'delegate' }], rules: {} });
    assert(!cyclic.ok && cyclic.errors.some(e => e.includes('环')));
    const leadless = validateTeamSpec({ agents: { a: { role: 'builder' }, b: { role: 'builder' } },
        edges: [{ from: 'a', to: 'b', type: 'message' }], rules: { finish: 'lead-gates' } });
    assert(!leadless.ok && leadless.errors.some(e => e.includes('lead')));
    assert(!validateTeamSpec({ agents: { a: { role: 'wizard' } }, edges: [], rules: {} }).ok);
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
    const spec = { agents: { alpha: { role }, beta: { role: 'builder' } },
        edges: [{ from: 'beta', to: 'alpha', type: 'message' }],
        rules: { assignment: 'first-claim', handoff: 'agent-driven', finish: 'any-gates' } };
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

console.log('Team coordination checks passed: lease tools in catalog, spec validation and presets, role permissions, lease exclusivity/TTL, tool-layer gating with and without a team.');
