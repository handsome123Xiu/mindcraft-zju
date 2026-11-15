import assert from 'node:assert/strict';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { createBuildingTools } from '../src/building/tools.js';
import { createMessageSender } from '../src/building/message-actions.js';
import { chooseMessageSite } from '../src/building/chat-site.js';

const task = { request: '你好！', owner: 'tester', origin: [0, 0, 0], dimension: 'overworld' };
const say = text => ({ action: 'tool', name: 'send_message', args: { text } });
const end = { action: 'end_turn' };
const wait = { action: 'wait_for_user', reason: '请确认材料' };
const stop = { action: 'blocked', reason: '测试到此结束' };
const plan = done => ({ action: 'update_plan', steps: [{ id: 's1', title: '建造并验收',
    success: '一个石头方块', status: done ? 'done' : 'running', evidence: done ? '现场读取为 stone' : '' }] });
const observe = { action: 'tool', name: 'observe_environment', args: { region: { min: [0, -1, 0], max: [1, 2, 1] } } };
const design = { action: 'skill', name: 'design_blueprint', args: {} };
const geometry = { shapes: [{ kind: 'point', at: [0, 0, 0], block: 'stone' }],
    summary: '一个石头方块', coverage: [{ requirementId: 'goal', evidence: '指定位置一个 stone' }] };
const place = { action: 'tool', name: 'place_block', args: { position: [0, 0, 0], block: 'stone' } };
const finish = { action: 'finish', summary: '已完成', requirementReview: [
    { requirementId: 'goal', satisfied: true, evidence: '目标一个石头，现场核验为 stone' }] };
const assertions = [];

function fixture(script, options = {}) {
    const files = new Map(), sent = [], calls = [], blocks = new Map();
    let writes = 0;
    const world = {
        snapshot: () => ({ dimension: 'overworld', position: [0, 0, 2], gameMode: 'survival' }),
        read: pos => blocks.get(pos.join(',')) ?? (pos[1] < 0 ? 'stone' : 'air'),
        async prepare() {},
        async place(cell) { blocks.set(cell.pos.join(','), cell.block); return 'placed'; },
        ...options.world
    };
    const agent = createBuildingLoop({ world, agentName: 'ZhiXiu',
        async sendMessage(recipient, text) {
            if (options.sendFailure) throw new Error('连接已断开');
            sent.push({ recipient, text });
            return { status: 'sent', recipient, delivery: 'queued' };
        },
        async save(id, type, data) {
            assert.equal(writes++, 0, 'checkpoint writes must be serialized');
            try {
                await options.onSave?.(id, type, data);
                files.set(type, structuredClone(data));
            } finally { writes--; }
        },
        model: { async sendRequest(turns, instructions, _, context) {
            calls.push({ turns, instructions });
            context.onUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
            const item = script.shift() ?? stop;
            try {
                return JSON.stringify(typeof item === 'function' ? await item(JSON.parse(turns[0].content)) : item);
            } catch (error) {
                if (error.code === 'ERR_ASSERTION') assertions.push(error.message);
                throw error;
            }
        } }, ...options.limits
    });
    return { agent, files, sent, calls, blocks };
}

// A greeting works in survival, without construction or a successful terrain scan.
{
    const h = fixture([say('你好！有什么需要帮忙的吗？'), end, context => {
        assert.equal(context.agentName, 'ZhiXiu');
        assert(context.messages.some(item => item.content === '你好！有什么需要帮忙的吗？'));
        assert.equal(context.messages.at(-1).content, '你叫什么？');
        return say('我叫 ZhiXiu。');
    }, end], { world: { read() { throw new Error('区块不可读'); } } });
    const first = await h.agent.receiveMessage(task);
    assert.equal(first.outcome, 'conversation');
    assert.equal(first.tokenUsage.totalTokens, 30);
    assert.equal(h.agent.snapshot().assignment, null);
    assert.equal(h.blocks.size, 0);
    const second = await h.agent.receiveMessage({ ...task, request: '你叫什么？' });
    assert.equal(second.status, 'completed');
    assert.notEqual(first.runId, second.runId);
    assert.equal(second.tokenUsage.totalTokens, 30);
    assert.deepEqual(h.sent.map(item => item.recipient), ['tester', 'tester']);
}

