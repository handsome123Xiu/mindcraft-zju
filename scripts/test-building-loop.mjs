import assert from 'node:assert/strict';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { parseBuildMessage } from '../src/building/chat-input.js';
import { formatTokenUsage } from '../src/building/token-usage.js';

const request = '建造两格石头平台';
const task = { request, origin: [0, 0, 0], dimension: 'overworld', owner: 'tester' };
const plan = (done = false) => ({ action: 'update_plan', steps: [{ id: 's1', title: '建造并验收石头平台',
    success: '两格石头均在指定位置', status: done ? 'done' : 'running',
    evidence: done ? '独立验收读取两个坐标均为 stone，周围预期空位一致' : '' }] });
const observe = { action: 'tool', name: 'observe_environment', args: { region: { min: [-3, -1, -3], max: [6, 8, 6] } } };
const skill = { action: 'skill', name: 'design_blueprint', args: {} };
const geometry = (shapes = [{ kind: 'box', min: [0, 0, 0], max: [1, 0, 0], block: 'stone' }]) => ({
    shapes, summary: '两格石头平台', coverage: [{ requirementId: 'goal', evidence: '底层 x=0..1 放置 stone，满足两格石头平台' }]
});
const row = (length = 2) => ({ action: 'tool', name: 'place_row', args: { start: [0, 0, 0], end: [length - 1, 0, 0], block: 'stone' } });
const inspect = { action: 'tool', name: 'inspect_build', args: {} };
const finish = { action: 'finish', summary: '平台已完成', requirementReview: [
    { requirementId: 'goal', satisfied: true, evidence: '蓝图为两个 stone 坐标，现场独立读取 2/2 一致' }
] };
const modelAssertions = [];

function harness(script, options = {}) {
    const blocks = options.blocks ?? new Map();
    const files = new Map();
    const reports = [];
    const calls = [];
    const world = {
        snapshot: () => ({ dimension: 'overworld', position: [0, 0, 2], gameMode: 'creative' }),
        read: pos => blocks.get(pos.join(',')) ?? (pos[1] < 0 ? 'stone' : 'air'),
        async prepare() {},
        async moveTo() { return true; },
        inspectBlock: pos => ({ status: 'observed', position: pos, block: world.read(pos), properties: {} }),
        async lookAt() { return { yaw: 0.2, pitch: 0.3 }; },
        async digBlock(pos) { blocks.set(pos.join(','), 'air'); return 'removed'; },
        async place(cell) { blocks.set(cell.pos.join(','), cell.block); return 'placed'; },
        ...options.world
    };
    const model = {
        modelName: 'scripted-offline-model',
        async sendRequest(turns, instructions, stop, context) {
            try {
                const isSkill = instructions.includes('You are the blueprint design skill');
                const item = script.shift();
                calls.push({ isSkill, turns, instructions, context });
                if (options.usage) context.onUsage?.(options.usage({ isSkill, call: calls.length }));
                if (!item) return JSON.stringify({ action: 'blocked', reason: '测试脚本已结束' });
                if (typeof item === 'function') return await item({ turns, instructions, context, isSkill, calls, blocks, files });
                assert.equal(isSkill, !!item.shapes, 'script must distinguish loop decisions from skill calls');
                return typeof item === 'string' ? item : JSON.stringify(item);
            } catch (error) {
                if (error.code === 'ERR_ASSERTION') modelAssertions.push(error.message);
                throw error;
            }
        }
    };
    const agent = createBuildingLoop({ world, model,
        save: async (id, type, data) => files.set(type, structuredClone(data)),
        report: (event, data) => reports.push({ event, data: structuredClone(data) }), ...options.limits });
    return { agent, world, blocks, files, reports, calls, model };
}

