import { bounds, coordinates, prepareAssignment, MATERIALS } from './blueprint.js';
import { inspectCells } from './inspection.js';
import { compilePlacement, executePlacement, PLACEMENT_ACTIONS } from './placement-actions.js';
import { TOOL_SCHEMAS, validateToolArgs } from './action-protocol.js';
import { DEMOLITION_ACTIONS, compileDemolition, extendDemolitionTarget, inspectDemolition } from './demolition.js';
import { scanEnvironment, scanCells } from './observation.js';
import { assertMaterial, GRAVITY_MATERIALS } from './materials.js';
import { checklistParts, refreshChecklist, inspectPart } from './checklist.js';

export const TOOL_CATALOG = Object.freeze([
    { name: 'send_message', args: '{text:"消息内容",recipient?:"参与对话的玩家名"}',
        description: 'Send a private message to the requesting user (default) or another player who has sent input in this conversation. Reply, ask a clarification question or report progress. Does not finish the task. No blueprint, creative mode or nearby player is required.' },
    { name: 'observe_environment', args: '{region?: {min:[x,y,z],max:[x,y,z]}}',
        description: 'Read a region (each edge <=256, volume<=2000000, within 256 of task origin). Default scans near origin. blocks filters exact names; excludeBlocks hides ground etc. offset/limit page matching cells; follow nextOffset until null. Counts cover the full region. Truncated cells are NOT air.' },
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
    { name: 'list_materials', description: 'Search current-version placeable block items by English identifier substring, e.g. query="stairs" or "oak"; supports offset/limit. Only gravity/falling materials are disabled. Names of internal block states without an inventory item are not independent materials. Entries explain default-state/multi-cell placement.' },
    { name: 'inspect_blueprint', args: '{block?,layer?,offset?,limit?}',
        description: 'Read final compiled blueprint cells after openings/replacements, with relative and world coordinates and actual material. layer is relative Y. Page with offset/limit; use it when splitting frames or mixed materials into primitives.' },
    { name: 'set_demolition_target', args: '{region:{min,max},blocks?:["sandstone"]}',
        description: 'For standalone demolition, register the explicitly chosen loaded region to verify as air. Optional blocks selects observed material names. Without a filter the whole region must become air. Repeated calls only add targets, never discard unfinished ones. Does not dig. Use before demolition; finish needs this target, not a construction blueprint.' },
    { name: 'move_to', args: '{position:[x,y,z]}',
        description: 'Move to an observed supported standing cell. Walk first; a stalled or failed walk in creative mode automatically tries collision-checked flight around/over obstacles and lands. When hovering, fly and land directly. No digging or scaffolding. Observe again after moving.' },
    { name: 'fly_to', args: '{position:[x,y,z]}',
        description: 'Creative flight to an observed empty feet cell, then hover. Checks body clearance, loaded chunks, world height and worksite bounds. Tries direct, rise/across/descend and 3D detours; if all routes are blocked by walls, it can phase through them to escape (the server may correct it). Only lands in clear supported cells. Observe again after flying. Placement tools can also fly automatically to reach high faces.' },
    { name: 'land_at', args: '{position:[x,y,z]}',
        description: 'Fly to an empty feet cell above a full solid support and land, restoring walking physics. Never disables flight in midair. Observe again after landing.' },
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

export function createBuildingTools({ world, job, design, checkpoint, onProgress, sendMessage }) {
    world.setWorksite?.({ origin: job.origin, dimension: job.dimension });
    function snapshot() {
        const state = world.snapshot();
        if (state.dimension !== job.dimension) throw new Error('当前维度与任务维度不一致');
        return state;
    }

    function nearSite(position, radius = 256) {
        if (Math.hypot(...position.map((n, i) => n - job.origin[i])) > radius) throw new Error('操作位置超出本次工地范围');
    }

    function assignment() {
        if (!job.assignment) throw new Error('请先调用 design_blueprint skill 生成蓝图');
        return job.assignment;
    }

    function inspect() {
        snapshot();
        if (!job.assignment) {
            if (!job.demolition) throw new Error('没有验收目标：建造请先设计蓝图，纯拆除请先 set_demolition_target 注册完整目标');
            job.lastInspection = inspectDemolition(job.demolition, world);
            return job.lastInspection;
        }
        const { expected } = prepareAssignment(assignment());
        const planned = new Set(expected.map(cell => cell.pos.join(',')));
        const extraAir = Object.keys(job.removed ?? {}).filter(pos => !planned.has(pos))
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
        return converted;
    }

    async function digOne(position, expected, signal) {
        const key = position.join(',');
        const before = world.read(position);
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
            job.observation = null;
            if (world.read(position) === 'air') {
                job.removed ??= {};
                job.removed[key] = before;
                job.removalCount = (job.removalCount ?? 0) + 1;
                delete job.placed[key];
            }
        }
        signal?.throwIfAborted();
        const actual = world.read(position);
        return { status: actual === 'air' ? 'completed' : 'blocked', position, expected, actual,
            reason: actual === 'air' ? 'removed' : ['removed', 'already_air', null, undefined].includes(reason) ? 'dig_unconfirmed' : reason };
    }

    return {
        snapshot,
        inspect,
        refreshChecklist() { snapshot(); return refreshChecklist(job, world); },
        async useSkill(name, args, signal) {
            if (name !== 'design_blueprint') throw new Error('未知 skill：' + name);
            if (job.siteIssue) throw new Error('施工位置尚需确认：' + job.siteIssue);
            if (job.demolition) throw new Error('本任务已有拆除目标，不能通过新建蓝图替代拆除验收');
            snapshot();
            if (!job.plan.requirements.length) throw new Error('先用 update_plan 记录原始需求和整体计划');
            if (!job.observation) throw new Error('先观察环境，再设计蓝图');
            const origin = args.origin == null ? job.origin : coordinates(args.origin, '设计原点');
            nearSite(origin, 16);
            if (job.originLocked && origin.some((n, i) => n !== job.origin[i])) throw new Error('用户指定的施工原点不能移动');
            const preserve = completedCells();
            const proposed = await design({ request: args.brief == null ? job.request : requiredText(args.brief, '设计要求'),
                origin, signal, runId: job.id, context: {
                    originalGoal: job.request, requirements: job.plan.requirements, supportedMaterials: supportedMaterials(),
                    constructionChecklist: refreshChecklist(job, world),
                    observation: job.observation, previousDesign: job.design ?? null,
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
            job.assignment = candidate;
            job.assignmentVersion++;
            job.design = { summary: proposed.summary, shapes: proposed.shapes, coverage, origin };
            job.lastInspection = null;
            refreshChecklist(job, world);
            await checkpoint('assignment', candidate);
            return { status: 'designed', assignmentVersion: job.assignmentVersion, bounds: candidate.blueprint.bounds,
                blocks: candidate.blueprint.blocks.length, summary: proposed.summary, coverage };
        },
        async call(name, args = {}, signal) {
            signal?.throwIfAborted();
            validateToolArgs(name, args);
            args = absoluteArgs(args);
            if (name === 'send_message') {
                const text = requiredText(args.text, '消息内容');
                const recipient = args.recipient ?? job.owner;
                if (recipient !== job.owner && !job.messages?.some(item => item.role === 'user' && item.from === recipient)) {
                    throw new Error('只能回复实际参与本次对话的玩家');
                }
                if (typeof sendMessage !== 'function') throw new Error('消息发送能力未配置');
                const result = await sendMessage(recipient, text, signal);
                if (result?.status !== 'sent') throw new Error('消息未发送成功');
                job.messages ??= [];
                job.messages.push({ role: 'assistant', to: recipient, content: text, at: new Date().toISOString() });
                if (job.messages.length > 40) job.messages.splice(0, job.messages.length - 40);
                return result;
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
                    disabledGravity: [...GRAVITY_MATERIALS].filter(material => material.includes(query)) };
            }
            if (name === 'observe_environment') {
                const region = bounds(args.region ?? {
                    min: job.origin.map((n, i) => n - (i === 1 ? 1 : 5)),
                    max: job.origin.map((n, i) => n + (i === 1 ? 6 : 5))
                });
                nearSite(region.min);
                nearSite(region.max);
                job.observation = { ...state, ...scanEnvironment(region, world, args) };
                return job.observation;
            }
            if (name === 'observe_cells') {
                for (const position of args.positions) nearSite(coordinates(position, '观察坐标'));
                return { status: 'observed', ...scanCells(args.positions, world) };
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
                if (name === 'inspect_block') return world.inspectBlock(position);
                const orientation = await world.lookAt(position, signal);
                signal?.throwIfAborted();
                return { status: 'looked', position, ...orientation };
            }
            if (['move_to', 'fly_to', 'land_at'].includes(name)) {
                const position = coordinates(args.position, '移动目标');
                nearSite(position);
                const method = { move_to: 'moveTo', fly_to: 'flyTo', land_at: 'landAt' }[name];
                const result = await world[method](position, signal);
                signal?.throwIfAborted();
                job.observation = null;
                const actual = world.snapshot().position;
                const reached = result && Array.isArray(actual) && actual.length === 3 &&
                    actual.every((n, i) => Number.isFinite(n) && Math.floor(n) === position[i]);
                return { status: reached ? ({ move_to: 'moved', fly_to: 'flown', land_at: 'landed' })[name] : 'unreachable',
                    target: position, position: actual, flying: world.snapshot().flying ?? false,
                    ...(!reached ? { reason: world.snapshot().navigation?.reason ??
                        (name === 'land_at' ? 'landing_unconfirmed' : 'flight_unconfirmed') } : {}) };
            }
            if (DEMOLITION_ACTIONS.includes(name)) {
                const primitive = compileDemolition(name, args);
                if (!job.assignment && !job.demolition) throw new Error('纯拆除请先用 set_demolition_target 注册完整拆除范围，再执行 dig 动作');
                for (const cell of primitive.cells) {
                    nearSite(cell.pos);
                    if (job.demolition && !Object.hasOwn(job.demolition.targets, cell.pos.join(','))) throw new Error('删除坐标不在已登记拆除目标内：' + cell.pos.join(','));
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
                const primitive = compilePlacement(name, args);
                assertMaterial(args.block, supportedMaterials());
                const planned = new Map(prepareAssignment(assignment()).targets.map(cell => [cell.pos.join(','), cell.block]));
                const selectedPart = args.partId ? checklistParts(job).find(part => part.id === args.partId) : null;
                if (args.partId && !selectedPart) throw new Error('未知部件 ' + args.partId + '；请查看当前施工清单');
                const partKeys = selectedPart && new Set(selectedPart.cells.map(cell => cell.pos.join(',')));
                for (const cell of primitive.cells) {
                    nearSite(cell.pos);
                    if (partKeys && !partKeys.has(cell.pos.join(','))) throw new Error('动作超出所选部件 ' + args.partId + '，请按 inspect_part 的最终格子拆分');
                    if (planned.get(cell.pos.join(',')) !== cell.block) {
                        const error = new Error('动作必须符合当前蓝图：' + cell.pos.join(',') + '，蓝图材料=' +
                            (planned.get(cell.pos.join(',')) ?? 'air/outside') + '，请求材料=' + cell.block +
                            '。当前蓝图版本=' + job.assignmentVersion + '。请 inspect_part 查询最终格子；frame/opening 不是实心面，蓝图修改须成功后才能按新设计施工');
                        Object.assign(error, { code: 'BLUEPRINT_MISMATCH', field: 'args', position: cell.pos });
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
                    try { return await world.place({ ...cell, expectedAt: pos => planned.get(pos.join(',')) }, placeSignal); }
                    finally {
                        const afterPosition = world.snapshot().position;
                        if (beforePosition?.some((n, i) => n !== afterPosition?.[i])) job.observation = null;
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
                }
                job.lastPlacement = compactResult(result);
                refreshChecklist(job, world);
                result.completedParts = job.checklist.parts.filter(part => part.status === 'verified' && beforeParts.get(part.id) !== 'verified')
                    .map(({ id, title, total }) => ({ id, title, total }));
                result.partProgress = job.checklist.parts.map(({ id, status, verified, total }) => ({ id, status, verified, total }));
                return result;
            }
            throw new Error('未知 tool：' + name);
        }
    };
}
