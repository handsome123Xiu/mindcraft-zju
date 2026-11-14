import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAction } from '../src/building/action-protocol.js';
import { createBuildingTools, TOOL_CATALOG } from '../src/building/tools.js';
import { createBuildingLoop } from '../src/building/loop-agent.js';
import { registerPeer, unregisterPeer, listPeers, peerMessage,
    deliverDirect, broadcastPeers, appendMailbox, drainMailbox } from '../src/building/peer-network.js';

// Catalog and schemas expose the new communication tools.
assert.deepEqual(['send_message', 'broadcast', 'list_peers'].map(name =>
    TOOL_CATALOG.find(tool => tool.name === name)?.name), ['send_message', 'broadcast', 'list_peers']);
parseAction('{"action":"tool","name":"broadcast","args":{"text":"我已完成地板"}}');
parseAction('{"action":"tool","name":"list_peers","args":{}}');
parseAction('{"action":"tool","name":"send_message","args":{"text":"帮我看着北侧","recipient":"ZhiXiu"}}');
assert.throws(() => parseAction('{"action":"tool","name":"broadcast","args":{}}'), /text/);

// Direct routing: registered peers receive messages, unregistered are offline.
{
    const received = [];
    const unregisterA = registerPeer('alpha', async message => received.push(message));
    assert.equal(listPeers('alpha').length, 0);
    assert.equal(listPeers('beta').length, 1);
    const result = await deliverDirect(peerMessage('beta', 'alpha', '开始东侧墙体'));
    assert.equal(result.delivered, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].text, '开始东侧墙体');
    const offline = await deliverDirect(peerMessage('beta', 'ghost', '有人在吗'));
    assert.equal(offline.delivered, false);
    assert.equal(offline.reason, 'offline');
    const fan = await broadcastPeers('beta', '全体注意，图纸 v2', 'beta');
    assert.equal(fan.length, 1);
    assert.equal(received.at(-1).broadcast, true);
    unregisterA();
    assert.equal(listPeers('beta').length, 0);
}

// File mailbox: cross-process queueing, drain returns messages exactly once.
{
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-'));
    await appendMailbox(dir, 'offline-bot', peerMessage('sender', 'offline-bot', '离线消息1'));
    await appendMailbox(dir, 'offline-bot', peerMessage('sender', 'offline-bot', '离线消息2'));
    const first = await drainMailbox(dir, 'offline-bot');
    assert.equal(first.length, 2);
    assert.equal(first[0].text, '离线消息1');
    const again = await drainMailbox(dir, 'offline-bot');
    assert.equal(again.length, 0);
    await appendMailbox(dir, 'offline-bot', peerMessage('sender', 'offline-bot', '补一条'));
    assert.equal((await drainMailbox(dir, 'offline-bot')).length, 1);
    await rm(dir, { recursive: true, force: true });
}

// Two agents in one process: A sends to B through the tool layer. B has a
// running conversation; the peer message must queue without stealing its task.
function fixture(name) {
    const blocks = new Map();
    const world = {
        read: pos => blocks.get(pos.join(',')) ?? (pos[1] < 0 ? 'stone' : 'air'),
        snapshot: () => ({ dimension: 'overworld', position: [0, 0, 4], gameMode: 'creative' }),
        async prepare() {}, inspectBlock: () => ({ status: 'observed' }), async lookAt() { return {}; }
    };
    const model = { modelName: 'offline', async sendRequest() { return JSON.stringify({ action: 'end_turn' }); } };
    const agent = createBuildingLoop({ world, model, save: async () => {}, agentName: name });
    const job = { origin: [0, 0, 0], dimension: 'overworld', owner: 'user', placed: {}, removed: {}, placementAttempts: 0,
        plan: { requirements: [{ id: 'goal', description: '协作测试' }], steps: [] }, events: [] };
    const sent = [];
    const peers = {
        isPeer: peerName => peerName !== name && ['alpha', 'beta'].includes(peerName),
        list: () => listPeers(name),
        async sendToAgent(recipient, text) {
            const result = await deliverDirect(peerMessage(name, recipient, text));
            return result.delivered ? { status: 'delivered', recipient, channel: 'direct' }
                : { status: 'delivered', recipient, channel: 'mailbox', directAttempt: result };
        },
        async broadcast(text) { return broadcastPeers(name, text, name); }
    };
    const tools = createBuildingTools({ world, job, sendMessage: async (r, t) => { sent.push([r, t]); return { status: 'sent' }; }, peers });
    return { agent, job, tools, blocks, sent };
}

{
    const inbox = [];
    const unregisterB = registerPeer('beta', async message => inbox.push(message));
    const a = fixture('alpha');
    const result = await a.tools.call('send_message', { text: 'beta，我认领地板', recipient: 'beta' });
    assert.equal(result.status, 'delivered');
    assert.equal(result.channel, 'direct');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from, 'alpha');
    // broadcast reaches beta but is journaled as team-wide in A's history.
    const fan = await a.tools.call('broadcast', { text: '图纸确认，各自开工' });
    assert.equal(fan.status, 'delivered');
    assert.equal(fan.delivered, 1);
    assert.equal(inbox.length, 2);
    assert.equal(inbox[1].broadcast, true);
    assert.equal(a.job.messages.at(-1).to, '(team)');
    const listing = await a.tools.call('list_peers');
    assert.equal(listing.status, 'observed');
    // Unknown recipient is still rejected.
    await assert.rejects(a.tools.call('send_message', { text: 'hi', recipient: 'stranger' }), /玩家或已知的队友/);
    unregisterB();
}

{
    // Peer messages never interrupt an active decision and never start a task.
    const b = fixture('beta');
    const world = { read: () => 'air', snapshot: () => ({ dimension: 'overworld', position: [0, 0, 4], gameMode: 'creative' }),
        async prepare() {}, inspectBlock: () => ({ status: 'observed' }), async lookAt() { return {}; } };
    const model = { modelName: 'offline', async sendRequest() { return JSON.stringify({ action: 'end_turn' }); } };
    const started = createBuildingLoop({ world, model, save: async () => {} });
    await started.receiveMessage({ request: '给我的房子铺地板', origin: [0, 0, 0], dimension: 'overworld', owner: 'user' });
    const queued = await started.receiveMessage({ request: '[来自队友 alpha] 我完成地板了', origin: null,
        owner: 'alpha', peerMessage: true });
    assert.notEqual(queued.status, 'ignored');
    const snapshot = started.snapshot();
    assert(snapshot.messages.some(item => item.from === 'alpha' && item.content.includes('地板')));
    const idle = createBuildingLoop({ world, model, save: async () => {} });
    assert.equal((await idle.receiveMessage({ request: '[来自队友 alpha] 开工', owner: 'alpha', peerMessage: true })).status, 'ignored');
}

console.log('Peer communication checks passed: catalog schemas, direct routing, mailbox queueing, tool-layer send/broadcast/list, non-interrupting delivery.');