// The blueprint skill repairs the rejected draft before returning to the main loop.
// The agent still chooses separate primitives, and an early finish is rejected.
{
    const h = harness([
        observe, plan(), skill, geometry([{ kind: 'box', min: [0, -1, 0], max: [1, -1, 0], block: 'stone' }]),
        ({ turns, isSkill }) => {
            assert.equal(isSkill, true);
            const { blueprintRepair } = JSON.parse(turns[1].content);
            assert.equal(blueprintRepair.field, 'shapes[0].min');
            assert.match(blueprintRepair.message, /基准面下方/);
            assert.equal(JSON.parse(blueprintRepair.rejectedDraft).shapes[0].min[1], -1);
            return JSON.stringify(geometry());
        },
        row(1), finish, row(), inspect, plan(true), finish
    ]);
    const result = await h.agent.start(task);
    assert.equal(result.status, 'completed');
    assert.equal(result.verified, 2);
    assert.equal(result.modelRequests, 11);
    assert.equal(result.decisions, 9);
    assert.equal(result.semanticVerification, 'model_reported');
    assert.equal(result.structuralVerification, 'machine_verified');
    const feedback = h.agent.snapshot().events.filter(event => event.kind === 'feedback');
    assert.equal(feedback.filter(event => event.output.status === 'error').length, 1);
    assert(feedback.some(event => event.name === 'place_row' && event.output.status === 'completed' && event.output.total === 1));
    assert(h.calls.filter(call => call.isSkill).every(call => JSON.parse(call.turns[0].content).originalGoal));
    assert(h.calls.at(-1).context.runId === result.runId);
    assert.equal(h.files.get('state').status, 'completed');
}

// Revision cannot discard completed geometry. The main model receives the rejection
// and can retry a compatible design while preserving the original task.
{
    const h = harness([observe, plan(), skill, geometry(), row(1), skill,
        geometry([{ kind: 'point', at: [1, 0, 0], block: 'stone' }]),
        skill, geometry(), row(), inspect, plan(true), finish]);
    const result = await h.agent.start(task);
    assert.equal(result.status, 'completed');
    assert(h.agent.snapshot().events.some(event => event.output?.message?.includes('必须保留已完成坐标')));
    assert.equal(h.agent.snapshot().assignmentVersion, 2);
    assert.equal(h.blocks.size, 2);
}

// The model composes rows, rectangles and cubes through distinct loop decisions.
// Completing a floor must not auto-build the other parts of the blueprint.
{
    const originalGoal = '建造石头地板、一排石头和一个玻璃立方体';
    const overallPlan = done => ({ action: 'update_plan', steps: [{ id: 's1', title: '组合三个放置动作并验收',
        success: '9 格地板、3 格排和 8 格玻璃立方体全部符合蓝图', status: done ? 'done' : 'running',
        evidence: done ? '独立验收读取全部 20 个方块及预期空位一致' : '' }] });
    const design = geometry([
        { kind: 'box', min: [0, 0, 0], max: [2, 0, 2], block: 'stone' },
        { kind: 'box', min: [0, 0, 3], max: [2, 0, 3], block: 'stone' },
        { kind: 'box', min: [0, 1, 0], max: [1, 2, 1], block: 'glass' }
    ]);
    design.summary = '依次放置地板、石头排和玻璃立方体';
    design.coverage[0].evidence = '底层 3×3 石头地板，旁边 3 格石头排，上方 2×2×2 玻璃立方体';
    const h = harness([observe, overallPlan(false), skill, design,
        { action: 'tool', name: 'place_rectangle', args: { min: [0, 0, 0], max: [2, 0, 2], block: 'stone' } },
        ({ blocks, turns }) => {
            assert.equal(blocks.size, 9);
            assert.equal(JSON.parse(turns[0].content).lastPlacement.action, 'place_rectangle');
            return JSON.stringify({ action: 'tool', name: 'place_row', args: { start: [0, 0, 3], end: [2, 0, 3], block: 'stone' } });
        },
        { action: 'tool', name: 'place_cube', args: { origin: [0, 1, 0], size: 2, block: 'glass' } },
        inspect, overallPlan(true), { action: 'finish', summary: '三个部件均已建好并验收', requirementReview: [
            { requirementId: 'goal', satisfied: true, evidence: '全部 20 个目标方块和空位一致，三个部件均符合设计说明' }
        ] }
    ]);
    const result = await h.agent.start({ ...task, request: originalGoal });
    assert.equal(result.status, 'completed');
    assert.equal(result.verified, 20);
    assert.equal(result.modelRequests, 10);
    assert.deepEqual(h.agent.snapshot().events.filter(event => event.kind === 'feedback' &&
        event.name.startsWith('place_')).map(event => event.name), ['place_rectangle', 'place_row', 'place_cube']);
}

