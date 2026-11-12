import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import mineflayer from 'mineflayer';
import pathfinderModule from 'mineflayer-pathfinder';
import vec3 from 'vec3';
import settings from '../../settings.js';
import { coordinates, prepareAssignment } from './blueprint.js';
import { createPlanner } from './planner.js';
import { createMineflayerWorld } from './mineflayer-world.js';
import { createBuildController } from './controller.js';
import { parseBuildMessage } from './chat-input.js';
import { resolveGroundOrigin } from './site.js';

const { Vec3 } = vec3;

export async function startBuildingAgent() {
    const { values } = parseArgs({ options: {
        profile: { type: 'string' },
        assignment: { type: 'string' },
        name: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
    } });
    if (values.help) {
        console.log('node main.js [--profile FILE] [--assignment FILE] [--name BOT_NAME]');
        return;
    }
    const assignment = values.assignment == null ? null : JSON.parse(await readFile(values.assignment, 'utf8'));
    if (values.assignment != null) prepareAssignment(assignment);
    const profilePath = values.profile ?? (assignment ? null : settings.profiles[0]);
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
    bot.on('error', error => console.error('[Minecraft]', error.message));
    bot.on('kicked', reason => console.error('[Minecraft] Kicked:', reason));
    bot.on('end', reason => {
        controller?.stop('paused');
        console.log('[Minecraft] Disconnected:', reason);
        process.exitCode = 1;
    });
    bot.on('death', () => controller?.stop('paused'));
    bot.on('respawn', () => controller?.stop('paused'));

    function tell(text) {
        console.log('[Build]', text);
        if (settings.chat_ingame && bot.entity?.isValid !== false && bot.entity) bot.chat('[建筑] ' + text.slice(0, 180));
    }

    bot.once('spawn', () => {
        try {
            const world = createMineflayerWorld(bot);
            controller = createBuildController({
                world,
                async save(id, type, data) {
                    const directory = join('bots', name, 'builds');
                    await mkdir(directory, { recursive: true });
                    await writeFile(join(directory, id + '.' + type + '.json'), JSON.stringify(data, null, 2) + '\n');
                },
                report(event, data) {
                    if (event === 'progress') {
                        console.log('[Build] 尝试放置 ' + data.attempts + ' 次，目标 ' + data.total + ' 格');
                        return;
                    }
                    const first = data.differences?.[0];
                    const progress = data.total == null ? '' : ' ' + data.verified + '/' + data.total + ' 格核验通过';
                    const reasons = {
                        unreachable: '找不到能放置的站位', missing_support: '下方缺少支撑',
                        missing_reference: '没有相邻放置面', entity_in_way: '有角色挡住方块',
                        placement_rejected: '放置未生效', placement_unconfirmed: '未观察到方块',
                        occupied: '已有其他方块', unloaded: '区块尚未加载',
                        changed_during_placement: '施工时目标发生变化', waiting_for_lower_layer: '等待下方一层补齐'
                    };
                    const problem = first ? '，首个差异位于 ' + first.pos.join(',') + '，' +
                        (reasons[first.reason] ?? '缺少目标方块') : '';
                    const statusText = { completed: '完成', blocked: '阻塞', paused: '已暂停', cancelled: '已取消' };
                    tell((statusText[data.status] ?? data.status) + progress + problem +
                        (data.reason ? '，' + data.reason : '') + '。模型请求 ' + data.modelRequests + ' 次');
                }
            });
            console.log('[Build] 请输入指令');
            if (settings.chat_ingame) bot.chat('请输入指令');
            if (assignment) controller.start(async () => assignment).catch(error => tell(error.message));
        } catch (error) {
            console.error('[Build]', error.message);
            bot.quit();
        }
    });

    async function onMessage(username, message) {
        if (!controller || username === name ||
            (settings.only_chat_with.length && !settings.only_chat_with.includes(username))) return;
        try {
            const input = parseBuildMessage(message, name);
            if (!input) return;
            if (input.action === 'unsupported_edit') {
                return tell('已收到改造要求。目前支持连续新建，但尚不支持拆改已有建筑。加门窗等要求请写进新建描述；可在另一块空地发起新任务');
            }
            if (input.action === 'status') {
                const states = { idle: '等待指令', planning: '正在设计', building: '正在施工', stopping: '正在停止',
                    paused: '已暂停', blocked: '施工遇到阻碍', completed: '已完成', cancelled: '已取消' };
                return tell(states[controller.status()]);
            }
            if (input.action === 'pause') {
                return tell(controller.stop('paused') ? '正在暂停' : '当前没有运行中的任务');
            }
            if (input.action === 'cancel') {
                return tell(controller.stop('cancelled') ? '取消请求已接受' : '当前没有可取消的任务');
            }
            if (input.action === 'resume') return await controller.resume();
            if (bot.game.gameMode !== 'creative') throw new Error('请先将机器人设为创造模式');
            let origin;
            if (input.origin) {
                origin = coordinates(input.origin, '施工原点');
            } else {
                const position = bot.players[username]?.entity?.position;
                if (!position) throw new Error('请靠近机器人后再下达指令');
                const anchor = [Math.floor(position.x) + 6, Math.floor(position.y), Math.floor(position.z)];
                origin = resolveGroundOrigin(anchor, pos => bot.blockAt(new Vec3(...pos)), bot.game.minY, bot.game.height);
            }
            if (bot.entity.position.distanceTo(new Vec3(...origin)) > 48) {
                throw new Error('施工原点过远');
            }
            if (origin[1] < bot.game.minY || origin[1] >= bot.game.minY + bot.game.height) {
                throw new Error('施工原点高度超出世界范围');
            }
            const dimension = bot.game.dimension;
            const request = input.request;
            if (!request || request.length > 1000) throw new Error('建筑描述需为 1–1000 个字符');
            if (profile.model?.api !== 'course_responses') throw new Error('自然语言规划需要 course_responses 模型配置');
            const { CourseResponses } = await import('../models/course_responses.js');
            const model = profile.model;
            const planner = createPlanner(new CourseResponses(model.model, model.url, {
                ...model.params, max_output_tokens: Math.min(model.params?.max_output_tokens ?? 2048, 2048)
            }));
            return await controller.start(async context => {
                tell('已收到指令，正在设计建筑。施工原点为 ' + origin.join(','));
                const blueprint = await planner({ ...context, request, origin });
                tell('蓝图已生成，共 ' + blueprint.blocks.length + ' 格，开始检查现场并施工');
                return {
                    version: 1,
                    dimension,
                    planning: { source: 'model', model: model.model, request, origin },
                    blueprint
                };
            }, { usesModel: true });
        } catch (error) {
            tell(error.message);
        }
    }

    bot.on('chat', onMessage);
    bot.on('whisper', onMessage);
}