// Clarification waits without running more model requests, then resumes the same job.
{
    const h = fixture([say('用什么材料？'), wait, context => {
        assert.equal(context.ORIGINAL_GOAL, '放一个方块');
        assert.equal(context.messages.at(-1).content, '石头');
        return plan(false);
    }, observe, design, geometry, place, plan(true), finish]);
    const waiting = await h.agent.receiveMessage({ ...task, request: '放一个方块' });
    assert.equal(waiting.status, 'waiting_user');
    assert.equal(h.calls.length, 2);
    assert.equal(h.files.get('state').status, 'waiting_user');
    const result = await h.agent.receiveMessage({ ...task, request: '石头' });
    assert.equal(result.runId, waiting.runId);
    assert.equal(result.status, 'completed');
    assert.equal(result.verified, 1);
    assert.equal(result.structuralVerification, 'machine_verified');
    assert.equal(h.files.get('state').messages.at(-1).content, '石头');
}

// Restoring a clarification preserves the question and accepts its answer.
{
    const first = fixture([say('用什么材料？'), wait]);
    await first.agent.receiveMessage(task);
    const next = fixture([context => {
        assert(context.messages.some(item => item.content === '用什么材料？'));
        assert.equal(context.messages.at(-1).content, '先聊聊');
        return say('好的。');
    }, end]);
    next.agent.restore(first.files.get('state'));
    assert.equal(next.agent.status(), 'waiting_user');
    assert.equal((await next.agent.receiveMessage({ ...task, request: '先聊聊' })).outcome, 'conversation');
    assert.equal(next.agent.snapshot().tokenUsage.totalTokens, 60);
}

// An unavailable site prevents building while allowing a question. A subsequent
// input with a valid site clears that limitation and construction can proceed.
{
    const h = fixture([plan(false), observe, design, say('请靠近一点，让我确认施工位置。'), wait,
        observe, design, geometry, place, plan(true), finish]);
    const waiting = await h.agent.receiveMessage({ ...task, request: '放一个石头方块', siteIssue: '玩家不可见' });
    assert.equal(waiting.status, 'waiting_user');
    assert.equal(h.agent.snapshot().assignment, null);
    assert(h.agent.snapshot().events.some(event => /施工位置尚需确认/.test(event.output?.message ?? '')));
    const result = await h.agent.receiveMessage({ ...task, request: '我到你旁边了', siteIssue: null });
    assert.equal(result.status, 'completed');
    assert.equal(result.verified, 1);
    assert.equal(h.agent.snapshot().siteIssue, null);
}

// Input received during an outstanding decision invalidates the stale placement.
{
    let h;
    h = fixture([plan(false), observe, design, geometry, async () => {
        const received = await h.agent.receiveMessage({ ...task, request: '先别放，确认一下材料' });
        assert.equal(received.status, 'received');
        return place;
    }, context => {
        assert.equal(context.messages.at(-1).content, '先别放，确认一下材料');
        return say('好的，先确认材料。');
    }, wait]);
    const result = await h.agent.receiveMessage(task);
    assert.equal(result.status, 'waiting_user');
    assert.equal(h.blocks.size, 0);
    assert.equal(result.placementAttempts, 0);
    assert(h.agent.snapshot().events.some(event => event.output?.status === 'superseded'));
}

// A design response generated before a follow-up must not become the current blueprint.
{
    let h;
    h = fixture([plan(false), observe, design, async () => {
        await h.agent.receiveMessage({ ...task, request: '先不要设计' });
        return geometry;
    }, say('已停止这次设计，等你确认。'), wait]);
    await h.agent.receiveMessage(task);
    assert.equal(h.agent.snapshot().assignment, null);
}

// Neither end_turn nor an unanswered wait can bypass construction verification.
{
    const h = fixture([wait, plan(false), observe, design, geometry, say('正在建造'), end, stop]);
    assert.equal((await h.agent.receiveMessage(task)).status, 'blocked');
    const errors = h.agent.snapshot().events.filter(event => event.output?.status === 'error');
    assert(errors.some(event => /先用 send_message/.test(event.output.message)));
    assert(errors.some(event => /跳过验收/.test(event.output.message)));
}

// Failed delivery is feedback, not a successful reply; it cannot enable end_turn.
{
    const h = fixture([say('你好'), end, stop], { sendFailure: true });
    assert.equal((await h.agent.receiveMessage(task)).status, 'blocked');
    assert.equal(h.agent.snapshot().messages.filter(item => item.role === 'assistant').length, 0);
    assert.equal(h.sent.length, 0);
}