// A batch runs sequential tool steps in one decision; the first blocked or error
// step stops it and later steps are skipped, with per-step events journaled.
{
    const h = harness([observe, plan(), skill, geometry(),
        { action: 'batch', description: '铺两排地板', steps: [
            { name: 'place_row', args: { start: [0, 0, 0], end: [1, 0, 0], block: 'stone' } },
            { name: 'inspect_build' },
            { name: 'place_block', args: { position: [5, 0, 0], block: 'stone' } }
        ] },
        row(), inspect, plan(true), finish]);
    const result = await h.agent.start(task);
    assert.equal(result.status, 'completed');
    assert.equal(h.blocks.size, 2);
    const events = h.agent.snapshot().events;
    const batchFeedback = events.find(event => event.kind === 'feedback' && event.name === 'batch');
    assert.equal(batchFeedback.output.status, 'blocked');
    assert.equal(batchFeedback.output.executed, 3);
    assert.equal(batchFeedback.output.failedAt, 2);
    assert(events.some(event => event.kind === 'tool' && event.name === 'inspect_build'));
}

// A fully successful batch completes and its steps are journaled individually.
{
    const h = harness([observe, plan(), skill, geometry(),
        { action: 'batch', steps: [
            { name: 'place_row', args: { start: [0, 0, 0], end: [1, 0, 0], block: 'stone' } },
            { name: 'inspect_build' }
        ] },
        plan(true), finish]);
    const result = await h.agent.start(task);
    assert.equal(result.status, 'completed');
    const batch = h.agent.snapshot().events.find(event => event.kind === 'feedback' && event.name === 'batch');
    assert.equal(batch.output.status, 'completed');
    assert.equal(batch.output.executed, 2);
}

// All five basic actions are available in the actual loop. An obstacle appearing
// after site validation is inspected, explicitly removed and replaced.
{
    const blocks = new Map();
    const h = harness([observe, plan(), skill, geometry(),
        () => { blocks.set('0,0,0', 'glass'); return JSON.stringify({ action: 'tool', name: 'place_block', args: { position: [0, 0, 0], block: 'stone' } }); },
        { action: 'tool', name: 'inspect_block', args: { position: [0, 0, 0] } },
        { action: 'tool', name: 'look_at', args: { position: [0, 0, 0] } },
        { action: 'tool', name: 'dig_block', args: { position: [0, 0, 0], expectedBlock: 'glass' } },
        { action: 'tool', name: 'move_to', args: { position: [0, 0, 2] } },
        observe,
        { action: 'tool', name: 'place_block', args: { position: [0, 0, 0], block: 'stone' } },
        { action: 'tool', name: 'place_block', args: { position: [1, 0, 0], block: 'stone' } },
        inspect, plan(true), finish
    ], { blocks });
    const result = await h.agent.start(task);
    assert.equal(result.status, 'completed');
    assert.equal(result.removalCount, 1);
    assert.equal(result.demolitionAttempts, 1);
    assert.equal(result.verified, 2);
    const feedback = h.agent.snapshot().events.filter(event => event.kind === 'feedback');
    assert(feedback.some(event => event.name === 'place_block' && event.output.status === 'blocked'));
    assert(feedback.some(event => event.name === 'dig_block' && event.output.status === 'completed'));
    assert.deepEqual(h.files.get('state').removed, {});
}

// Removing a completed coordinate unlocks that coordinate for a revised design;
// the removed position must remain air when it falls outside the new blueprint.
{
    const h = harness([observe, plan(), skill, geometry(), row(1),
        { action: 'tool', name: 'dig_block', args: { position: [0, 0, 0], expectedBlock: 'stone' } },
        observe, skill,
        geometry([{ kind: 'box', min: [1, 0, 0], max: [2, 0, 0], block: 'stone' }]),
        { action: 'tool', name: 'place_row', args: { start: [1, 0, 0], end: [2, 0, 0], block: 'stone' } },
        inspect, plan(true), finish]);
    assert.equal((await h.agent.start(task)).status, 'completed');
    assert.equal(h.agent.snapshot().assignmentVersion, 2);
    assert.equal(h.world.read([0, 0, 0]), 'air');
    assert.equal(h.files.get('state').removed['0,0,0'], 'stone');
}

