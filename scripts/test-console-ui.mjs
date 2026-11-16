// Optional local UI check: isolated headless Chromium, fixture API, no Minecraft/API calls.
// BROWSER_BIN can point to Chrome/Edge on other machines.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { migrateTeamSpec } from '../src/building/team-migration.js';
import { validateTeamSpec, TEAM_PRESETS } from '../src/building/team-state.js';
import { TOOL_CATALOG } from '../src/building/tools.js';
import { ACTION_SCHEMAS } from '../src/building/action-protocol.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = await mkdtemp(join(tmpdir(), 'mindcraft-ui-shots-'));
const profile = await mkdtemp(join(tmpdir(), 'mindcraft-ui-browser-'));
const browserBin = process.env.BROWSER_BIN ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let saved = null;
const server = createServer(async (req, res) => {
    try {
        const requestUrl = new URL(req.url, 'http://localhost');
        const path = requestUrl.pathname;
        if (path === '/' || path === '/styles.css') {
            res.writeHead(200, { 'content-type': path === '/' ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8' });
            return res.end(await readFile(join(root, 'console', path === '/' ? 'index.html' : 'styles.css')));
        }
        if (path === '/api/logs') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write('data: {"history":[]}\n\n'); }
        let body = ''; for await (const chunk of req) body += chunk;
        const data = body ? JSON.parse(body) : {};
        let value = {};
        if (path === '/api/status') value = { running: false };
        if (path === '/api/settings') value = { profiles: ['andy.json'], port: 51234, host: '127.0.0.1', building_agent: {} };
        if (path === '/api/profiles') value = { files: [{ name: 'andy.json', config: { name: 'ZhiXiu' } }], enabled: ['andy.json'] };
        if (path === '/api/profile') value = { name: 'ZhiXiu', model: { api: 'course_responses', model: 'offline' } };
        if (path === '/api/catalog') value = { tools: TOOL_CATALOG, actions: Object.keys(ACTION_SCHEMAS).map(name => ({ name })), skills: [] };
        if (path.startsWith('/api/team/presets/')) {
            const names = requestUrl.searchParams.getAll('name');
            value = { spec: TEAM_PRESETS[path.split('/').at(-1)](names.length ? names : undefined) };
        }
        if (path === '/api/team/runtime') value = { running: false, agents: [], tasks: [], proposals: [], claims: {}, runs: [] };
        if (path === '/api/team') {
            if (req.method === 'POST') { assert(validateTeamSpec(data.spec).ok); saved = data.spec; }
            value = { spec: saved, validation: saved ? validateTeamSpec(saved) : { ok: true, errors: [] }, claims: { claims: {} } };
        }
        if (path === '/api/team/migrate') value = { spec: migrateTeamSpec(data.spec) };
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const child = spawn(browserBin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
let launchError, ws;
child.on('error', error => { launchError = error; });
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, message) {
    const deadline = Date.now() + 12000;
    do { if (launchError) throw launchError; const result = await fn(); if (result) return result; await delay(100); } while (Date.now() < deadline);
    throw new Error(message);
}
try {
    const endpoint = await until(async () => {
        try { const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); return `ws://127.0.0.1:${port}${path}`; } catch { return null; }
    }, 'Chromium did not start');
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let id = 0, sessionId;
    const pending = new Map(), errors = [];
    ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const callback = pending.get(message.id); pending.delete(message.id);
            message.error ? callback?.reject(new Error(message.error.message)) : callback?.resolve(message.result);
        } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + message.params.exceptionDetails.exception?.description);
        // 预设替换画布前的 confirm() 在无头浏览器没有默认处理器，会永久挂起；自动接受。
        else if (message.method === 'Page.javascriptDialogOpening') {
            dialogs.push(message.params.message);
            ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true }, ...(sessionId ? { sessionId } : {}) }));
        }
    });
    const dialogs = [];
    const call = (method, params = {}) => new Promise((resolve, reject) => {
        const request = ++id; pending.set(request, { resolve, reject });
        ws.send(JSON.stringify({ id: request, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result?.value;
    };
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const screenshot = async name => {
        await evaluate("document.querySelector('#toast').style.display='none'");
        await writeFile(join(out, name), Buffer.from((await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
    };
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1150, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url });
    await until(() => evaluate("!!document.querySelector('#teamTasks tbody tr')"), 'Page failed to load');
    const modes = ['pipeline', 'centralized', 'router', 'competitive', 'parallel',
        'voting', 'peers', 'handoff', 'blackboard', 'swarm'];
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-preset]')].map(button => button.dataset.preset)"), modes);
    const edgesByMode = { pipeline: 5, centralized: 3, router: 3, competitive: 2, parallel: 2,
        voting: 3, peers: 3, handoff: 2, blackboard: 3, swarm: 5 };
    for (const mode of [...modes.filter(mode => mode !== 'centralized'), 'centralized']) {
        saved = null;
        await call('Page.navigate', { url });
        await until(() => evaluate("!!document.querySelector('#teamTasks tbody tr')"), 'Empty canvas failed to load');
        assert.equal(await evaluate("document.querySelectorAll('#teamCanvas g').length"), 0);
        const template = TEAM_PRESETS[mode]();
        const names = Object.keys(template.agents);
        const memberCount = names.length;
        await click(`[data-preset=${mode}]`);
        await until(() => evaluate(`document.querySelectorAll('#teamCanvas g').length === ${memberCount}`), 'Preset did not populate the canvas');
        const preset = await evaluate("JSON.parse(document.querySelector('#teamEditor').value)");
        assert(validateTeamSpec(preset).ok, `${mode} must create a valid team on an empty canvas`);
        assert.deepEqual(Object.keys(preset.agents), names);
        assert.deepEqual(preset.edges, template.edges, `${mode} has its own topology`);
        assert.equal(preset.edges.length, edgesByMode[mode]);
        for (const name of names) {
            const { position, ...agent } = preset.agents[name];
            assert.deepEqual(agent, template.agents[name], `${mode} copies the server profile of ${name}`);
            assert(Number.isFinite(position.x) && Number.isFinite(position.y));
        }
        assert(preset.edges.every(edge => edge.label && edge.description && !edge.kind && !edge.type));
        if (['pipeline', 'parallel', 'handoff', 'blackboard', 'swarm'].includes(mode)) {
            await evaluate("document.querySelector('#canvasWrap').scrollIntoView({block:'center'})");
            await screenshot('preset-' + mode + '.png');
        }
        await click('#applyCanvas');
        await until(() => saved?.coordination === 'relationships', 'Preset was not saved');
        await call('Page.reload');
        await until(() => evaluate(`document.querySelectorAll('#teamCanvas g').length === ${memberCount}`), 'Saved preset did not survive reload');
    }
    assert.equal(await evaluate("document.querySelectorAll('#teamCanvas g').length"), 3);
    assert.equal(await evaluate("!!document.querySelector('#edgeTypeSelect')"), false);
    assert.equal(await evaluate("!!document.querySelector('#teamAssignment')"), false);
    assert(await evaluate("(()=>{const r=document.querySelector('#addAgentBtn').getBoundingClientRect(),p=document.querySelector('#newAgentName').getBoundingClientRect();return r.width>30&&r.left>=p.right;})()"), 'Add-member button must remain visible beside the name field');
    await evaluate("document.querySelector('#canvasWrap').scrollIntoView({block:'center'})");
    const point = await evaluate("(()=>{const r=document.querySelector('#teamCanvas').getBoundingClientRect(),p=JSON.parse(document.querySelector('#teamEditor').value).agents.lead.position;return {x:r.left+p.x,y:r.top+p.y,original:p.x};})()");
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 30, y: point.y, buttons: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 30, y: point.y, button: 'left', clickCount: 1 });
    assert.equal(await evaluate("JSON.parse(document.querySelector('#teamEditor').value).agents.lead.position.x"), point.original + 30, 'drag must update the serialized saved position');
    await evaluate("document.querySelector('#teamCanvas path[stroke=transparent]').dispatchEvent(new MouseEvent('click', {bubbles:true})); document.querySelector('#edgeDescription').value = 'lead 安排目标，builder_1 自主拆分并汇报。'; document.querySelector('#edgeDescription').dispatchEvent(new Event('input', {bubbles:true}));");
    await click('#applyCanvas');
    await until(() => saved?.edges?.some(e => e.description.includes('自主拆分')), 'Relation was not saved');
    assert(saved.edges.every(e => !e.type && !e.kind));
    assert(!saved.rules);
    // Finish the save/reload cycle before editing another preset. A late
    // loadTeam response otherwise clears the selected role during this test.
    await call('Page.reload');
    await until(() => evaluate("document.querySelectorAll('#teamCanvas g').length === 3"), 'Saved relation did not reload');
    await click('#loadCentralizedExample');
    await evaluate('scrollTo(0,0)');
    await screenshot('console-team-desktop.png');
    const desktop = await evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,canvas:document.querySelector('#canvasWrap').getBoundingClientRect().width,inspector:document.querySelector('.inspector').getBoundingClientRect().width})");
    assert(desktop.scroll <= desktop.width, JSON.stringify(desktop));
    // Renaming a role must not reset manually chosen capabilities.
    const original = await evaluate("JSON.parse(document.querySelector('#teamEditor').value).agents.lead");
    await evaluate("document.querySelector('#roleInput').value='architect'; document.querySelector('#roleInput').dispatchEvent(new Event('change',{bubbles:true}));");
    assert.equal(await evaluate("JSON.parse(document.querySelector('#teamEditor').value).agents.lead.permissions.blueprintAuthority"), true);
    assert.equal(original.role, 'lead');
    const configuredSpec = await evaluate("JSON.parse(document.querySelector('#teamEditor').value)");
    // 预设切换 = 完整模板替换画布（曾经的 useExisting 沿用旧成员，画布看起来没反应）。
    await click('[data-preset=blackboard]');
    await until(() => evaluate("JSON.parse(document.querySelector('#teamEditor').value).agents.finisher?.role === 'finisher'"), 'Blackboard must replace the canvas with its own members');
    await evaluate(`document.querySelector('#teamEditor').value = ${JSON.stringify(JSON.stringify(configuredSpec))}; document.querySelector('#teamEditor').onblur()`);
    await click('[data-preset=peers]');
    await until(() => evaluate("Object.keys(JSON.parse(document.querySelector('#teamEditor').value).agents).join() === 'arch_1,arch_2,arch_3'"), 'Peers preset must replace the canvas with arch members');
    await evaluate(`document.querySelector('#teamEditor').value = ${JSON.stringify(JSON.stringify(configuredSpec))}; document.querySelector('#teamEditor').onblur()`);
    await click('[data-preset=parallel]');
    await until(() => evaluate("JSON.parse(document.querySelector('#teamEditor').value).agents.builder_left?.role === 'module_builder'"), 'Parallel must replace the canvas with independent modules');
    const rewired = await evaluate("JSON.parse(document.querySelector('#teamEditor').value)");
    assert(rewired.edges.length === 2, 'parallel preset has two independent spokes');
    await click('[data-tab=control]'); await screenshot('console-control-desktop.png');
    await click('[data-tab=teamTab]');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    for (const mode of modes) {
        await click(`[data-preset=${mode}]`);
        const names = Object.keys(TEAM_PRESETS[mode]().agents);
        await until(async () => {
            const loadedNames = await evaluate("Object.keys(JSON.parse(document.querySelector('#teamEditor').value).agents)");
            return loadedNames.join(',') === names.join(',');
        }, 'Mobile preset did not load: ' + mode);
        const fits = await evaluate(`(() => {
            const canvas = document.querySelector('#teamCanvas').getBoundingClientRect();
            return [...document.querySelectorAll('#teamCanvas g')].every(node => {
                const rect = node.getBoundingClientRect();
                return rect.left >= canvas.left - 1 && rect.right <= canvas.right + 1 && rect.bottom <= canvas.bottom + 1;
            });
        })()`);
        assert(fits, mode + ' nodes fit inside the mobile canvas');
    }
    await screenshot('console-team-mobile.png');
    const mobile = await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})');
    assert(mobile.scroll <= mobile.width, 'Mobile horizontal overflow: ' + JSON.stringify(mobile));
    saved = { agents: { lead: { role: 'lead' }, worker: { role: 'builder', permissions: { deny: ['design_blueprint', 'delegate_task'] } } },
        edges: [{ from: 'lead', to: 'worker', type: 'delegate' }], rules: { assignment: 'lead-assigns' } };
    await call('Page.reload');
    await until(() => evaluate("document.querySelector('#migrationBanner')?.hidden === false"), 'Missing migration banner');
    assert.equal(await evaluate("document.querySelectorAll('#teamCanvas g').length"), 0, 'old edges are never rendered');
    await click('#convertRelationships');
    await until(() => evaluate("document.querySelector('#migrationBanner').hidden"), 'Conversion did not finish');
    await click('#applyCanvas');
    await until(() => saved.coordination === 'relationships', 'Converted graph was not saved');
    assert(saved.agents.worker.permissions.deny.includes('delegate_task'));
    assert.deepEqual(errors, [], 'Browser console errors');
    console.log('Console UI passed: desktop/mobile layout, relationship edit/save, permissions, tabs, explicit old-config conversion. Screenshots: ' + out);
} finally {
    ws?.close();
    if (child.exitCode == null) { child.kill(); await Promise.race([new Promise(r => child.once('exit', r)), delay(3000)]); }
    server.closeAllConnections(); await new Promise(r => server.close(r));
    // Exactly the mkdtemp-created test profile, never a user's browser profile.
    assert(resolve(profile).startsWith(resolve(tmpdir()) + sep) && profile.includes('mindcraft-ui-browser-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {});
}
