import { bounds, coordinates, prepareAssignment, MATERIALS } from './blueprint.js';
import { actionAllowed, roleOf, capabilities, edgeAllows } from './team-state.js';
import { inspectCells } from './inspection.js';
import { compilePlacement, executePlacement, PLACEMENT_ACTIONS } from './placement-actions.js';
import { ACTION_SCHEMAS, TOOL_SCHEMAS, validateToolArgs } from './action-protocol.js';
import { DEMOLITION_ACTIONS, compileDemolition, extendDemolitionTarget, inspectDemolition } from './demolition.js';
import { scanEnvironment, scanCells } from './observation.js';
import { rememberObservation, rememberBlockObservation, markObservationsStale } from './observation-memory.js';
import { assertMaterial, placementNotes } from './materials.js';
import { checklistParts, taskChecklistParts, refreshChecklist, inspectPart } from './checklist.js';
import { partitionBuilding, verifyParallelSite } from './parallel-building.js';

export const TOOL_CATALOG = Object.freeze([
    { name: 'get_tool_help', description: 'Read exact arguments and usage for a named tool. Read-only; grants no additional permissions.' },
    { name: 'prepare_parallel_build', description: 'OPTIONAL coordinator tool for a site where X/Z strips make sense: split blueprint metadata into vertical zones and dispatch builders. Never automatic or mandatory. Usually prefer delegate_task with whole modules or chosen scope, preserving module identities. Requires no unfinished tasks/leases and clear independent supports. Final global verification stays with lead.' },
    { name: 'delegate_task', description: 'Assign a whole module or selected cells. Permitted task holders can delegate ONLY their current workScope to connected members; this atomically transfers writes, shrinks their local workScope, and creates a child task. Parent completion still verifies the original full scope. Optional scope={region:{min,max}} or {positions:[[x,y,z],...]}; omit for whole modules. coordinateSpace defaults to world; blueprint uses design.origin. Use disjoint scopes and a stable key for retries. Supply recipient, partIds, description, success; dependsOn uses returned task IDs, never ancestors or tasks waiting for you.' },
    { name: 'propose_task_share', description: 'Propose sharing part of your CURRENT workScope with a connected capable teammate. Supply stable key, recipient, partIds, explicit scope (region or positions), coordinateSpace, description and success. Does NOT transfer writes yet. Teammate must respond_task_share, then YOU commit_task_share between actions. Keep original goal; shared work remains part of your final responsibility.' },
    { name: 'respond_task_share', description: 'Accept or decline a proposal addressed to you using proposalId and accept. Inspect list_tasks proposals first. Acceptance does not start construction: finish this conversation with end_turn and wait for a runtime assignment. Do not accept work you cannot take.' },
    { name: 'commit_task_share', description: 'Original builder commits an accepted proposal between physical actions. Atomically releases the chosen cells from your local work and queues a scoped task for the available helper. Original goal is unchanged; complete_task waits for helpers and verifies your full original scope. Retry the same proposalId after a lost response. Use list_tasks and wait_for_team to follow results.' },
    { name: 'list_tasks', description: 'Read the current shared task queue, results and dependencies. Use wait_for_team while tasks execute; avoid polling in a model loop.' },
    { name: 'reassign_task', description: 'Reassign your existing blocked or queued task to a connected capable member. Running tasks cannot be reassigned until stopped. Never reassign to an ancestor waiting on it or to an unfinished descendant.' },
    { name: 'send_message', args: '{text:"消息内容",recipient?:"玩家名或其他agent名"}',
        description: 'Send a private message to the requesting user (default), another player in this conversation, or a teammate agent (delivery is direct when online, queued to its mailbox otherwise). Reply, ask a clarification question, report progress or coordinate work. Does not finish the task. No blueprint or creative mode required.' },
    { name: 'broadcast', args: '{text:"消息内容"}',
        description: 'Send one message to every teammate agent at once. Use for progress announcements, help requests and shared decisions; do not spam. The requesting user is not a broadcast recipient — use send_message for them.' },
    { name: 'list_peers', args: '{}',
        description: 'List teammate agents known to this process: name and online status. Use before send_message/broadcast to address teammates by their exact bot names.' },
    { name: 'claim_part', args: '{partId:"part-3"}',
        description: 'Acquire an exclusive lease on one blueprint part. Managed teams renew it with process heartbeats; delegated tasks already hold their assigned parts. Placement/dig actions require an effective lease and partId. Legacy standalone leases expire after five minutes.' },
    { name: 'release_part', args: '{partId:"part-3"}',
        description: 'Give up your lease on a part so a teammate can take it. Release parts you no longer need; your own claims can be re-claimed freely.' },
    { name: 'query_claims', args: '{}',
        description: 'Read the current team lease table: which teammate holds which part and when it expires. Check before choosing your next part to avoid conflicts.' },
    { name: 'observe_environment', args: '{region: {min:[x,y,z],max:[x,y,z]}}',
        description: 'Choose an explicit world-coordinate region from the task, expected footprint/height, access needs and current facts; there is no default scan. Expand or change the region when evidence is insufficient. Each edge <=256, volume<=2000000, within 256 of task origin. blocks filters exact names; excludeBlocks hides ground etc. offset/limit page matching cells; follow nextOffset until null. Counts cover the full region. Truncated cells are NOT air.' },
    { name: 'observe_cells', args: '{positions:[[x,y,z],...],coordinateSpace?:"world|blueprint"}',
        description: 'Read exactly the listed cells (up to 256), anywhere within 256 of task origin, without scanning a whole region. Use it for scattered spots: samples across a large site, specific blueprint cells, or rechecking a few failure coordinates. Every requested position is reported once with its block; unloaded cells are listed separately and are NOT air. Does not replace observe_environment for terrain overview.' },
    { name: 'inspect_block', args: '{position:[x,y,z]}',
        description: 'Read one loaded block, its properties, collision shape and six neighbors without moving or turning. Use this before digging to get the current exact block name.' },
    { name: 'look_at', args: '{position:[x,y,z]}',
        description: 'Turn to look at the center of this world block coordinate without moving. Returns orientation only; this does not enable vision or take a screenshot.' },
    { name: 'place_block', args: '{position:[x,y,z],block:"stone"}',
        description: 'Place exactly one block matching the current blueprint. Skip a matching existing block; never replaces an occupied block. Use dig_block first when replacement is needed.' },
    { name: 'place_row', args: '{start:[x,y,z],end:[x,y,z],block:"stone"}',
        description: 'Place one solid axis-aligned row, inclusive endpoints, up to 256 blocks. Only one coordinate may vary; reversed endpoints and a single cell are allowed.' },
    { name: 'place_rectangle', args: '{min:[x,y,z],max:[x,y,z],block:"stone"}',
        description: 'Fill ONE plane: min/max must have at least one equal coordinate. Blueprint box is NOT this action: a 7x2x5 box needs two XZ rectangles. A frame needs several rows, not a filled rectangle. Use inspect_part for valid suggestions. Up to 32768 cells.' },
    { name: 'place_cube', args: '{origin:[x,y,z],size:integer 1..32,block:"stone"}',
        description: 'Fill one solid equal-sided cube. origin is its minimum world coordinate; size is the number of blocks on EACH axis. No hollow/shell option. At most 32768 cells.' },
    { name: 'inspect_build', args: '{}',
        description: 'Independently verify all blueprint cells, or all registered demolition targets are air. Does not certify semantic goal satisfaction.' },
    { name: 'get_build_checklist', description: 'Read and verify every construction part from the actual world. Returns complete part counts, missing samples and current assignmentVersion. Never infer completion from a successful primitive or plan text.' },
    { name: 'inspect_part', description: 'Verify one part by partId, page its differences and obtain valid single-action suggestions for its final missing cells. Suggestions account for openings/replacements; they do not execute. CoordinateSpace=blueprint, partId and assignmentVersion are included.' },
    { name: 'list_materials', description: 'Search current-version placeable block items by English identifier substring, e.g. query="stairs" or "oak"; supports offset/limit. Any block with an inventory item is allowed, including gravity and special-placement blocks; entries carry placementNotes (gravity support, cake-style special placement, two-cell requirements). On failure, read the note, analyze, and substitute an equivalent block yourself before reporting upward.' },
    { name: 'inspect_blueprint', args: '{block?,layer?,offset?,limit?}',
        description: 'Read final compiled blueprint cells after openings/replacements, with relative and world coordinates and actual material. layer is relative Y. Page with offset/limit; use it when splitting frames or mixed materials into primitives.' },
    { name: 'set_demolition_target', args: '{region:{min,max},blocks?:["sandstone"]}',
        description: 'For standalone demolition, register the explicitly chosen loaded region to verify as air. Optional blocks selects observed material names. Without a filter the whole region must become air. Repeated calls only add targets, never discard unfinished ones. Does not dig. Use before demolition; finish needs this target, not a construction blueprint.' },
    { name: 'move_to', args: '{position:[x,y,z]}',
        description: 'Move to an observed supported standing cell. Walk first; a stalled or failed walk in creative mode automatically tries collision-checked flight around/over obstacles and lands. When hovering, fly and land directly. No digging or scaffolding. Prior observations remain available with a movement uncertainty marker; recheck only facts needed next.' },
    { name: 'fly_to', args: '{position:[x,y,z]}',
        description: 'Creative flight to an observed empty feet cell, then hover. Checks body clearance, loaded chunks, world height and worksite bounds. Tries direct, rise/across/descend and 3D detours; if all routes are blocked by walls, it can phase through them to escape (the server may correct it). Only lands in clear supported cells. Retain prior observations; choose any necessary local rechecks. Placement tools can also fly automatically to reach high faces.' },
    { name: 'land_at', args: '{position:[x,y,z]}',
        description: 'Fly to an empty feet cell above a full solid support and land, restoring walking physics. Never disables flight in midair. Retain prior observations; choose any necessary local rechecks.' },
    { name: 'dig_block', args: '{position:[x,y,z],expectedBlock:"stone"}',
        description: 'Remove one observed block within 256 of origin. Pass exact expectedBlock; recheck after approaching and verify air. Can fly to reach it. No automatic replacement.' },
    ...['row', 'rectangle', 'cube'].map(shape => ({ name: 'dig_' + shape,
        description: 'Explicitly remove one ' + shape + ' using the same geometry as place_' + shape +
            '. All non-air cells must match expectedBlock before starting. At most 32768 cells, top down; stops at first failure. Split mixed materials into separate primitives. Only within worksite and any registered demolition target.' }))
].map(tool => ({ ...tool, parameters: TOOL_SCHEMAS[tool.name] })));

