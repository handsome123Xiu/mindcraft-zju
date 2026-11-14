// 本地控制台：启动/停止建筑 Agent、编辑配置、浏览动作/工具/skill、实时日志。
// 仅监听 127.0.0.1；通过子进程运行 main.js，进程退出即清理。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = join(dirname(fileURLToPath(import.meta.url)), 'index.html');
const moduleUrl = path => pathToFileURL(join(root, path)).href;

// ---- 反射动作清单（与 agent 实际使用的同一套源码，避免文档漂移） ----
async function loadCatalog() {
    const { TOOL_CATALOG } = await import(moduleUrl('src/building/tools.js'));
    const { ACTION_SCHEMAS, describeSchema } = await import(moduleUrl('src/building/action-protocol.js'));
    const { BLUEPRINT_SKILL } = await import(moduleUrl('src/building/planner.js'));
    return {
        tools: TOOL_CATALOG.map(({ name, args, description, parameters }) => ({
            name, args, description, schema: describeSchema(parameters)
        })),
        actions: Object.keys(ACTION_SCHEMAS).map(name => ({ name })),
        skills: [{ name: BLUEPRINT_SKILL.name, description: BLUEPRINT_SKILL.description }]
    };
}

// ---- 配置读写：settings.js 是 ESM 导出，直接 import 缓存的实例 ----
let cachedSettingsText = '';
async function readSettings() {
    cachedSettingsText = await readFile(join(root, 'settings.js'), 'utf8');
    return (await import(moduleUrl('settings.js'))).default;
}

// 简单的顶层字段替换：保留注释与格式，只改 "key": value 的值部分。
function patchSettingsText(text, key, value) {
    const serialized = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
    const pattern = new RegExp(`^(\\s*)"${key}"\\s*:\\s*(` +
        `(?:"[^"]*")|true|false|null|-?\\d+(?:\\.\\d+)?|\\[[^\\]]*\\])`, 'm');
    const match = text.match(pattern);
    if (!match) throw new Error('字段未找到或格式不支持：' + key);
    return text.slice(0, match.index) + match[1] + `"${key}": ${serialized}` + text.slice(match.index + match[0].length);
}

async function listProfiles() {
    const entries = await readdir(join(root, 'profiles'));
    const files = entries.filter(name => name.endsWith('.json'));
    const current = (await readSettings()).profiles ?? [];
    const loaded = await Promise.all(files.map(async name => {
        try { return { name, config: JSON.parse(await readFile(join(root, 'profiles', name), 'utf8')) }; }
        catch { return { name, config: null }; }
    }));
    return { files: loaded, enabled: current };
}

// ---- agent 子进程管理（单实例） ----
let agent = null;
const logSubscribers = new Set();
let logHistory = [];

function broadcast(line) {
    const entry = { at: new Date().toISOString(), line };
    logHistory.push(entry);
    if (logHistory.length > 2000) logHistory.splice(0, logHistory.length - 2000);
    for (const response of logSubscribers) response.write(`data: ${JSON.stringify(entry)}\n\n`);
}

function startAgent({ profile, name, port }) {
    if (agent && !agent.killed && agent.exitCode == null) throw new Error('Agent 已在运行，先停止当前实例');
    const args = [join(root, 'main.js')];
    if (profile) args.push('--profile', profile);
    if (name) args.push('--name', name);
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, MINECRAFT_PORT: String(port ?? '') },
        stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    agent = child;
    logHistory = [];
    broadcast(`[console] 启动 agent 进程 pid=${child.pid} profile=${profile ?? '(settings 默认)'} name=${name ?? '(profile 默认)'}`);
    createInterface({ input: child.stdout }).on('line', broadcast);
    createInterface({ input: child.stderr }).on('line', broadcast);
    child.on('exit', (code, signal) => {
        broadcast(`[console] agent 进程退出 code=${code ?? ''} signal=${signal ?? ''}`);
        if (agent === child) agent = null;
    });
    return { pid: child.pid };
}

function stopAgent() {
    if (!agent) return { stopped: false };
    broadcast('[console] 发送停止信号（SIGTERM）');
    agent.kill('SIGTERM');
    return { stopped: true, pid: agent.pid };
}

// ---- HTTP 服务 ----
const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
};
async function readBody(request) {
    let data = '';
    for await (const chunk of request) data += chunk;
    return data ? JSON.parse(data) : {};
}

const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;
    try {
        if (request.method === 'GET' && path === '/') {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return response.end(await readFile(indexHtml, 'utf8'));
        }
        if (request.method === 'GET' && path === '/api/status') {
            return json(response, 200, { running: !!(agent && agent.exitCode == null), pid: agent?.pid ?? null });
        }
        if (request.method === 'GET' && path === '/api/catalog') {
            return json(response, 200, await loadCatalog());
        }
        if (request.method === 'GET' && path === '/api/settings') {
            return json(response, 200, await readSettings());
        }
        if (request.method === 'POST' && path === '/api/settings') {
            const body = await readBody(request);
            let text = cachedSettingsText || await readFile(join(root, 'settings.js'), 'utf8');
            for (const [key, value] of Object.entries(body)) text = patchSettingsText(text, key, value);
            await writeFile(join(root, 'settings.js'), text, 'utf8');
            return json(response, 200, { saved: Object.keys(body) });
        }
        if (request.method === 'GET' && path === '/api/profiles') {
            return json(response, 200, await listProfiles());
        }
        if (request.method === 'GET' && path === '/api/profile') {
            const name = url.searchParams.get('name');
            return json(response, 200, JSON.parse(await readFile(join(root, 'profiles', name), 'utf8')));
        }
        if (request.method === 'POST' && path === '/api/profile') {
            const { name, config } = await readBody(request);
            await writeFile(join(root, 'profiles', name), JSON.stringify(config, null, 2) + '\n', 'utf8');
            return json(response, 200, { saved: name });
        }
        if (request.method === 'POST' && path === '/api/agent/start') {
            return json(response, 200, startAgent(await readBody(request)));
        }
        if (request.method === 'POST' && path === '/api/agent/stop') {
            return json(response, 200, stopAgent());
        }
        if (request.method === 'GET' && path === '/api/logs') {
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
                connection: 'keep-alive' });
            response.write(`data: ${JSON.stringify({ history: logHistory })}\n\n`);
            logSubscribers.add(response);
            request.on('close', () => logSubscribers.delete(response));
            return;
        }
        json(response, 404, { error: 'not found' });
    } catch (error) {
        json(response, 400, { error: error.message });
    }
});

const port = Number(process.env.CONSOLE_PORT ?? 8787);
server.listen(port, '127.0.0.1', () => {
    console.log(`[console] 控制台已启动：http://127.0.0.1:${port}`);
    console.log('[console] 该服务只监听本机，不要暴露到外网。');
});
