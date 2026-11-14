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

    const bot = mineflayer.createBot({
        username: name, host: settings.host, port, version: settings.minecraft_version,
        auth: settings.auth, checkTimeoutInterval: 60000
    });
    bot.loadPlugin(pathfinderModule.pathfinder);
    bot.once('resourcePack', () => bot.acceptResourcePack());
    let controller;
    let startupCheck;
    let apiChecking = false;
    const connectionAbort = new AbortController();
    bot.on('error', error => console.error('[Minecraft]', error.message));
    bot.on('kicked', reason => console.error('[Minecraft] Kicked:', reason));
    bot.on('end', reason => {
        connectionAbort.abort(new Error('Minecraft disconnected'));
        controller?.stop('paused');
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

    let runtimeModel;
    const model = {
        modelName: profile.model?.model,
        async sendRequest(...args) {
            if (profile.model?.api !== 'course_responses') throw new Error('建筑 Agent 需要 course_responses 模型配置');
            if (!runtimeModel) {
                const { CourseResponses } = await import('../models/course_responses.js');
                runtimeModel = new CourseResponses(profile.model.model, profile.model.url, {
                    ...profile.model.params,
                    max_output_tokens: Math.min(profile.model.params?.max_output_tokens ?? 4096, 8192)
                });
            }
            return runtimeModel.sendRequest(...args);
        }
    };

    bot.once('spawn', async () => {
        try {
            const world = createMineflayerWorld(bot, { onNavigation(info) {
                if (info.mode === 'walking' && ['walk_stuck', 'walk_timeout'].includes(info.reason)) {
                    tell('检测到行走受阻，正在重新选择路线。');
                }
            } });
            const options = {
                world,
                sendMessage: createMessageSender(bot),
                async save(id, type, data) {
                    const directory = join('bots', name, 'builds');
                    await mkdir(directory, { recursive: true });
                    const target = join(directory, id + '.' + type + '.json');
                    await writeFile(target + '.tmp', JSON.stringify(data, null, 2) + '\n');
                    await rename(target + '.tmp', target);
                },
                report(event, data) {
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
                    const statusText = { completed: '完成', waiting_user: '等待你的补充', blocked: '阻塞', paused: '已暂停', cancelled: '已取消' };
                    if (data.outcome !== 'conversation') tell((statusText[data.status] ?? data.status) + progress + problem +
                        (data.reason ? '，' + data.reason : '') + '。模型请求 ' + data.modelRequests + ' 次' +
                        (data.summary ? '。' + data.summary : ''));
                    if (data.tokenUsage) tell(formatTokenUsage(data.tokenUsage));
                }
            };
            controller = createBuildingLoop({
                ...options, model, agentName: name,
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
            if (checked.ok) tell(name + ' 已就绪，可直接聊天、提问或描述任务；私聊可用 /msg ' + name + ' 你好');
            else tell('机器人仍在线；请检查 API 配置和服务状态，后续消息会再次尝试调用 API。');
            if (resumeState) tell('已载入任务进度，请确认进入原实验世界后发送“继续建造”');
        } catch (error) {
            apiChecking = false;
            console.error('[Build]', error.message);
            bot.quit();
        }
    });

    async function onMessage(username, message) {
        if (!controller || username === name ||
            (settings.only_chat_with.length && !settings.only_chat_with.includes(username))) return;
        try {
            console.log('[Chat]', username + ':', message);
            const input = parseBuildMessage(message, name);
            if (!input) return;
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
                    paused: '已暂停', waiting_user: '等待你的补充', blocked: '任务遇到阻碍', completed: '已完成', cancelled: '已取消' };
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
            if (profile.model?.api !== 'course_responses') throw new Error('建筑 Agent 需要 course_responses 模型配置');
            console.log('[Chat] 已收到消息，交给 Agent 决策。');
            return await controller.receiveMessage({ request: input.request, ...site, owner: username, originLocked: !!input.origin });
        } catch (error) {
            tell(error.message);
        }
    }

    bot.on('chat', onMessage);
    bot.on('whisper', onMessage);
}
