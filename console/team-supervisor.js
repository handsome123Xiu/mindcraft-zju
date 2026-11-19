import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createTeamRuntime, entryAgent } from '../src/building/team-runtime.js';
import { validateTeamSpec } from '../src/building/team-state.js';
import { BUILDING_MODEL_APIS } from '../src/building/model.js';
import { createTeamTranscript } from './team-transcript.js';

export function createTeamSupervisor({ root, log = () => {}, launch = spawn }) {
    const children = new Map();
    let runtime, sweep, starting = false;
    function profilePath(value) {
        const path = resolve(root, value);
        const rel = relative(root, path);
        if (rel.startsWith('..') || isAbsolute(rel) || !path.endsWith('.json')) throw new Error('Profile 必须位于项目目录内');
        return path;
    }
    const supervisor = {
        running: () => starting || children.size > 0,
        snapshot: () => ({ running: supervisor.running(), processes: [...children].map(([name, { child }]) => ({ name, pid: child.pid })),
            ...(runtime?.snapshot() ?? { agents: [], runs: [], tasks: [], claims: {} }) }),
        async start({ spec, settings, port, profile, fresh = false }) {
            if (supervisor.running()) throw new Error('团队已在运行');
            starting = true;
            try {
                const validation = validateTeamSpec(spec);
                if (!validation.ok) throw new Error(validation.errors.join('；'));
                const entry = entryAgent(spec);
                const mcPort = Number(port ?? settings.port);
                if (!Number.isInteger(mcPort) || mcPort < 1 || mcPort > 65535) throw new Error('请设置有效的 Minecraft LAN 端口');
                const configs = [];
                if (typeof fresh !== 'boolean') throw new Error('fresh 必须是布尔值');
                for (const [name, node] of Object.entries(spec.agents)) {
                    const file = profilePath(node.profile || profile || settings.profiles?.[0] || 'andy.json');
                    const config = JSON.parse(await readFile(file, 'utf8'));
                    if (!BUILDING_MODEL_APIS.includes(config.model?.api) || !config.model?.model) throw new Error(name + ' 的 profile 需要 course_responses 或 deepseek_responses 模型配置');
                    configs.push({ name, file });
                }
                runtime?.close();
                runtime = createTeamRuntime({ spec, path: join(root, 'bots', 'team-runtime.sqlite'), pauseOnRestore: true, archiveLegacyRuns: fresh });
                // Reconcile legacy/crash-interrupted failures before topology checks.
                for (const run of runtime.snapshot().runs.filter(run => run.status === 'active')) {
                    if (fresh) {
                        runtime.archiveRun(run.id);
                        log(`[Team] 已归档旧工程 ${run.id}；新测试保留日志和现场建筑`);
                        continue;
                    }
                    try {
                        const saved = JSON.parse(await readFile(join(root, 'bots', run.root, 'builds', run.id + '.state.json'), 'utf8'));
                        const failed = ['failed', 'blocked'].includes(saved.status) || ['failed', 'blocked'].includes(saved.result?.status) ||
                            (saved.result?.status === 'paused' && saved.result.stopRequested === false && !saved.teamPaused);
                        if (failed) {
                            runtime.archiveRun(run.id, { status: 'failed', reason: saved.result?.reason ?? '旧工程已执行失败' });
                            log(`[Team] 已结束失败工程 ${run.id}，可直接提交新任务`);
                        }
                    } catch (error) { if (error.code !== 'ENOENT') throw error; }
                }
                const previous = runtime.snapshot().runs.filter(run => run.status === 'active').at(-1);
                if (previous) {
                    const topology = value => JSON.stringify({ entry: entryAgent(value), coordination: value.coordination, blueprintMode: value.blueprintMode,
                        agents: Object.entries(value.agents).map(([name, node]) => [name, node.role, JSON.stringify(node.permissions ?? null), node.instructions ?? '']).sort(),
                        edges: (value.edges ?? []).map(edge => JSON.stringify([[edge.from, edge.to].sort(), edge.description ?? '', edge.label ?? '', edge.note ?? ''])).sort() });
                    if (topology(previous.spec) !== topology(spec)) throw new Error('恢复旧工程需要原成员和连线；如需使用新结构，请选择“保存并开始新测试”');
                }
                const transcript = createTeamTranscript({ snapshot: () => runtime.snapshot(), log,
                    notify: settings.chat_ingame ? (actor, text) => {
                        const sender = children.get(actor)?.child;
                        if (sender?.connected) sender.send({ type: 'team_transcript', text }, () => {});
                    } : undefined });
                for (const { name, file } of configs) {
                    const args = [join(root, 'main.js'), '--name', name, '--profile', file];
                    if (name === entry && previous) {
                        const state = join(root, 'bots', name, 'builds', previous.id + '.state.json');
                        try {
                            const saved = JSON.parse(await readFile(state, 'utf8'));
                            if (!['completed', 'cancelled'].includes(saved.status)) { args.push('--resume', state); log(`[${name}] 已恢复工程状态，发送“继续”恢复协调`); }
                        } catch (error) { if (error.code !== 'ENOENT') throw error; }
                    }
                    const child = launch(process.execPath, args, { cwd: root, windowsHide: true,
                        env: { ...process.env, MINECRAFT_PORT: String(mcPort), MINDCRAFT_TEAM_SPEC: JSON.stringify(spec) },
                        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], shell: false });
                    const session = runtime.connect(name);
                    children.set(name, { child, session });
                    child.on('message', message => {
                        if (message?.type !== 'team_request') return;
                        let response;
                        try { response = { result: runtime.request(name, session, message.method, message.args) }; }
                        catch (error) { response = { error: error.message }; }
                        if (child.connected) child.send({ type: 'team_response', id: message.id, ...response }, error => { if (error) log(`[${name}] IPC: ${error.message}`); });
                        if (!response.error) {
                            try { transcript(name, message.method, message.args ?? {}, response.result); }
                            catch (error) { log('[团队记录] ' + error.message); }
                        }
                    });
                    for (const stream of [child.stdout, child.stderr]) if (stream) createInterface({ input: stream }).on('line', line => log(`[${name}] ${line}`));
                    const cleanup = () => {
                        if (children.get(name)?.child !== child) return;
                        children.delete(name); runtime.disconnect(name, session);
                        log(`[${name}] 进程退出；未完成任务已交回运行时`);
                    };
                    child.once('exit', cleanup);
                    child.once('disconnect', () => runtime.disconnect(name, session));
                    child.on('error', error => { log(`[${name}] ${error.message}`); cleanup(); });
                    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
                }
                clearInterval(sweep);
                sweep = setInterval(() => { try { runtime.sweep(); } catch (error) { log('[Team] ' + error.message); } }, 2000);
                sweep.unref();
                log(`[Team] 已启动 ${configs.length} 个成员；向 ${entry} 发送整体任务`);
                return { started: configs.map(c => c.name), entryAgent: entry };
            } catch (error) {
                await supervisor.stop();
                throw error;
            } finally { starting = false; }
        },
        async stop() {
            clearInterval(sweep);
            await Promise.all([...children.values()].map(({ child }) => new Promise((resolveExit, reject) => {
                if (child.exitCode != null) return resolveExit();
                const timer = setTimeout(() => reject(new Error('成员进程未退出：' + child.pid)), 5000);
                child.once('exit', () => { clearTimeout(timer); resolveExit(); });
                child.kill();
            })));
            return { stopped: true };
        },
        close() { clearInterval(sweep); runtime?.close(); }
    };
    return supervisor;
}