export function compactResult(result) {
    if (!result || typeof result !== 'object') return result;
    if (!Array.isArray(result.differences)) return result;
    const counts = {};
    for (const cell of result.differences) counts[cell.reason] = (counts[cell.reason] ?? 0) + 1;
    const total = result.differenceCount ?? result.differences.length;
    return { ...result, differenceCount: total, differenceReasons: result.differenceReasons ?? counts,
        differences: result.differences.slice(0, 32), differencesTruncated: result.differencesTruncated || total > Math.min(result.differences.length, 32) };
}

export function requiredText(value, label, max = 1000) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + ' 不能为空或超出长度限制');
    return value.trim();
}

// 业务规则拒绝必须带上"下一步做什么"：真实日志里 29% 的错误链从未恢复，
// 模型在只有一行错误文本时只会重写措辞而不是执行前置步骤。recovery 写
// 动作指引（"先 set_demolition_target"），不是重复"哪里错了"。
export function ruleError(code, message, recovery, field) {
    const error = new Error(message);
    Object.assign(error, { code, ...(field ? { field } : {}), ...(recovery ? { recovery } : {}) });
    return error;
}

export function createBuildingTools({ world, job, design, checkpoint, onProgress, sendMessage, peers = null, team = null }) {
    let writePart;
    if (team?.runtime) {
        const original = world;
        world = { ...original,
            async place(cell, signal) {
                await team.assertWrite(job, writePart, [cell.pos]);
                signal?.throwIfAborted();
                return original.place({ ...cell, authorize: positions => team.assertWrite(job, writePart, positions) }, signal);
            },
            async digBlock(position, expected, signal) {
                await team.assertWrite(job, writePart, [position]);
                signal?.throwIfAborted();
                return original.digBlock(position, expected, signal, positions => team.assertWrite(job, writePart, positions));
            }
        };
    }
    world.setWorksite?.({ origin: job.origin, dimension: job.dimension });
    // 团队权限门禁：没有 team spec 时一切照旧；有 spec 时按角色过滤，
    // 并对 world 变更类动作加租约检查。权限在每次调用时重读（支持重组队形）。
    const teamGate = toolName => {
        if (job.teamCoordination && !['get_tool_help', 'send_message', 'broadcast', 'list_peers', 'list_tasks', 'respond_task_share', 'observe_environment', 'observe_cells',
            'inspect_block', 'look_at', 'move_to', 'fly_to', 'land_at'].includes(toolName)) throw new Error('队友协调回合只允许观察、移动和回复');
        if (!team) return;
        const spec = team.spec();
        if (!spec) return;
        const { allowed, role } = actionAllowed(spec, team.self, toolName);
        if (!allowed) {
            const error = new Error('团队角色 ' + role + ' 不允许执行 ' + toolName +
                '（team.json 由组织者配置；需要该能力请向用户申请调整角色）');
            Object.assign(error, { code: 'TEAM_ROLE_DENIED', field: 'name' });
            throw error;
        }
    };
    const requireLease = async partId => {
        if (!team || !team.spec()) return;
        if (!partId) throw new Error('团队施工必须指定 partId 并持有租约');
        const claims = await team.queryClaims(job);
        const held = claims.claims[partId];
        if (held && held.owner !== team.self) {
            const error = new Error('部件 ' + partId + ' 正被队友 ' + held.owner + ' 认领（' +
                new Date(held.expiresAt).toISOString() + ' 过期）。请换一个部件或用 query_claims 查看');
            Object.assign(error, { code: 'PART_LEASED', field: 'args.partId' });
            throw error;
        }
        if (!held || held.expiresAt <= Date.now()) throw new Error('请先 claim_part 认领该部件');
    };
    function snapshot() {
        const state = world.snapshot();
        if (state.dimension !== job.dimension) throw new Error('当前维度与任务维度不一致');
        return state;
    }

    function nearSite(position, radius = 256) {
        if (Math.hypot(...position.map((n, i) => n - job.origin[i])) > radius) {
            // 裸文本错误不给可恢复信息，模型只能盲改重试（pyramid 8cb3e954 事故：
            // 17.3 格 > 16 被拒后连续 3 次协议损坏触发熔断）。
            throw ruleError('OUT_OF_SITE', '操作位置超出本次工地范围：任务原点 [' + job.origin.join(',') +
                ']，允许半径 ' + radius + ' 格，本次提交 [' + position.map(Math.round).join(',') + '] 距离 ' +
                Math.round(Math.hypot(...position.map((n, i) => n - job.origin[i]))) + ' 格',
                '把 origin/坐标移动到任务原点 ' + radius + ' 格以内再重试；设计大型建筑时让设计原点尽量贴近任务原点，仅用形状偏移覆盖外围');
        }
    }

    function assignment() {
        if (!job.assignment) throw new Error('请先调用 design_blueprint skill 生成蓝图');
        return job.assignment;
    }

    function inspect() {
        snapshot();
        if (!job.assignment) {
            if (!job.demolition) throw ruleError('NO_ACCEPTANCE_TARGET', '没有验收目标：建造请先设计蓝图，纯拆除请先 set_demolition_target 注册完整目标',
                'Build: plan via update_plan first, then design_blueprint. Pure demolition: observe_environment over the full region, set_demolition_target, dig, then inspect_build.');
            job.lastInspection = inspectDemolition(job.demolition, world);
            return job.lastInspection;
        }
        const expected = job.teamTask ? taskChecklistParts(job).flatMap(part => part.cells) : prepareAssignment(assignment()).expected;
        const planned = new Set(expected.map(cell => cell.pos.join(',')));
        const extraAir = Object.keys(job.teamTask ? {} : job.removed ?? {}).filter(pos => !planned.has(pos))
            .map(pos => ({ pos: pos.split(',').map(Number), block: 'air' }));
        const result = inspectCells([...expected, ...extraAir], world);
        const checklist = refreshChecklist(job, world);
        job.lastInspection = { ...result, status: result.differences.length ? 'blocked' : 'completed',
            assignmentVersion: job.assignmentVersion, verifiedParts: checklist.verifiedParts, totalParts: checklist.totalParts };
        return job.lastInspection;
    }

    function completedCells() {
        const cells = new Map(Object.entries(job.placed));
        if (job.assignment) {
            for (const cell of prepareAssignment(job.assignment).targets) {
                if (world.read(cell.pos) === cell.block) cells.set(cell.pos.join(','), cell.block);
            }
        }
        return cells;
    }

    const supportedMaterials = () => world.supportedMaterials?.() ?? MATERIALS;
    function absoluteArgs(args) {
        if (args.coordinateSpace !== 'blueprint') return args;
        if (!job.design?.origin) throw new Error('coordinateSpace=blueprint 需要已有蓝图原点；拆除旧建筑请使用 world 坐标');
        const converted = { ...args, coordinateSpace: 'world' };
        for (const key of ['position', 'start', 'end', 'min', 'max', 'origin']) {
            if (args[key]) converted[key] = coordinates(args[key], key).map((n, i) => n + job.design.origin[i]);
        }
        if (args.scope) converted.scope = {
            ...(args.scope.positions ? { positions: args.scope.positions.map(pos => coordinates(pos, '范围坐标').map((n, i) => n + job.design.origin[i])) } : {}),
            ...(args.scope.region ? { region: Object.fromEntries(['min', 'max'].map(key => [key, coordinates(args.scope.region[key], '范围边界').map((n, i) => n + job.design.origin[i])])) } : {})
        };
        return converted;
    }

    async function digOne(position, expected, signal) {
        const key = position.join(',');
        const before = world.read(position);
        markObservationsStale(job, 'demolition_attempt');
        if (before == null) return { status: 'blocked', reason: 'unloaded', position };
        if (before === 'air') {
            job.removed ??= {};
            job.removed[key] ??= expected;
            delete job.placed[key];
            job.lastInspection = null;
            return { status: 'completed', reason: 'already_air', position, actual: before };
        }
        if (before !== expected) return { status: 'blocked', reason: 'target_changed', position, expected, actual: before };
        job.demolitionAttempts = (job.demolitionAttempts ?? 0) + 1;
        let reason;
        try { reason = await world.digBlock(position, expected, signal); }
        finally {
            job.lastInspection = null;
            if (world.read(position) === 'air') {
                job.removed ??= {};
                job.removed[key] = before;
                job.removalCount = (job.removalCount ?? 0) + 1;
                delete job.placed[key];
            }
        }
        signal?.throwIfAborted();
        const actual = world.read(position);
        if (actual === 'air') return { status: 'completed', position, expected, actual,
            reason: ['removed', 'already_air', null, undefined].includes(reason) ? 'removed' : 'dig_unconfirmed' };
        return { status: 'blocked', position, expected, actual, reason,
            ...(reason === 'unreachable' ? { hint: '该方块在视线/站位上不可达：可能被上方或周边方块遮挡。先拆正上方或外围的覆盖块（自上而下），或先 fly/land 到能看到它的位置再试' } : {}) };
    }

    async function prepareParallel(args = {}) {
        if (!team?.runtime || !roleOf(team.spec(), team.self).blueprintAuthority || job.teamTask) throw new Error('只有团队协调者可以准备并行施工');
        const spec = team.spec();
        const workers = Object.keys(spec.agents).filter(name => name !== team.self && capabilities(spec, name).canBuild &&
            edgeAllows(spec, team.self, name));
        // Persist the request key/version before RPC; a lost response can safely
        // retry the same atomic publication, without creating duplicate tasks.
        const request = job.parallelRequest ?? { key: 'parallel-v' + job.assignmentVersion,
            blueprintVersion: job.assignmentVersion, workers, axis: args.axis ?? 'auto' };
        if (!job.parallelRequest) {
            const candidate = partitionBuilding(assignment(), workers.length, request.axis);
            verifyParallelSite(candidate, world);
            job.parallelRequest = request;
            await checkpoint();
        }
        const result = await team.prepareParallel(job, request);
        job.assignment = result.assignment; job.assignmentVersion = result.assignmentVersion;
        job.lastInspection = null;
        refreshChecklist(job, world);
        await checkpoint('assignment', job.assignment);
        await checkpoint();
        return { status: result.status, assignmentVersion: result.assignmentVersion, tasks: result.tasks,
            note: '所有施工区已同时入队，等待各 worker 独立执行；使用 wait_for_team 等待并监督结果。' };
    }

    return {
        snapshot,
        inspect,
        inspectTask() {
            snapshot();
            if (!job.teamTask) throw new Error('当前不是委托任务');
            return job.teamTask.partIds.map(partId => {
                const result = inspectPart(job, world, partId, { fullTask: true });
                if (result.remaining) throw new Error('子任务部件尚未通过现场验收：' + partId);
                return { partId, total: result.total, remaining: result.remaining };
            });
        },
        // 委托范围内尚未验收的格数（0 表示范围完成）；供 wait_for_team 守卫使用，
        // 不像 inspectTask 那样在未完成时抛错。
        remainingInTask() {
            snapshot();
            if (!job.teamTask) return 0;
            return job.teamTask.partIds.reduce((sum, partId) =>
                sum + inspectPart(job, world, partId, { fullTask: true }).remaining, 0);
        },
        refreshChecklist() { snapshot(); return refreshChecklist(job, world); },
        async useSkill(name, args, signal) {
            if (job.teamCoordination) throw new Error('队友协调回合不能设计或修改建筑');
            if (team?.runtime && job.teamTask) throw new Error('子任务共享已有蓝图，请向团队入口提出设计修改');
            if (name !== 'design_blueprint') throw new Error('未知 skill：' + name);
            if (team?.spec() && !roleOf(team.spec(), team.self).blueprintAuthority) {
                throw new Error('缺少蓝图设计权限（blueprintAuthority）；' + roleOf(team.spec(), team.self).name +
                    ' 角色不能调用 design_blueprint。请与团队推选的设计者协调蓝图变更');
            }
            teamGate(name);
            if (job.siteIssue) throw new Error('施工位置尚需确认：' + job.siteIssue);
            if (job.demolition) throw new Error('本任务已有拆除目标，不能通过新建蓝图替代拆除验收');
            snapshot();
            if (!job.plan.requirements.length) throw new Error('先用 update_plan 记录原始需求和整体计划');
            const origin = args.origin == null ? job.origin : coordinates(args.origin, '设计原点');
            nearSite(origin, 32);
            if (job.originLocked && origin.some((n, i) => n !== job.origin[i])) throw new Error('用户指定的施工原点不能移动');
            const preserve = completedCells();
            const proposed = await design({ request: args.brief == null ? job.request : requiredText(args.brief, '设计要求'),
                origin, signal, runId: job.id, context: {
                    originalGoal: job.request, requirements: job.plan.requirements, userClarifications: job.clarifications ?? [], supportedMaterials: supportedMaterials(),
                    constructionChecklist: refreshChecklist(job, world),
                    observation: job.observation ?? null, blockObservations: job.blockObservations ?? [],
                    world: snapshot(), previousDesign: job.design ?? null,
                    feedback: job.events.filter(event => event.kind === 'feedback').slice(-6).map(event => ({
                        name: event.name, status: event.output?.status, message: event.output?.message,
                        reason: event.output?.reason, field: event.output?.field, expected: event.output?.expected,
                        differences: event.output?.differences?.slice(0, 8)
                    })), completedCount: preserve.size,
                    completedCells: [...preserve].slice(0, 64).map(([pos, block]) => ({ pos: pos.split(',').map(Number), block }))
                } });
            signal?.throwIfAborted();
            const coverage = job.plan.requirements.map(requirement => {
                const entry = proposed.coverage.find(item => item?.requirementId === requirement.id);
                return { requirementId: requirement.id, evidence: requiredText(entry?.evidence, '需求 ' + requirement.id + ' 的设计依据') };
            });
            const candidate = { version: 1, dimension: job.dimension, blueprint: proposed.blueprint,
                planning: { source: 'skill', skill: name, model: job.model, request: job.request, origin } };
            const planned = new Map(prepareAssignment(candidate).targets.map(cell => [cell.pos.join(','), cell.block]));
            for (const cell of candidate.blueprint.blocks) {
                nearSite(cell.pos);
                assertMaterial(cell.block, supportedMaterials());
            }
            // The world can change while the design model is responding.
            for (const [pos, block] of completedCells()) preserve.set(pos, block);
            for (const [pos, block] of preserve) {
                if (planned.get(pos) !== block) throw new Error('新设计必须保留已完成坐标 ' + pos + ' 的 ' + block + '；需要改变时先显式删除该方块');
            }
            // Validate the actual candidate, not a truncated terrain sample.
            // Publishing conflicting geometry would turn a build request into
            // an implicit demolition assignment for the workers.
            const site = inspectCells(prepareAssignment(candidate).expected, world);
            const conflicts = site.differences.filter(cell => cell.actual == null || cell.actual !== 'air');
            if (conflicts.length) {
                const unloaded = conflicts.filter(cell => cell.actual == null).length;
                throw Object.assign(new Error('蓝图尚未发布：候选场地有 ' + (conflicts.length - unloaded) +
                    ' 格已有方块冲突、' + unloaded + ' 格未加载。先观察并选择空闲场地；不得把新建任务默认变成拆除旧建筑。'), {
                    code: 'SITE_CONFLICT', field: 'origin/shapes',
                    expected: { bounds: candidate.blueprint.bounds, conflictCount: conflicts.length,
                        differences: conflicts.slice(0, 8), originShiftLimit: 16 }
                });
            }
            const nextDesign = { summary: proposed.summary, shapes: proposed.shapes, coverage, origin };
            const published = team?.runtime ? await team.publish(job, candidate, nextDesign) : null;
            job.assignment = candidate;
            job.assignmentVersion = published?.assignmentVersion ?? job.assignmentVersion + 1;
            job.design = nextDesign;
            delete job.parallelRequest;
            job.lastInspection = null;
            refreshChecklist(job, world);
            await checkpoint('assignment', candidate);
            return { status: 'designed', assignmentVersion: job.assignmentVersion, bounds: candidate.blueprint.bounds,
                blocks: candidate.blueprint.blocks.length, summary: proposed.summary, coverage,
                ...(team?.runtime ? { next: '蓝图已发布；由 lead 根据现场和成员情况选择整模块或模块内范围派单。系统不会自动分区或派单。' } : {}) };
        },
        async call(name, args = {}, signal) {
            signal?.throwIfAborted();
            validateToolArgs(name, args);
            args = absoluteArgs(args);
            teamGate(name);
            if (name === 'get_tool_help') {
                if (args.name === 'design_blueprint') return { status: 'observed', name: args.name,
                    description: 'Plan first; reuse sufficient observations or block inspections, and choose additional reads only for missing or uncertain facts. No mandatory scan before each design. Origin may move at most 16 blocks from the task origin unless locked by the user. Design alone; publication checks all target and explicit air cells for conflicts. Builders cannot redesign. After success delegate independent tasks before waiting.',
                    parameters: ACTION_SCHEMAS.skill.properties.args };
                const tool = TOOL_CATALOG.find(tool => tool.name === args.name);
                if (!tool) throw new Error('未知工具；请从当前 TOOLS 中选择名称');
                return { status: 'observed', name: tool.name, description: tool.description, parameters: tool.parameters };
            }
            if (name === 'prepare_parallel_build') return prepareParallel(args);
            if (['propose_task_share', 'respond_task_share', 'commit_task_share'].includes(name)) {
                if (!team?.runtime) throw new Error('需要团队运行时');
                const method = { propose_task_share: 'proposeShare', respond_task_share: 'respondShare', commit_task_share: 'commitShare' }[name];
                const result = await team[method](job, args);
                refreshChecklist(job, world);
                await checkpoint();
                return result;
            }
            if (['delegate_task', 'list_tasks', 'reassign_task'].includes(name)) {
                if (!team?.runtime) throw new Error('请从控制台启动团队后使用协作任务');
                if (name === 'delegate_task') {
                    const result = await team.delegate(job, args);
                    refreshChecklist(job, world);
                    await checkpoint();
                    return result;
                }
                if (name === 'reassign_task') return team.reassign(job, args);
                await team.refresh(job);
                return { status: 'observed', ...job.teamContext };
            }
            if (name === 'claim_part') {
                if (!team) throw new Error('本任务未配置团队协作通道');
                assignment();
                if (!checklistParts(job).some(part => part.id === args.partId)) throw new Error('未知部件');
                return team.claim(args.partId, job.assignmentVersion, job);
            }
            if (name === 'release_part') {
                if (!team) throw new Error('本任务未配置团队协作通道');
                return team.release(args.partId, job);
            }
            if (name === 'query_claims') {
                if (!team) return { claims: {}, note: '没有团队协作通道，部件无排他约束' };
                return team.queryClaims(job);
            }
            if (name === 'send_message') {
                const text = requiredText(args.text, '消息内容');
                const recipient = args.recipient ?? job.owner;
                if (typeof sendMessage !== 'function') throw new Error('消息发送能力未配置');
                const isPeer = peers?.isPeer?.(recipient);
                const isPlayer = !isPeer && (recipient === job.owner || job.messages?.some(item => item.role === 'user' && item.from === recipient));
                if (!isPlayer && !peers?.isPeer?.(recipient)) throw new Error('接收者必须是参与对话的玩家或已知的队友 agent');
                const result = isPlayer
                    ? await sendMessage(recipient, text, signal)
                    : await peers.sendToAgent(recipient, text, job);
                if (result?.status !== 'sent' && result?.status !== 'delivered') throw new Error('消息未发送成功');
                job.messages ??= [];
                job.messages.push({ role: 'assistant', to: recipient, content: text, at: new Date().toISOString() });
                if (job.messages.length > 40) job.messages.splice(0, job.messages.length - 40);
                return result;
            }
            if (name === 'broadcast') {
                if (!peers) throw new Error('本任务未配置队友通信通道');
                const text = requiredText(args.text, '消息内容');
                const results = await peers.broadcast(text, job);
                job.messages ??= [];
                job.messages.push({ role: 'assistant', to: '(team)', content: text, at: new Date().toISOString() });
                if (job.messages.length > 40) job.messages.splice(0, job.messages.length - 40);
                if (!Array.isArray(results)) return results;
                const delivered = results.filter(item => item.delivered).length;
                return { status: 'delivered', delivered, total: results.length, results };
            }
            if (name === 'list_peers') {
                if (!peers) return { status: 'observed', peers: [], note: '本任务没有可用的队友通道' };
                return { status: 'observed', peers: await peers.list() };
            }
            if (job.siteIssue && (PLACEMENT_ACTIONS.includes(name) || DEMOLITION_ACTIONS.includes(name) || name === 'set_demolition_target')) {
                throw new Error('施工位置尚需确认：' + job.siteIssue);
            }
            const state = snapshot();
            if (name === 'list_materials') {
                const query = (args.query ?? '').toLowerCase();
                const names = supportedMaterials().filter(material => material.includes(query));
                const offset = args.offset ?? 0, limit = args.limit ?? 32;
                return { status: 'observed', matched: names.length, nextOffset: offset + limit < names.length ? offset + limit : null,
                    materials: names.slice(offset, offset + limit).map(material => world.materialInfo?.(material) ?? { name: material }),
                    notes: Object.fromEntries(names.slice(offset, offset + limit)
                        .map(material => [material, placementNotes(material)]).filter(([, notes]) => notes.length)) };
            }
            if (name === 'observe_environment') {
                const region = bounds(args.region);
                nearSite(region.min);
                nearSite(region.max);
                const observation = { ...state, ...scanEnvironment(region, world, args) };
                rememberObservation(job, observation);
                return observation;
            }
            if (name === 'observe_cells') {
                for (const position of args.positions) nearSite(coordinates(position, '观察坐标'));
                const sampled = scanCells(args.positions, world);
                const observation = { ...state, kind: 'cells', positions: args.positions, ...sampled };
                rememberObservation(job, observation);
                return observation;
            }
            if (name === 'inspect_build') return inspect();
            if (name === 'get_build_checklist') return { status: 'observed', checklist: refreshChecklist(job, world) };
            if (name === 'inspect_part') {
                const result = inspectPart(job, world, args.partId, args);
                refreshChecklist(job, world);
                return { ...result, differenceReasons: result.reasons };
            }
            if (name === 'inspect_blueprint') {
                const origin = job.design?.origin ?? job.origin;
                const cells = prepareAssignment(assignment()).targets.filter(cell =>
                    (!args.block || args.block === cell.block) && (args.layer == null || cell.pos[1] - origin[1] === args.layer));
                const offset = args.offset ?? 0, limit = args.limit ?? 64;
                return { status: 'observed', origin, matched: cells.length, offset,
                    nextOffset: offset + limit < cells.length ? offset + limit : null,
                    cells: cells.slice(offset, offset + limit).map(cell => ({ ...cell,
                        relative: cell.pos.map((n, i) => n - origin[i]), actual: world.read(cell.pos) })) };
            }
            if (name === 'set_demolition_target') {
                if (job.assignment) throw new Error('已有建造蓝图：局部清理请用 dig 动作，纯拆除应作为独立任务');
                job.demolition = extendDemolitionTarget(job.demolition, args, world, nearSite);
                job.lastInspection = null;
                await checkpoint?.();
                return { ...inspect(), status: 'target_registered', targets: Object.keys(job.demolition.targets).length };
            }
            if (name === 'inspect_block' || name === 'look_at') {
                const position = coordinates(args.position, '目标坐标');
                nearSite(position);
                if (name === 'inspect_block') {
                    const result = await world.inspectBlock(position);
                    rememberBlockObservation(job, { ...result, position }, state);
                    return result;
                }
                const orientation = await world.lookAt(position, signal);
                signal?.throwIfAborted();
                return { status: 'looked', position, ...orientation };
            }
            if (['move_to', 'fly_to', 'land_at'].includes(name)) {
                const position = coordinates(args.position, '移动目标');
                nearSite(position);
                const method = { move_to: 'moveTo', fly_to: 'flyTo', land_at: 'landAt' }[name];
                let result;
                try { result = await world[method](position, signal); }
                finally { markObservationsStale(job, 'movement'); }
                signal?.throwIfAborted();
                const actual = world.snapshot().position;
                const reached = result && Array.isArray(actual) && actual.length === 3 &&
                    actual.every((n, i) => Number.isFinite(n) && Math.floor(n) === position[i]);
                return { status: reached ? ({ move_to: 'moved', fly_to: 'flown', land_at: 'landed' })[name] : 'unreachable',
                    target: position, position: actual, flying: world.snapshot().flying ?? false,
                    ...(!reached ? { reason: world.snapshot().navigation?.reason ??
                        (name === 'land_at' ? 'landing_unconfirmed' : 'flight_unconfirmed'),
                        recovery: 'Retrying the identical target repeats the failure. Change approach: fly_to a position with clear line of sight (or land_at supported ground) nearer the target first, then retry once; for placement targets prefer primitives whose cells have adjacent support.' } : {}) };
            }
            if (DEMOLITION_ACTIONS.includes(name)) {
                const primitive = compileDemolition(name, args);
                if (!job.assignment && !job.demolition) throw ruleError('NO_DEMOLITION_TARGET',
                    '纯拆除请先用 set_demolition_target 注册完整拆除范围，再执行 dig 动作',
                    'observe_environment over the whole intended region -> set_demolition_target(region) -> dig with expectedBlock read from the scan -> inspect_build.');
                if (team?.spec() || args.partId) await requireLease(args.partId);
                writePart = args.partId;
                if (team?.runtime) await team.assertWrite(job, args.partId, primitive.cells.map(cell => cell.pos));
                for (const cell of primitive.cells) {
                    nearSite(cell.pos);
                    if (job.demolition && !Object.hasOwn(job.demolition.targets, cell.pos.join(','))) throw ruleError('OUTSIDE_DEMOLITION_TARGET',
                        '删除坐标不在已登记拆除目标内：' + cell.pos.join(','),
                        'Digging requires prior registration: observe_environment over the full intended region, then set_demolition_target(region), then dig. Re-registering only appends; shrinking an unfinished target is not allowed.');
                }
                if (name === 'dig_block') {
                    job.lastRemoval = await digOne(primitive.cells[0].pos, args.expectedBlock, signal);
                    return job.lastRemoval;
                }
                await world.prepare(job.dimension, primitive.region, signal);
                const changed = primitive.cells.find(cell => !['air', args.expectedBlock].includes(world.read(cell.pos)));
                if (changed) return { status: 'blocked', reason: world.read(changed.pos) == null ? 'unloaded' : 'target_changed',
                    position: changed.pos, expected: args.expectedBlock, actual: world.read(changed.pos) };
                let failed;
                let attempts = 0;
                for (const cell of primitive.cells) {
                    signal?.throwIfAborted();
                    if (world.read(cell.pos) === 'air') continue;
                    attempts++;
                    let result;
                    try { result = await digOne(cell.pos, args.expectedBlock, signal); }
                    catch (error) { signal?.throwIfAborted(); result = { status: 'blocked', reason: 'dig_error', position: cell.pos, detail: error.message }; }
                    if (attempts % 25 === 0) {
                        onProgress?.({ action: name, attempts, total: primitive.cells.length });
                        await checkpoint?.();
                    }
                    if (result.status !== 'completed') { failed = result; break; }
                }
                const differences = primitive.cells.filter(cell => world.read(cell.pos) !== 'air')
                    .map(cell => ({ pos: cell.pos, block: 'air', actual: world.read(cell.pos),
                        reason: failed?.position?.every((n, i) => n === cell.pos[i]) ? failed.reason : 'not_attempted' }));
                job.lastRemoval = { status: differences.length ? 'blocked' : 'completed', action: name, attempts,
                    total: primitive.cells.length, verified: primitive.cells.length - differences.length,
                    differences, ...(failed ? { reason: failed.reason, detail: failed.detail } : {}) };
                return job.lastRemoval;
            }
            if (PLACEMENT_ACTIONS.includes(name)) {
                if (args.assignmentVersion != null && args.assignmentVersion !== job.assignmentVersion) throw new Error('蓝图版本已变化：动作版本 ' + args.assignmentVersion + '，当前版本 ' + job.assignmentVersion + '；请重新 inspect_part');
                if (team?.spec() || args.partId) await requireLease(args.partId);
                writePart = args.partId;
                const primitive = compilePlacement(name, args);
                if (team?.runtime) await team.assertWrite(job, args.partId, primitive.cells.map(cell => cell.pos));
                assertMaterial(args.block, supportedMaterials());
                const planned = new Map(prepareAssignment(assignment()).targets.map(cell => [cell.pos.join(','), cell.block]));
                const selectedPart = args.partId ? taskChecklistParts(job).find(part => part.id === args.partId) : null;
                if (args.partId && !selectedPart) throw new Error('未知部件 ' + args.partId + '；请查看当前施工清单');
                const partKeys = selectedPart && new Set(selectedPart.cells.map(cell => cell.pos.join(',')));
                for (const cell of primitive.cells) {
                    nearSite(cell.pos);
                    if (partKeys && !partKeys.has(cell.pos.join(','))) throw new Error('动作超出所选部件 ' + args.partId + '，请按 inspect_part 的最终格子拆分');
                    if (planned.get(cell.pos.join(',')) !== cell.block) {
                        const error = new Error('动作必须符合当前蓝图：' + cell.pos.join(',') + '，蓝图材料=' +
                            (planned.get(cell.pos.join(',')) ?? 'air/outside') + '，请求材料=' + cell.block +
                            '。当前蓝图版本=' + job.assignmentVersion + '。请 inspect_part 查询最终格子；frame/opening 不是实心面，蓝图修改须成功后才能按新设计施工');
                        Object.assign(error, { code: 'BLUEPRINT_MISMATCH', field: 'args', position: cell.pos,
                            recovery: 'Call inspect_part(partId) and execute its suggestions.actions verbatim (they carry correct block/partId/assignmentVersion); mismatched cells may need dig_block(expectedBlock=observed) first, then re-place.' });
                        throw error;
                    }
                }
                if (args.preview) return { ...inspectCells(primitive.cells, world), status: 'preview', region: primitive.region,
                    message: '仅预检坐标、材料与现场占用，未执行放置；不能保证之后的移动和放置成功' };
                const beforeParts = new Map(refreshChecklist(job, world).parts.map(part => [part.id, part.status]));
                // Journal confirmed placements even if the user's pause arrives during place().
                const trackedWorld = { ...world, async place(cell, placeSignal) {
                    job.placementAttempts++;
                    const affected = [[0, 0, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
                        .map(offset => cell.pos.map((n, i) => n + offset[i]))
                        .filter(pos => planned.get(pos.join(',')) === cell.block && world.read(pos) === 'air');
                    const beforePosition = world.snapshot().position;
                    try { return await world.place({ ...cell, expectedAt: pos =>
                        team?.runtime && !partKeys?.has(pos.join(',')) ? undefined : planned.get(pos.join(',')) }, placeSignal); }
                    finally {
                        const afterPosition = world.snapshot().position;
                        if (beforePosition?.some((n, i) => n !== afterPosition?.[i])) markObservationsStale(job, 'movement');
                        for (const pos of affected) if (world.read(pos) === cell.block) {
                            const key = pos.join(',');
                            job.placed[key] = cell.block;
                            if (job.removed) delete job.removed[key];
                        }
                    }
                } };
                let result;
                try {
                    result = await executePlacement(primitive, trackedWorld, { dimension: job.dimension, signal,
                        onProgress: info => onProgress?.(info) });
                } finally {
                    // The outer loop writes a checkpoint on success, failure and interruption.
                    job.lastInspection = null;
                    markObservationsStale(job, 'placement_attempt');
                }
                job.lastPlacement = compactResult(result);
                refreshChecklist(job, world);
                result.completedParts = job.checklist.parts.filter(part => part.status === 'verified' && beforeParts.get(part.id) !== 'verified')
                    .map(({ id, title, total }) => ({ id, title, total }));
                result.partProgress = job.checklist.parts.map(({ id, status, verified, total }) => ({ id, status, verified, total }));
                // 失败反馈附材料提示：agent 先自分析（换等价方块/调整站位），
                // 自行重试仍不行才上报队友或用户。
                if (result.status === 'blocked') {
                    const hints = [...new Set(result.differences?.map(cell => cell.block) ?? [])]
                        .flatMap(block => placementNotes(block)).filter(Boolean);
                    if (hints.length) result.hints = [...new Set(hints)];
                    result.selfHelp = '先根据 hints 自行分析并修正（换等价方块、调整顺序或站位）后重试；自行处理 2 次仍失败再上报队友/用户';
                }
                return result;
            }
            throw new Error('未知 tool：' + name);
        }
    };
}