// Budget interruption during design preserves a plan without a blueprint. A process
// restart restores it and starts with a fresh live observation and fresh round budget.
{
    const first = harness([observe, plan(), skill], { limits: { maxModelRequests: 3 } });
    assert.equal((await first.agent.start(task)).status, 'paused');
    const saved = first.files.get('state');
    assert.equal(saved.assignment, null);
    assert.equal(saved.modelRequests, 3);
    const second = harness([observe, skill, geometry(), row(), inspect, plan(true), finish]);
    second.agent.restore(saved);
    const result = await second.agent.resume();
    assert.equal(result.status, 'completed');
    assert.equal(result.runId, saved.id);
    assert.equal(result.modelRequests, 10);
    const firstFeedback = second.agent.snapshot().events[saved.events.length];
    assert.equal(firstFeedback.kind, 'decision');
    assert.equal(firstFeedback.input.name, 'observe_environment');
}

// The next action can depend on actual construction failure: inspect the reported
// coordinates, choose a different standing location, then retry the same blueprint.
{
    let reachable = false;
    const blocks = new Map();
    const h = harness([observe, plan(), skill, geometry(), row(), ({ turns }) => {
        const context = JSON.parse(turns[0].content);
        assert.equal(context.lastPlacement.status, 'blocked');
        assert.equal(context.lastPlacement.differenceReasons.unreachable, 1);
        assert.equal(context.lastPlacement.differenceReasons.not_attempted, 1);
        return JSON.stringify({ action: 'tool', name: 'observe_environment',
            args: { region: { min: [0, -1, 0], max: [2, 1, 2] } } });
    }, { action: 'tool', name: 'move_to', args: { position: [0, 0, 2] } },
    row(), inspect, plan(true), finish], { blocks, world: {
        async place(cell) {
            if (!reachable) return 'unreachable';
            blocks.set(cell.pos.join(','), cell.block);
            return 'placed';
        },
        async moveTo() { reachable = true; return true; }
    } });
    assert.equal((await h.agent.start(task)).status, 'completed');
    assert.equal(h.agent.snapshot().assignmentVersion, 1);
    assert.equal(blocks.size, 2);
}

// A removal completing during pause survives process restart and can be rebuilt.
{
    let agent;
    const blocks = new Map();
    const h = harness([observe, plan(), skill, geometry(), row(1),
        { action: 'tool', name: 'dig_block', args: { position: [0, 0, 0], expectedBlock: 'stone' } }
    ], { blocks, world: { async digBlock(pos) {
        blocks.set(pos.join(','), 'air');
        await agent.stop('paused');
        return 'removed';
    } } });
    agent = h.agent;
    assert.equal((await agent.start(task)).status, 'paused');
    const state = h.files.get('state');
    assert.equal(state.removed['0,0,0'], 'stone');
    assert.equal(state.placed['0,0,0'], undefined);
    const resumed = harness([row(), inspect, plan(true), finish], { blocks });
    resumed.agent.restore(state);
    const result = await resumed.agent.resume();
    assert.equal(result.status, 'completed');
    assert.equal(result.removalCount, 1);
    assert.deepEqual(resumed.files.get('state').removed, {});
}

// Pause interrupts an in-flight model response; stale output cannot build or install
// a design. Resume can continue even before any blueprint has been created.
{
    let release;
    let entered;
    const pending = new Promise(resolve => { entered = resolve; });
    const h = harness([observe, plan(), skill, () => {
        entered();
        return new Promise(resolve => { release = resolve; });
    }]);
    const running = h.agent.start(task);
    await pending;
    assert.equal(await h.agent.stop('paused'), true);
    release(JSON.stringify(geometry()));
    assert.equal((await running).status, 'paused');
    assert.equal(h.agent.snapshot().assignment, null);
    assert.equal(h.blocks.size, 0);
    assert.equal(h.files.get('state').status, 'paused');
    await h.agent.stop('cancelled');
    assert.equal(h.files.get('state').status, 'cancelled');
    assert.equal(h.files.get('result').status, 'cancelled');
}

// A placement that completes while pause is requested is still journalled. Resume
// sees the placed block rather than repeating it or losing construction ownership.
{
    let agent;
    const blocks = new Map();
    const h = harness([observe, plan(), skill, geometry(), row()], { blocks, world: {
        async place(cell) {
            blocks.set(cell.pos.join(','), cell.block);
            await agent.stop('paused');
            return 'placed';
        }
    } });
    agent = h.agent;
    assert.equal((await agent.start(task)).status, 'paused');
    assert.equal(Object.keys(h.files.get('state').placed).length, 1);
    assert.equal(h.files.get('result').verified, 1);
    assert.equal(h.files.get('result').placementAttempts, 1);
    const next = harness([row(), inspect, plan(true), finish], { blocks });
    next.agent.restore(h.files.get('state'));
    assert.equal((await next.agent.resume()).status, 'completed');
    assert.equal(next.blocks.size, 2);
}

