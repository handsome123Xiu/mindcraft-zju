// Agent 间通信路由。两种投递方式：
// 1. 同进程直投：多个 loop 共享一个 peerRegistry（测试与嵌入场景）。
// 2. 跨进程信箱：每个 agent 进程在 bots/<name>/mailbox.jsonl 追加写入，
//    接收方在决策间隙轮询自己的信箱文件（简单、无依赖、可崩溃恢复）。
import { appendFile, readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const direct = new Map();

export function registerPeer(name, deliver) {
    if (typeof deliver !== 'function') throw new Error('peer 投递函数无效');
    direct.set(name, { deliver, since: new Date().toISOString() });
    return () => direct.delete(name);
}

export function unregisterPeer(name) { direct.delete(name); }

export function listPeers(self) {
    return [...direct.entries()].filter(([name]) => name !== self)
        .map(([name, { since }]) => ({ name, channel: 'direct', since }));
}

export function peerMessage(from, to, text, broadcast = false) {
    return { id: randomUUID(), from, to, text, broadcast, at: new Date().toISOString() };
}

// 直投给单个在线 peer；返回投递结果。离线 peer 由调用方决定是否落信箱。
export async function deliverDirect(message) {
    const peer = direct.get(message.to);
    if (!peer) return { delivered: false, reason: 'offline' };
    try { await peer.deliver(message); return { delivered: true, channel: 'direct' }; }
    catch (error) { return { delivered: false, reason: error.message }; }
}

export async function broadcastPeers(from, text, self) {
    const results = [];
    for (const [name, peer] of direct.entries()) {
        if (name === self) continue;
        const message = peerMessage(from, name, text, true);
        try { await peer.deliver(message); results.push({ to: name, delivered: true, channel: 'direct' }); }
        catch (error) { results.push({ to: name, delivered: false, reason: error.message }); }
    }
    return results;
}

// ---- 跨进程文件信箱（每条一行 JSON，读完轮转防止无限增长） ----
export function mailboxPath(botsDir, name) { return join(botsDir, name, 'mailbox.jsonl'); }

export async function appendMailbox(botsDir, name, message) {
    await mkdir(join(botsDir, name), { recursive: true });
    await appendFile(mailboxPath(botsDir, name), JSON.stringify(message) + '\n', 'utf8');
}

// 读取并清空自己的信箱；读到的文件先改名再读，避免与写入方竞争。
export async function drainMailbox(botsDir, name) {
    const path = mailboxPath(botsDir, name);
    const pending = path + '.reading';
    let text = '';
    try { await rename(path, pending); text = await readFile(pending, 'utf8'); await writeFile(pending, '', 'utf8'); }
    catch { return []; }
    try { await rename(pending, path); } catch { /* 下一轮 drain 再读 */ }
    return text.split('\n').filter(line => line.trim()).map(line => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
}