// A manual pause still accepts/persists input, but does not silently resume execution.
{
    const h = fixture([say('你好')], { limits: { maxModelRequests: 1 } });
    await h.agent.receiveMessage(task);
    const requests = h.calls.length;
    const result = await h.agent.receiveMessage({ ...task, request: '补充内容' });
    assert.equal(result.paused, true);
    assert.match(result.notice, /继续建造/);
    assert.match(result.notice, /取消建造/);
    assert.equal(h.calls.length, requests);
    assert.equal(h.files.get('state').messages.at(-1).content, '补充内容');
    for (let i = 0; i < 45; i++) await h.agent.receiveMessage({ ...task, request: '后续说明 ' + i });
    await h.agent.receiveMessage({ ...task, owner: 'builder_1', request: '队友建议不是用户约束', peerMessage: true });
    const saved = h.files.get('state');
    assert.equal(saved.messages.length, 40);
    assert(!saved.messages.some(message => message.content === '补充内容'));
    assert.equal(saved.clarifications[0].content, '补充内容', 'user constraints survive rolling chat history');
    assert.equal(saved.clarifications.length, 46, 'peer discussion does not become a pinned user requirement');
    const restored = fixture([({ turns }) => {
        assert.equal(JSON.parse(turns[0].content).userClarifications[0].content, '补充内容');
        return stop;
    }]);
    restored.agent.restore(saved);
    await restored.agent.resume();
}

// Input arriving while the previous result is saving becomes the next turn.
{
    let h, next, injected = false;
    h = fixture([say('你好'), end, say('第二条也收到啦'), end], {
        onSave(id, type) {
            if (type === 'result' && !injected) {
                injected = true;
                next = h.agent.receiveMessage({ ...task, request: '第二条' });
            }
        }
    });
    const first = await h.agent.receiveMessage(task);
    const second = await next;
    assert.notEqual(first.runId, second.runId);
    assert.equal(h.sent.length, 2);
    assert.equal(second.outcome, 'conversation');
}

// The message tool itself does not consult world state or require a blueprint.
{
    const job = { owner: 'tester', origin: [0, 0, 0], dimension: 'overworld', messages: [] };
    const calls = [];
    const tools = createBuildingTools({ world: { snapshot() { throw new Error('不得读取世界'); } }, job,
        sendMessage: async (recipient, text) => { calls.push([recipient, text]); return { status: 'sent', recipient }; } });
    assert.equal((await tools.call('send_message', { text: '你好' })).status, 'sent');
    await assert.rejects(tools.call('send_message', { text: '你好', recipient: 'stranger' }), /参与/);
    await assert.rejects(tools.call('send_message', { text: ' ' }), /不能为空/);
    assert.deepEqual(calls, [['tester', '你好']]);
}

// Transport binds the username, sends command-like text as a body, splits Unicode
// safely within the chat packet limit, and rejects disconnected/aborted sends.
{
    const whispers = [];
    const bot = { entity: { isValid: true }, _client: { state: 'play' },
        whisper: (...args) => { whispers.push(args); } };
    const send = createMessageSender(bot, { log() {} });
    await send('tester', '/kill @a');
    assert.deepEqual(whispers.shift(), ['tester', '/kill @a']);
    const text = '飞行🦅'.repeat(100);
    const sent = await send('tester', text);
    assert.equal(sent.parts, whispers.length);
    assert.equal(whispers.map(item => item[1]).join(''), text);
    assert(whispers.every(item => item[1].length <= 120 && item[1].isWellFormed()));
    await assert.rejects(send('tester /op', 'hi'), /接收者/);
    await assert.rejects(send('tester', 'a\n/kill @a'), /控制字符/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(send('tester', 'hi', abort.signal), /abort/i);
    bot._client.state = 'disconnected';
    await assert.rejects(send('tester', 'hi'), /未连接/);
}

// Runtime site selection cannot block chat because of distance, survival or chunks.
{
    const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, players: {},
        game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' } };
    const site = chooseMessageSite(bot, 'tester', undefined, () => null);
    assert.deepEqual(site.origin, [0, 64, 0]);
    assert.match(site.siteIssue, /可见范围/);
    bot.players.tester = { entity: { position: { x: 0, y: 64, z: 0 } } };
    assert.match(chooseMessageSite(bot, 'tester', undefined, () => null).siteIssue, /尚未加载/);
    assert.match(chooseMessageSite(bot, 'tester', [1000, 64, 0], () => null).siteIssue, /过远/);
    const good = chooseMessageSite(bot, 'tester', [6, 64, 0], () => null);
    assert.equal(good.siteIssue, null);
    assert.deepEqual(good.origin, [6, 64, 0]);
}

assert.deepEqual(assertions, [], 'model fixture assertions must not be swallowed as agent feedback');
console.log('Chat agent checks passed: arbitrary input, replies, clarification, conversation history, stale decisions, persistence and delivery failures.');