// No model claim can override an occupied cell or world mutation after inspection.
{
    const h = harness([observe, plan(), skill, geometry(), row(), inspect, plan(true), ({ blocks }) => {
        blocks.set('0,0,0', 'glass');
        return JSON.stringify(finish);
    }, { action: 'blocked', reason: '现场被玻璃占用，请用户处理后继续' }]);
    const result = await h.agent.start(task);
    assert.equal(result.status, 'blocked');
    assert.equal(h.blocks.get('0,0,0'), 'glass');
    assert(h.agent.snapshot().events.some(event => event.output?.message?.includes('现场验收尚未通过')));
}

// Missing requirement review cannot certify completion; requirement descriptions
// cannot be weakened, explicit origins cannot move, and arbitrary tools cannot run.
{
    const h = harness([observe, { ...plan(), requirements: [{ id: 'goal', description: '建造两格石头平台，底层已完成' }] },
        skill, geometry(), row(), plan(true), finish]);
    assert.equal((await h.agent.start(task)).status, 'completed');
    assert.equal(h.agent.snapshot().plan.requirements[0].description, request);
    assert(!h.agent.snapshot().events.some(event => event.name === 'update_plan' && event.output?.status === 'error'));
    const designCall = h.calls.find(call => call.isSkill);
    assert(designCall.turns.some(turn => turn.content.includes(request)), 'design still receives the original goal');
}
{
    const h = harness([observe, plan(), { action: 'tool', name: 'dig', args: {} },
        { ...skill, args: { origin: [1, 0, 0] } },
        { action: 'update_plan', requirements: [{ id: 'goal', description: '只放一格' }], steps: plan().steps },
        skill, geometry(), row(), plan(true), { ...finish, requirementReview: [] },
        { action: 'blocked', reason: '需要检查需求说明' }]);
    assert.equal((await h.agent.start({ ...task, originLocked: true })).status, 'blocked');
    const messages = h.agent.snapshot().events.map(event => event.output?.message ?? '').join('\n');
    assert.match(messages, /未知 tool/);
    assert.match(messages, /施工原点不能移动/);
    assert.equal(h.agent.snapshot().plan.requirements.find(r => r.id === 'goal').description, task.request);
    assert(h.agent.snapshot().events.some(event => event.output?.status === 'planned' && event.output.preservedRequirements?.includes('goal')));
    assert.match(messages, /尚未确认原始需求/);
}

// Deadline stops even when a tool is waiting, and a second start cannot replace an
// active job. Everything stays in the same checkpoint rather than silently queuing.
{
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const h = harness([observe, plan(), { action: 'tool', name: 'move_to', args: { position: [0, 0, 1] } }], {
        world: { moveTo: (position, signal) => new Promise((resolve, reject) => {
            entered();
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }) }, limits: { timeLimitMs: 100 }
    });
    const running = h.agent.start(task);
    await waiting;
    assert.throws(() => h.agent.start(task), /仍在运行/);
    assert.equal((await running).status, 'paused');
    assert.equal(h.files.get('state').status, 'paused');
}

// Targeted observations preserve unknown cells rather than inventing free space.
{
    const h = harness([observe, { action: 'blocked', reason: '工地区块未加载，请靠近后继续' }], {
        world: { read: () => null }
    });
    assert.equal((await h.agent.start(task)).status, 'blocked');
    assert.equal(h.agent.snapshot().observation.counts.unloaded, 1000);
}

// Task totals include the nested blueprint request. A new task starts at zero.
{
    const script = () => [observe, plan(), skill, geometry(), row(), inspect, plan(true), finish];
    const h = harness(script(), { usage: ({ isSkill }) => ({
        input_tokens: isSkill ? 1000 : 100, output_tokens: isSkill ? 40 : 10
    }) });
    const result = await h.agent.start(task);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.tokenUsage, {
        inputTokens: 1700, outputTokens: 110, totalTokens: 1810, reportedRequests: 8, unreportedRequests: 0
    });
    assert.deepEqual(h.files.get('state').tokenUsage, result.tokenUsage);
    assert.deepEqual(h.files.get('result').tokenUsage, result.tokenUsage);
    assert.deepEqual(h.reports.at(-1).data.tokenUsage, result.tokenUsage);
    assert.equal(formatTokenUsage(result.tokenUsage), 'Token：输入 1,700，输出 110，合计 1,810');
    const next = await h.agent.start(task);
    assert.equal(next.tokenUsage.inputTokens, 100);
    assert.equal(next.tokenUsage.reportedRequests, 1);
}

