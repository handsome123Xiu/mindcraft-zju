import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import mineflayer from 'mineflayer';
import pathfinderModule from 'mineflayer-pathfinder';
import vec3 from 'vec3';
import settings from '../../settings.js';
import { createMineflayerWorld } from './mineflayer-world.js';
import { createBuildingLoop } from './loop-agent.js';
import { parseBuildMessage } from './chat-input.js';
import { formatTokenUsage } from './token-usage.js';
import { createMessageSender } from './message-actions.js';
import { chooseMessageSite } from './chat-site.js';
import { checkApiConnection } from './api-check.js';
import { createTeamClient } from './team-client.js';
import { entryAgent } from './team-runtime.js';
import { createLazyBuildingModel, BUILDING_MODEL_APIS } from './model.js';

const { Vec3 } = vec3;

export async function startBuildingAgent() {
    const { values } = parseArgs({ options: {
        profile: { type: 'string' },
        resume: { type: 'string' },
        name: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
    } });
    if (values.help) {
        console.log('node main.js [--profile FILE] [--name BOT_NAME] [--resume STATE_FILE]');
        return;
    }
    const resumeState = values.resume == null ? null : JSON.parse(await readFile(values.resume, 'utf8'));
    const profilePath = values.profile ?? settings.profiles[0];
    const profile = profilePath ? JSON.parse(await readFile(profilePath, 'utf8')) : {};
    const name = values.name ?? profile.name ?? 'builder';
    const port = Number(process.env.MINECRAFT_PORT ?? settings.port);
    if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) throw new Error('机器人名称必须是 1–16 个字母、数字或下划线');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('请输入有效的 Minecraft LAN 端口');

    const managedSpec = process.env.MINDCRAFT_TEAM_SPEC ? JSON.parse(process.env.MINDCRAFT_TEAM_SPEC) : null;
    const bot = mineflayer.createBot({
        username: name, host: settings.host, port, version: settings.minecraft_version,
        auth: settings.auth, checkTimeoutInterval: 60000
    });
    bot.loadPlugin(pathfinderModule.pathfinder);
    bot.once('resourcePack', () => bot.acceptResourcePack());
    let controller;
    let teamClient;
    let startupCheck;
    let apiChecking = false;
    let minecraftEnded = false;
    const connectionAbort = new AbortController();
    const onTeamDisconnect = () => {
        controller?.stop('paused').catch(error => console.error('[Team]', error.message));
        if (minecraftEnded) return;
        // quit is installed by a plugin only after protocol initialization.
        // end is available even when the initial TCP connection is refused.
        if (typeof bot.quit === 'function') bot.quit('Team runtime disconnected');
        else bot.end('Team runtime disconnected');
        // Before entering play there is no game session to close gracefully.
        // Plugins may already exist while the login handshake is still pending.
        if (bot._client?.state !== 'play') bot._client?.socket?.destroy();
    };
    if (managedSpec) process.once('disconnect', onTeamDisconnect);
    bot.on('error', error => {
        console.error('[Minecraft]', error.message);
        if (error.code === 'ECONNREFUSED') console.error('[Minecraft] 无法连接 ' + settings.host + ':' + port +
            '，请确认世界已“对局域网开放”，并在控制台填写游戏提示的实际 LAN 端口。');
    });
    bot.on('kicked', reason => console.error('[Minecraft] Kicked:', reason));
    bot.on('end', reason => {
        minecraftEnded = true;
        if (managedSpec) process.off('disconnect', onTeamDisconnect);
        connectionAbort.abort(new Error('Minecraft disconnected'));
        controller?.stop('paused');
        teamClient?.close();
        if (managedSpec && process.connected) process.disconnect();
        console.log('[Minecraft] Disconnected:', reason);
        process.exitCode = 1;
    });
    bot.on('death', () => controller?.stop('paused'));
    bot.on('respawn', () => controller?.stop('paused'));

    function tell(text, { forceInGame = false } = {}) {
        console.log('[Build]', text);
        if ((settings.chat_ingame || forceInGame) && bot._client?.state === 'play' &&
            bot.entity?.isValid !== false && bot.entity) bot.chat('[建筑] ' + text.slice(0, 180));
    }

    const model = createLazyBuildingModel(profile.model);

    bot.once('spawn', async () => {
        try {
            const world = createMineflayerWorld(bot, { onNavigation(info) {
                if (info.mode === 'walking' && ['walk_stuck', 'walk_timeout'].includes(info.reason)) {
                    tell('检测到行走受阻，正在重新选择路线。');
                }
            } });
            // 队友通信：直投优先，离线队友写入其文件信箱，由对方决策间隙取信。
            const {
                registerPeer, unregisterPeer, listPeers, peerMessage,
                deliverDirect, broadcastPeers, appendMailbox, drainMailbox
            } = await import('./peer-network.js');
            const botsDir = join('bots');
            const unregister = registerPeer(name, async message => {
                console.log('[Peer <- ' + message.from + ']', message.text);
                await controller.receiveMessage({ request: '[来自队友 ' + message.from + '] ' + message.text,
                    origin: null, owner: message.from, peerMessage: true });
            });
            bot.once('end', unregister);
            bot.once('kicked', unregister);
            // Agent 间协商消息镜像到游戏聊天框，玩家能直接看到 agent 之间的沟通。
            // 私聊用 /msg、广播用公屏；镜像失败（掉线等）不影响真实投递。
            const mirrorChat = (recipient, text) => {
                if (bot._client?.state !== 'play' || !bot.entity) return;
                const body = '[-> ' + recipient + '] ' + String(text ?? '').slice(0, 180);
                try { bot.chat(body); } catch { /* 镜像失败不影响投递 */ }
            };
            let peers = {
                isPeer: peerName => peerName !== name && (listPeers(name).some(peer => peer.name === peerName) ||
                    drainMailboxCache.has(peerName)),
                list: () => listPeers(name),
                async sendToAgent(recipient, text) {
                    mirrorChat(recipient, text);
                    const result = await deliverDirect(peerMessage(name, recipient, text));
                    if (result.delivered) return { status: 'delivered', recipient, channel: 'direct' };
                    await appendMailbox(botsDir, recipient, peerMessage(name, recipient, text));
                    return { status: 'delivered', recipient, channel: 'mailbox', directAttempt: result };
                },
                async broadcast(text) {
                    mirrorChat('(team)', text);
                    return broadcastPeers(name, text, name);
                }
            };
            // 信箱轮询缓存：把离线队友名记住，让 isPeer 对曾出现在信箱目录的名字返回 true。
            const drainMailboxCache = new Set();
            if (!managedSpec) setInterval(async () => {
                try {
                    const incoming = await drainMailbox(botsDir, name);
                    for (const message of incoming) {
                        drainMailboxCache.add(message.from);
                        console.log('[Mailbox <- ' + message.from + ']', message.text);
                        await controller.receiveMessage({ request: '[来自队友 ' + message.from + '] ' + message.text,
                            origin: null, owner: message.from, peerMessage: true });
                    }
                } catch { /* 信箱不存在或正在轮转 */ }
            }, 5000).unref();
            // 团队协作：轮询共享 team.json（组织结构），租约读写 claims.json。
            const teamState = await import('./team-state.js');
            let teamSpec = null;
            const teamSpecError = teamSpec ? teamState.validateTeamSpec(teamSpec) : null;
            if (teamSpecError && !teamSpecError.ok) {
                console.error('[Team] team.json 无效，忽略团队模式：', teamSpecError.errors.join('；'));
                teamSpec = null;
            }
            if (process.env.MINDCRAFT_LEGACY_TEAM === '1') setInterval(async () => {
                try {
                    const next = await teamState.readTeamSpec(botsDir);
                    if (JSON.stringify(next) !== JSON.stringify(teamSpec)) {
                        const check = next ? teamState.validateTeamSpec(next) : { ok: true };
                        if (!check.ok) { console.error('[Team] 新 team.json 无效，保留旧配置：', check.errors.join('；')); return; }
                        teamSpec = next;
                        console.log('[Team] 组织结构已更新', next ? '(' + Object.keys(next.agents).join(', ') + ')' : '(已解散)');
                    }
                } catch { /* 轮询失败下次再试 */ }
            }, 3000).unref();
            let team = {
                self: name,
                spec: () => teamSpec,
                claim: (partId, assignmentVersion) => teamState.claimPart(botsDir, name, partId, { assignmentVersion }),
                release: partId => teamState.releasePart(botsDir, name, partId),
                queryClaims: () => teamState.queryClaims(botsDir)
            };
            if (managedSpec) {
                if (!process.send) throw new Error('团队成员需要由控制台启动');
                teamClient = createTeamClient({ name, spec: managedSpec });
                team = teamClient;
                // 团队模式下 peers 走 supervisor IPC；包装一层，消息同样镜像到游戏聊天框。
                const directPeers = teamClient.peers;
                peers = {
                    isPeer: directPeers.isPeer,
                    list: directPeers.list,
                    async sendToAgent(recipient, text, job) {
                        mirrorChat(recipient, text);
                        return directPeers.sendToAgent(recipient, text, job);
                    },
                    async broadcast(text, job) {
                        mirrorChat('(team)', text);
                        return directPeers.broadcast(text, job);
                    }
                };
            }
            const options = {
                world,
                sendMessage: createMessageSender(bot),
                async save(id, type, data) {
                    const directory = join('bots', name, 'builds');
                    await mkdir(directory, { recursive: true });
                    const target = join(directory, id + '.' + type + '.json');
                    await writeFile(target + '.tmp', JSON.stringify(data, null, 2) + '\n');
                    // Windows/杀毒软件可能短暂锁住目标文件，rename 抛 EPERM（实测
                    // arch_3 end_turn 后落盘失败）。重试覆盖，仍失败则退回原子的
                    // write-then-unlink 语义：直接写目标，避免丢整个 checkpoint。
                    try { await rename(target + '.tmp', target); }
                    catch (error) {
                        if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
                        await new Promise(resolve => setTimeout(resolve, 200));
                        try { await rename(target + '.tmp', target); }
                        catch { await writeFile(target, JSON.stringify(data, null, 2) + '\n'); }
                    }
                },
                report(event, data) {
                    if (event === 'team_error') { console.error('[Team]', data.reason); return; }
                    if (event === 'model_request') {
                        const purpose = data.purpose === 'blueprint' ? '设计蓝图' : '决策';
                        if (data.status === 'started') {
                            console.log('[Agent] 模型请求 ' + data.request + '：' + purpose);
                        } else tell('正在等待模型' + purpose + '，本次已等待 ' + Math.round(data.elapsedMs / 1000) + ' 秒；可发送“暂停”停止等待。');
                        return;
                    }
                    if (event === 'step') {
                        console.log('[Agent]', data.kind, data.name, data.output?.status ?? 'observed');
                        if (data.kind === 'feedback' && data.output?.completedParts?.length) {
                            tell('部件验收通过：' + data.output.completedParts.map(part => part.title + '（' + part.total + ' 格）').join('、'));
                        }
                        if (data.kind === 'feedback' && ['error', 'blocked', 'unreachable'].includes(data.output?.status)) {
                            const first = data.output.differences?.[0];
                            const reason = data.output.message ?? data.output.reason ?? first?.reason ?? data.output.status;
                            const position = first?.pos ? '，坐标 ' + first.pos.join(',') : '';
                            tell('动作 ' + data.name + ' 未完成：' + reason + position);
                        }
                        if (data.kind === 'feedback' && data.name === 'update_plan' && data.output.status === 'planned') {
                            const pending = data.output.plan.steps.find(step => step.status !== 'done');
                            if (pending) tell('计划 ' + data.output.plan.steps.length + ' 步，当前：' + pending.title);
                        }
                        return;
                    }
                    if (event === 'progress') {
                        console.log('[Build] 尝试' + (data.action?.startsWith('dig_') ? '拆除 ' : '放置 ') + data.attempts + ' 次，目标 ' + data.total + ' 格');
                        return;
                    }
                    const first = data.differences?.[0];
                    const progress = data.total == null ? '' : ' ' + data.verified + '/' + data.total + ' 格核验通过';
                    const reasons = {
                        unreachable: '找不到能放置的站位', missing_support: '下方缺少支撑',
                        missing_reference: '没有相邻放置面', entity_in_way: '有角色挡住方块',
                        placement_rejected: '放置未生效', placement_unconfirmed: '未观察到方块',
                        occupied: '已有其他方块', unloaded: '区块尚未加载',
                        changed_during_placement: '施工时目标发生变化', not_attempted: '前序放置未完成，尚未尝试',
                        placement_error: '放置动作异常', target_changed: '目标方块已变化',
                        dig_unconfirmed: '未确认方块已删除', dig_timeout: '删除动作超时',
                        dig_rejected: '删除未生效', unbreakable: '该方块无法挖掘', standing_on_target: '机器人正站在目标上方',
                        multiblock_blueprint_required: '多格方块需要蓝图内完整且空闲的占位，请检查门的上半格或床的另一格',
                        placement_state_unavailable: '当前适配器无法执行所需的特殊放置方式'
                    };
                    const problem = first ? '，首个差异位于 ' + first.pos.join(',') + '，' +
                        (reasons[first.reason] ?? '缺少目标方块') : '';
                    const statusText = { completed: '完成', failed: '任务失败并已结束，可直接发送新任务', waiting_user: '等待你的补充', waiting_team: '等待团队', blocked: '阻塞', paused: '已暂停', cancelled: '已取消' };
                    if (data.outcome !== 'conversation') tell((statusText[data.status] ?? data.status) + progress + problem +
                        (data.reason ? '，' + data.reason : '') + '。模型请求 ' + data.modelRequests + ' 次' +
                        (data.summary ? '。' + data.summary : ''));
                    if (data.tokenUsage) tell(formatTokenUsage(data.tokenUsage));
                }
            };
            controller = createBuildingLoop({
                ...options, model, agentName: name, peers, team,
                maxModelRequests: settings.building_agent?.max_model_requests ?? 30,
                timeLimitMs: (settings.building_agent?.time_limit_mins ?? 20) * 60 * 1000
            });
            if (resumeState) controller.restore(resumeState);
            apiChecking = true;
            startupCheck = checkApiConnection({ model, signal: connectionAbort.signal,
                report: text => tell(text, { forceInGame: true }) });
            const checked = await startupCheck;
            apiChecking = false;
            if (connectionAbort.signal.aborted) return;
            teamClient?.attach(controller);
            if (checked.ok) tell(name + ' 已就绪，可直接聊天、提问或描述任务；私聊可用 /msg ' + name + ' 你好');
            else tell('机器人仍在线；请检查 API 配置和服务状态，后续消息会再次尝试调用 API。');
            if (resumeState) tell('已载入任务进度，请确认进入原实验世界后发送“继续建造”');
        } catch (error) {
            apiChecking = false;
            console.error('[Build]', error.message);
            bot.quit();
        }
    });

    async function onMessage(username, message, isWhisper = false) {
        if (!controller || username === name ||
            (settings.only_chat_with.length && !settings.only_chat_with.includes(username))) return;
        if (managedSpec?.agents[username]) return;
        if (managedSpec && name !== entryAgent(managedSpec) && !isWhisper) return;
        try {
            console.log('[Chat]', username + ':', message);
            const input = parseBuildMessage(message, name);
            if (!input) return;
            if (managedSpec && name !== entryAgent(managedSpec) && input.action === 'message') {
                return tell('请向团队入口 ' + entryAgent(managedSpec) + ' 提交目标；我接收运行时分配的子任务。');
            }
            console.log('[Chat] action:', input.action);
            if (apiChecking && ['message', 'resume'].includes(input.action)) {
                tell('API 正在检测，消息已收到，将在检测结束后处理。');
                await startupCheck;
                if (connectionAbort.signal.aborted) return;
            }
            if (input.action === 'status') {
                const states = { idle: '等待指令', planning: '正在规划', thinking: '正在决策', observing: '正在观察',
                    designing: '正在设计', verifying: '正在验收', moving: '正在移动', flying: '正在飞行', landing: '正在落地', looking: '正在调整朝向',
                    demolishing: '正在删除方块', building: '正在施工', stopping: '正在停止',
                    paused: '已暂停', waiting_user: '等待你的补充', blocked: '任务遇到阻碍', failed: '任务失败并已结束，可直接发送新任务', completed: '已完成', cancelled: '已取消' };
                return tell((states[controller.status()] ?? controller.status()) +
                    (controller.summary ? '。' + controller.summary() : ''));
            }
            if (input.action === 'pause') {
                return tell(await controller.stop('paused') ? '正在暂停' : '当前没有运行中的任务');
            }
            if (input.action === 'cancel') {
                return tell(await controller.stop('cancelled') ? '取消请求已接受' : '当前没有可取消的任务');
            }
            if (input.action === 'resume') return await controller.resume();
            const site = chooseMessageSite(bot, username, input.origin, pos => bot.blockAt(new Vec3(...pos)));
            if (!BUILDING_MODEL_APIS.includes(profile.model?.api)) throw new Error('建筑 Agent 需要 course_responses 或 deepseek_responses 模型配置');
            console.log(controller.status() === 'paused' ? '[Chat] 当前任务已暂停，保存补充消息。' : '[Chat] 已收到消息，交给 Agent 决策。');
            const received = await controller.receiveMessage({ request: input.request, ...site, owner: username, originLocked: !!input.origin });
            if (received?.notice) tell(received.notice);
            return received;
        } catch (error) {
            tell(error.message);
        }
    }

    bot.on('chat', (username, message) => onMessage(username, message));
    bot.on('whisper', (username, message) => onMessage(username, message, true));
}