// Invalid geometry still consumes tokens. Missing usage is explicitly unknown.
{
    const h = harness([observe, plan(), skill, geometry([]), geometry(), row(), inspect, plan(true), finish], {
        usage: ({ call }) => call === 5 ? null : { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
    });
    const result = await h.agent.start(task);
    assert.equal(result.status, 'completed');
    assert.equal(result.tokenUsage.reportedRequests, 8);
    assert.equal(result.tokenUsage.unreportedRequests, 1);
    assert.equal(result.tokenUsage.totalTokens, 880);
    assert.match(formatTokenUsage(result.tokenUsage), /已知.*880.*1 次请求未返回用量/);
}

// A process restart preserves totals; old states and interrupted calls remain unknown.
{
    const usage = () => ({ input_tokens: 100, output_tokens: 10, total_tokens: 110 });
    const first = harness([observe, plan(), skill], { limits: { maxModelRequests: 3 }, usage });
    assert.equal((await first.agent.start(task)).status, 'paused');
    const saved = first.files.get('state');
    assert.equal(saved.tokenUsage.totalTokens, 330);
    const next = harness([observe, skill, geometry(), row(), inspect, plan(true), finish], { usage });
    next.agent.restore(saved);
    const result = await next.agent.resume();
    assert.equal(result.status, 'completed');
    assert.equal(result.tokenUsage.totalTokens, 1100);
    assert.equal(result.tokenUsage.reportedRequests, result.modelRequests);

    const legacy = structuredClone(saved);
    delete legacy.tokenUsage;
    const old = harness([{ action: 'blocked', reason: '测试旧任务恢复' }], { usage });
    old.agent.restore(legacy);
    const oldResult = await old.agent.resume();
    assert.equal(oldResult.tokenUsage.unreportedRequests, 3);
    assert.equal(oldResult.tokenUsage.totalTokens, 110);
    assert.throws(() => old.agent.restore({ ...saved, tokenUsage: { ...saved.tokenUsage, totalTokens: -1 } }), /Token 统计无效/);

    const unknown = harness([{ action: 'blocked', reason: '无用量接口测试' }]);
    const unknownResult = await unknown.agent.start(task);
    assert.match(formatTokenUsage(unknownResult.tokenUsage), /1 次请求未返回用量，无法统计/);
}

// A response arriving as pause is requested still contributes its reported usage.
{
    let agent;
    const h = harness([async ({ context }) => {
        context.onUsage({ input_tokens: 20, output_tokens: 5, total_tokens: 25 });
        await agent.stop('paused');
        return JSON.stringify(plan());
    }]);
    agent = h.agent;
    const result = await agent.start(task);
    assert.equal(result.status, 'paused');
    assert.equal(result.tokenUsage.totalTokens, 25);
    assert.equal(result.tokenUsage.unreportedRequests, 0);
    assert.equal(h.files.get('state').tokenUsage.totalTokens, 25);
}

// The agent can explicitly choose flight and landing between construction steps.
{
    let position = [0, 0, 2];
    let flying = false;
    const h = harness([observe, plan(), skill, geometry(),
        { action: 'tool', name: 'fly_to', args: { position: [0, 8, 2] } },
        observe, row(),
        { action: 'tool', name: 'land_at', args: { position: [0, 0, 2] } },
        observe, inspect, plan(true), finish
    ], { world: {
        snapshot: () => ({ dimension: 'overworld', position, flying, gameMode: 'creative' }),
        async flyTo(target) { position = [...target]; flying = true; return true; },
        async landAt(target) { position = [...target]; flying = false; return true; }
    } });
    assert.equal((await h.agent.start(task)).status, 'completed');
    const feedback = h.agent.snapshot().events.filter(event => event.kind === 'feedback');
    assert.equal(feedback.find(event => event.name === 'fly_to').output.status, 'flown');
    assert.equal(feedback.find(event => event.name === 'land_at').output.status, 'landed');
    assert.equal(flying, false);
}

assert.equal(parseBuildMessage('我想要一座石砖小屋', 'andy').action, 'message');

// Model context sends the current observation once, while state retains full facts.
{
    const h = harness([observe, ({ turns }) => {
        const context = JSON.parse(turns[0].content);
        assert(context.observation.occupied.length > 0);
        const event = context.recentEvents.find(item => item.name === 'observe_environment');
        assert.equal(event.output.occupied, undefined);
        assert.equal(event.output.scanned, context.observation.scanned);
        return JSON.stringify({ action: 'blocked', reason: 'context checked' });
    }]);
    await h.agent.start(task);
    assert(h.files.get('state').events.find(e => e.kind === 'feedback' && e.name === 'observe_environment').output.occupied.length > 0);
}

// A transport failure pauses after ONE attempt and resumes the same job on demand.
{
    const h = harness([() => { throw Object.assign(new Error('Course API: request timed out'),
        { code: 'API_TIMEOUT', timeoutMs: 120000 }); }, observe, plan(), skill, geometry(), row(), plan(true), finish]);
    const paused = await h.agent.start(task);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.modelRequests, 1);
    assert.match(paused.reason, /120 秒.*继续/);
    const completed = await h.agent.resume();
    assert.equal(completed.status, 'completed');
    assert.equal(completed.runId, paused.runId);
}

// Formatting failures with different parser offsets still hit a bounded limit.
{
    const h = harness(['{"action":"end_turn"} trailing', 'two objects {} {}', '{bad json', plan()]);
    const result = await h.agent.start(task);
    assert.equal(result.status, 'paused');
    assert.equal(result.modelRequests, 3);
    assert.match(result.reason, /三次.*协议/);
    assert.equal(h.blocks.size, 0);
}

// Waiting updates cover an actual in-flight model request, including the skill path.
{
    const h = harness([async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return JSON.stringify({ action: 'blocked', reason: 'wait checked' });
    }], { limits: { modelWaitReportMs: 5 } });
    await h.agent.start(task);
    assert(h.reports.some(event => event.event === 'model_request' && event.data.status === 'waiting'));
    assert.equal(h.reports.at(-1).event, 'result');
}

// Native responses can update the plan alongside tools, preserving order.
{
    const { action, ...args } = plan(false);
    const h = harness([{ action: 'batch', steps: [
        { name: 'update_plan', args }, { name: 'observe_cells', args: { positions: [[0,0,0]] } }
    ] }, skill, geometry(), row(), plan(true), finish]);
    assert.equal((await h.agent.start(task)).status, 'completed');
    const result = h.files.get('state').events.find(e => e.name === 'batch' && e.kind === 'feedback');
    assert.deepEqual(result.output.steps.map(step => [step.name, step.status]), [['update_plan','planned'], ['observe_cells','ok']]);
}

// Invalid plan semantics late in a response cannot execute earlier tools.
{
    const h = harness([{ action: 'batch', steps: [
        { name: 'observe_cells', args: { positions: [[0,0,0]] } },
        { name: 'update_plan', args: { steps: [{ id: 'missing-title-and-success' }] } }
    ] }, { action: 'blocked', reason: 'test done' }]);
    await h.agent.start(task);
    assert(!h.files.get('state').events.some(e => e.kind === 'tool' && e.name === 'observe_cells'));
    assert.equal(h.files.get('state').plan.steps.length, 0);
}

// Incomplete full-plan submissions fail at parse time with a field path and
// recovery hint, and the protocol-failure counter stops blind retries. The
// ZhiXiu 11-13 logs showed the same success-less step retried nine times.
{
    const badPlan = { action: 'update_plan', steps: [{ id: 's1', title: '只有标题' }] };
    const h = harness([badPlan, badPlan, badPlan, { action: 'blocked', reason: 'never reached' }]);
    const result = await h.agent.start(task);
    assert.equal(result.status, 'paused');
    assert.match(result.reason, /连续三次/);
    const feedbacks = h.agent.snapshot().events.filter(e => e.kind === 'feedback');
    assert.equal(feedbacks.length, 3);
    assert.equal(feedbacks.at(-1).output.field, 'steps[0].success');
    assert.equal(feedbacks.at(-1).output.code, 'INVALID_ARGUMENT');
    assert(feedbacks.at(-1).output.expected.success);
}

// patch=true appends submitted new step IDs in order instead of rejecting them.
{
    const first = plan();
    const h = harness([observe, first,
        { action: 'update_plan', patch: true, steps: [{ id: 's1', status: 'done', evidence: '两格平台现场核验通过' },
            { id: 's2', title: '拆除前复核周边', success: '周边 5 格无残留放置', status: 'pending' }] },
        { action: 'blocked', reason: 'test done' }]);
    await h.agent.start(task);
    const saved = h.files.get('state').plan;
    assert.deepEqual(saved.steps.map(step => step.id), ['s1', 's2']);
    assert.equal(saved.steps[0].title, first.steps[0].title, 'patch merges stored title/success');
    assert.equal(saved.steps[1].status, 'pending');
    const planEvent = h.agent.snapshot().events.find(e => e.kind === 'feedback' && e.name === 'update_plan' && e.output?.appendedSteps);
    assert.deepEqual(planEvent.output.appendedSteps, ['s2']);
    assert.match(planEvent.output.note, /追加/);
}

// Batch planning must not bypass the idle teammate coordination boundary.
{
    const initial = harness([{ action: 'blocked', reason: 'save initial state' }]);
    await initial.agent.start(task);
    const saved = initial.files.get('state');
    saved.teamCoordination = true;
    const { action, ...args } = plan(false);
    const h = harness([{ action: 'batch', steps: [
        { name: 'observe_cells', args: { positions: [[0,0,0]] } }, { name: 'update_plan', args }
    ] }, { action: 'blocked', reason: 'test done' }]);
    h.agent.restore(saved);
    await h.agent.resume();
    assert.equal(h.files.get('state').plan.steps.length, 0);
    assert(!h.files.get('state').events.some(e => e.kind === 'tool' && e.name === 'observe_cells'));
}

// 业务规则拒绝带"下一步动作"recovery 与被拒动作摘要：真实日志里裸文本
// 错误 29% 从未恢复（模型只会重写措辞，如 9 连败只改 evidence）。
{
    // 1) design 前缺计划：recovery 指 update_plan 而不是重复"哪里错"。
    const h1 = harness([{ action: 'skill', name: 'design_blueprint', args: {} }, { action: 'blocked', reason: 'done' }]);
    await h1.agent.start(task);
    const fb1 = h1.agent.snapshot().events.find(e => e.output?.code === 'INVALID_PLAN' && String(e.output.message).includes('design_blueprint'));
    assert(fb1, 'design 前置计划拒绝使用 INVALID_PLAN');
    assert(fb1.output.expected.steps, 'expected 给出计划示例形状');
    assert(fb1.output.rejectedAction?.action === 'skill', '附被拒动作摘要');

    // 2) finish 时计划未完成：recovery 教 update_plan patch 标 done。
    const h2 = harness([observe, plan(), { action: 'skill', name: 'design_blueprint', args: {} }, geometry(),
        { action: 'tool', name: 'place_row', args: { start: [0,0,0], end: [1,0,0], block: 'stone' } },
        inspect, { action: 'finish', summary: 'x', requirementReview: [] }, { action: 'blocked', reason: 'done' }]);
    await h2.agent.start(task);
    const fb2 = h2.agent.snapshot().events.find(e => e.output?.code === 'PLAN_INCOMPLETE');
    assert(fb2, 'finish 计划未完成带 PLAN_INCOMPLETE');
    assert.match(fb2.output.recovery, /patch:true/);
    assert.match(fb2.output.message, /s1/, '列出未完成步骤 id');

    // 3) 拆除未注册：recovery 给出两步协议。
    const h3 = harness([{ action: 'tool', name: 'dig_block', args: { position: [0, 0, 0], expectedBlock: 'stone' } },
        { action: 'blocked', reason: 'done' }]);
    await h3.agent.start({ ...task, request: '拆除现场方块' });
    const fb3 = h3.agent.snapshot().events.find(e => e.output?.code === 'NO_DEMOLITION_TARGET');
    assert(fb3 && /set_demolition_target/.test(fb3.output.recovery), '拆除拒绝的 recovery 指明注册步骤');
    assert(fb3.output.rejectedAction?.name === 'dig_block', '摘要含被拒工具名');
}

assert.deepEqual(parseBuildMessage('bob，建造一座小屋', 'andy'), { action: 'message', request: 'bob，建造一座小屋' });
assert.deepEqual(modelAssertions, [], 'assertions in the model fixture must not be swallowed as recoverable model errors');
console.log('Building loop checks passed: replanning, skill feedback, explicit placement tools, goal/structure gates, budgets, persistence, pause/resume, non-destructive repair.');
