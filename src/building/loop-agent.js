import { randomUUID } from 'node:crypto';
import { coordinates, prepareAssignment, MATERIALS } from './blueprint.js';
import { createBlueprintSkill } from './planner.js';
import { compactResult, createBuildingTools, requiredText } from './tools.js';
import { PLACEMENT_ACTIONS } from './placement-actions.js';
import { addTokenUsage, emptyTokenUsage, restoreTokenUsage } from './token-usage.js';
import { parseAction, protocolError, validateBatchStep } from './action-protocol.js';
import { DEMOLITION_ACTIONS, validateDemolitionTarget } from './demolition.js';
import { createProgressTracker, failureFingerprint } from './progress.js';

import { checklistParts } from './checklist.js';
import { decisionInstructions, recentModelEvents, compactDecisionContext, actionStats } from './decision-context.js';
import { roleOf } from './team-state.js';
import { scopeSummary, taskScope } from './task-scope.js';
import { markObservationsStale } from './observation-memory.js';

class LoopLimitError extends Error {}
class InputChangedError extends Error {}

// update_plan semantic failures must carry INVALID_PLAN so the loop's recovery
// hint and field/expected diagnostics reach the model; plain Errors only retry blindly.
const planError = (field, message, expected) => protocolError(field, message, expected, 'INVALID_PLAN');

export function createDecisionRequest(job, world, budget, agentName = 'builder', team = null) {
    const context = {
        ORIGINAL_GOAL: job.request, agentName, owner: job.owner, messages: job.messages,
        userClarifications: job.clarifications ?? [],
        TEAM_GOAL: job.teamGoal ?? null,
        coordinationOnly: job.teamCoordination ?? false,
        planProtocol: { existingRequirements: 'read-only; omit requirements when updating steps', progress: 'steps[].status and steps[].evidence' },
        origin: job.origin, originLocked: job.originLocked, siteIssue: job.siteIssue,
        plan: job.plan, world, observation: job.observation, blockObservations: job.blockObservations ?? [],
        materialCatalog: { lookup: 'list_materials', policy: 'Any registry block item is allowed (gravity and special-placement blocks included; list_materials returns placementNotes). On failure read the hints in the result, analyze and fix it yourself (substitute an equivalent block, adjust order/stance), retry up to 2 times, and only then report to teammates/the user.' },
        constructionChecklist: job.teamTask && job.checklist ? { ...job.checklist,
            parts: job.checklist.parts.filter(p => job.teamTask.partIds.includes(p.id)),
            nextPartId: job.checklist.parts.find(p => job.teamTask.partIds.includes(p.id) && p.status !== 'verified')?.id ?? null } : job.checklist ?? null,
        demolition: job.demolition ? { targets: Object.keys(job.demolition.targets).length,
            sample: Object.entries(job.demolition.targets).slice(0, 32).map(([pos, originalBlock]) => ({ pos, originalBlock })),
            details: 'All registered cells must be air. inspect_build returns remaining differences.' } : null,
        blueprint: job.assignment ? { version: job.assignmentVersion, bounds: job.assignment.blueprint.bounds,
            blocks: job.assignment.blueprint.blocks.length, design: job.design } : null,
        team: team?.spec() ? { self: team.self, role: roleOf(team.spec(), team.self).name,
            edges: team.spec().edges,
            runtime: team.runtime ?? false,
            // 紧凑任务视图：完整记录（长描述/凭据/scope）由 list_tasks 按需读取。
            tasks: (job.teamContext?.tasks ?? []).map(task => {
                const view = { id: task.id, key: task.key, to: task.to, partIds: task.partIds, status: task.status,
                    attempt: task.attempt, dependsOn: task.dependsOn, ...(task.claimStalled ? { claimStalled: true } : {}),
                    ...(task.parentId ? { parentId: task.parentId } : {}), scope: scopeSummary(task.scope) };
                if (task.description) view.description = task.description.slice(0, 80) + (task.description.length > 80 ? '…' : '');
                if (task.status === 'completed' && task.summary) view.summary = task.summary.slice(0, 100) + (task.summary.length > 100 ? '…' : '');
                if (task.status !== 'completed' && task.reason) view.reason = task.reason.slice(0, 120) + (task.reason.length > 120 ? '…' : '');
                return view;
            }),
            feed: job.teamFeed ?? [],
            unallocatedWork: !job.teamTask ? job.teamContext?.allocation?.filter(part => part.unallocated > 0 &&
                job.checklist?.parts.some(item => item.id === part.partId && item.remaining > 0)) : undefined,
            proposals: job.teamContext?.proposals ?? [],
            assignment: job.teamTask ? { id: job.teamTask.id, partIds: job.teamTask.partIds, success: job.teamTask.success,
                from: job.teamTask.from, teamGoal: job.teamGoal, scope: scopeSummary(job.teamTask.scope),
                workScope: scopeSummary(taskScope(job.teamTask)), parentId: job.teamTask.parentId,
                helpers: job.teamContext?.tasks?.filter(task => task.parentId === job.teamTask.id) ?? [] } : null,
            agents: Object.entries(team.spec().agents).map(([agentName, entry]) => ({ name: agentName, role: entry.role,
                ...job.teamContext?.peers?.find(peer => peer.name === agentName) })),
            note: team.runtime ? '委托范围自动持有并续约租约；仅施工 assignment.workScope。停止失败会报告 lead 重派，队友范围不要动。' :
                'claim_part 认领部件后施工；query_claims 查看占用；队友持有租约的部件不要动' } : null,
        lastPlacement: job.lastPlacement, lastRemoval: compactResult(job.lastRemoval), lastInspection: compactResult(job.lastInspection),
        removalCount: job.removalCount, confirmedPlacements: Object.keys(job.placed).length,
        selfStats: actionStats(job.events, job.decisions),
        recentEvents: recentModelEvents(job.events), budget
    };
    const protocol = decisionInstructions(job, team, agentName);
    const { context: compact, metrics } = compactDecisionContext(context);
    return { turns: [{ role: 'user', content: JSON.stringify(compact) }], ...protocol,
        contextMetrics: { ...metrics, instructionsChars: protocol.instructions.length,
            contractChars: JSON.stringify(protocol.nativeFunctions).length } };
}

function updatePlan(job, action) {
    const requirements = new Map(job.plan.requirements.map(item => [item.id, item]));
    const preservedRequirements = [];
    if (action.requirements != null && !Array.isArray(action.requirements)) throw planError('requirements', 'requirements 必须是数组');
    for (const entry of action.requirements ?? []) {
        const id = requiredText(entry?.id, '需求 ID', 40);
        const description = requiredText(entry.description, '需求描述');
        if (requirements.has(id)) {
            if (requirements.get(id).description !== description) preservedRequirements.push(id);
            continue;
        }
        requirements.set(id, { id, description });
    }
    if (requirements.size > 200) throw planError('requirements', '最多记录 200 项需求');
    if (!Array.isArray(action.steps) || !action.steps.length || action.steps.length > 200) throw planError('steps', '整体计划需要 1–200 步');
    const previous = new Map(job.plan.steps.map(step => [step.id, step]));
    if (new Set(action.steps.map(step => step.id)).size !== action.steps.length) throw planError('steps', '步骤 ID 重复');
    const incoming = new Map(action.steps.map(step => [step.id, step]));
    // patch=true updates existing IDs in place; submitted new IDs append in order
    // instead of failing — logs show the old rejection made models abandon the plan.
    const appended = action.patch ? action.steps.filter(step => !previous.has(step.id)).map(step => step.id) : [];
    const entries = action.patch ? [...job.plan.steps.map(step => ({ ...step, ...incoming.get(step.id) })),
        ...appended.map(id => incoming.get(id))] : action.steps;
    const known = new Map();
    const steps = entries.map((input, index) => {
        const entry = { ...previous.get(input.id), ...input };
        const id = requiredText(entry?.id, '步骤 ID', 40);
        for (const field of ['title', 'success']) if (!entry[field]?.trim()) throw planError(`steps[${index}].${field}`,
            '新步骤必须包含 ' + field + '；success 是可观察的完成标准，evidence 不能替代它',
            { id, title: '拆除并验收目标区域', success: '登记目标全部为空气', status: 'running' });
        if (known.has(id)) throw planError('steps', '步骤 ID 重复');
        const depends_on = entry.depends_on ?? [];
        if (!Array.isArray(depends_on) || depends_on.some(dep => !known.has(dep))) throw planError(`steps[${index}].depends_on`, '步骤依赖必须指向之前的步骤');
        const status = entry.status ?? 'pending';
        if (!['pending', 'running', 'done', 'blocked'].includes(status)) throw planError(`steps[${index}].status`, '步骤状态无效');
        const evidence = status === 'done' ? requiredText(entry.evidence, '完成依据') : '';
        if (status === 'done' && depends_on.some(dep => known.get(dep).status !== 'done')) throw planError(`steps[${index}].status`, '依赖未完成，不能把步骤标为完成');
        const step = { id, title: requiredText(entry.title, '步骤标题', 200),
            success: requiredText(entry.success, '步骤完成标准', 500), depends_on, status, evidence };
        known.set(id, step);
        return step;
    });
    job.plan = { requirements: [...requirements.values()], steps };
    return { status: 'planned', plan: job.plan, ...(appended.length ? {
        appendedSteps: appended, note: 'patch 已按提交顺序追加新步骤 ' + appended.join(', ') + ' 并保留原步骤。'
    } : {}), ...(preservedRequirements.length ? {
        preservedRequirements, note: '已有需求由系统维护，已保留原文；步骤更新已接受。进展请写入 steps 的 status/evidence，后续省略 requirements。'
    } : {}) };
}

function validateState(state) {
    if (state?.version !== 1 || state.kind !== 'building-loop' || !/^[a-zA-Z0-9_-]{1,80}$/.test(state.id ?? '') ||
        !['paused', 'waiting_user', 'waiting_team', 'blocked', 'thinking', 'observing', 'designing', 'building', 'verifying', 'moving', 'flying', 'landing', 'looking', 'demolishing', 'planning', 'stopping'].includes(state.status)) {
        throw new Error('无效或已结束的 Agent 状态文件');
    }
    requiredText(state.request, '原始任务');
    requiredText(state.dimension, '任务维度', 100);
    coordinates(state.origin, '施工原点');
    state.demolitionAttempts ??= 0;
    state.removalCount ??= 0;
    state.removed ??= {};
    if (state.demolition) validateDemolitionTarget(state.demolition, state.origin);
    if (state.demolition && state.assignment) throw new Error('纯拆除目标不能与新建蓝图同时验收');
    state.inputRevision ??= 0;
    state.messages ??= [{ role: 'user', from: state.owner, content: state.request }];
    // teamFeed 是团队生命周期通知的短动态流；旧状态没有该字段视为空。
    state.teamFeed ??= [];
    if (!Array.isArray(state.teamFeed) || state.teamFeed.length > 12 || state.teamFeed.some(item => !item ||
        typeof item.text !== 'string' || typeof item.kind !== 'string' || typeof item.from !== 'string')) throw new Error('保存的团队动态无效');
    state.clarifications ??= (state.events ?? []).filter(event => event.kind === 'user' && event.name === 'message')
        .map(event => ({ from: event.input.from, content: event.input.text }));
    if (!Array.isArray(state.clarifications) || state.clarifications.some(item => !item ||
        typeof item.content !== 'string' || !item.content.trim() || item.content.length > 1000)) throw new Error('保存的用户补充要求无效');
    if (!Number.isInteger(state.inputRevision) || state.inputRevision < 0 || !Array.isArray(state.messages) ||
        state.messages.length > 40 || state.messages.some(item => !item || !['user', 'assistant'].includes(item.role) ||
            typeof item.content !== 'string' || !item.content.trim() || item.content.length > 1000 ||
            !(item.role === 'assistant' && item.to === '(team)') && !/^[a-zA-Z0-9_]{1,16}$/.test((item.role === 'user' ? item.from : item.to) ?? ''))) {
        throw new Error('保存的对话消息无效');
    }
    for (const key of ['modelRequests', 'decisions', 'elapsedMs', 'placementAttempts', 'assignmentVersion', 'demolitionAttempts', 'removalCount']) {
        if (!Number.isFinite(state[key]) || state[key] < 0) throw new Error('状态计数无效：' + key);
    }
    state.tokenUsage = restoreTokenUsage(state.tokenUsage, state.modelRequests);
    if (!state.plan?.requirements?.some(item => item.id === 'goal' && item.description === state.request) ||
        !Array.isArray(state.plan.steps) || !Array.isArray(state.events) || state.events.length > 200 ||
        !state.placed || typeof state.placed !== 'object' || Array.isArray(state.placed)) throw new Error('状态缺少计划、事件或施工记录');
    if (state.plan.steps.length) updatePlan(state, state.plan);
    const cells = state.assignment ? new Map(prepareAssignment(state.assignment).targets.map(cell => [cell.pos.join(','), cell.block])) : new Map();
    if (state.assignment) checklistParts(state);
    if (state.assignment && state.assignment.dimension !== state.dimension) throw new Error('保存的蓝图维度与任务不一致');
    for (const [pos, block] of Object.entries(state.placed)) {
        if (cells.get(pos) !== block) throw new Error('保存的已放置坐标不属于蓝图');
    }
    if (!state.removed || typeof state.removed !== 'object' || Array.isArray(state.removed)) throw new Error('删除记录无效');
    for (const [key, block] of Object.entries(state.removed)) {
        const position = coordinates(key.split(',').map(Number), '删除记录坐标');
        if (position.join(',') !== key || Math.hypot(...position.map((n, i) => n - state.origin[i])) > 256 ||
            typeof block !== 'string' || !/^[a-z0-9_]{1,100}$/.test(block) || block === 'air') throw new Error('删除记录超出工地或缺少材料');
    }
    return state;
}

export function createBuildingLoop({ world, model, save, sendMessage, peers = null, team = null, agentName = 'builder', report = () => {}, maxModelRequests = 30, timeLimitMs = 20 * 60 * 1000, modelWaitReportMs = 30000 }) {
    if (!Number.isInteger(maxModelRequests) || maxModelRequests < 1 || !Number.isFinite(timeLimitMs) || timeLimitMs <= 0 ||
        !Number.isFinite(modelWaitReportMs) || modelWaitReportMs <= 0) throw new Error('Agent 循环预算无效');
    let job;
    let active;
    let saves = Promise.resolve();
    const history = new Map();

    function coordinatorHasWork() {
        if (!team?.runtime || job.teamTask || job.teamCoordination || job.teamPaused || job.teamContext?.paused) return false;
        const tasks = job.teamContext?.tasks ?? [];
        return tasks.some(task => task.status === 'running' || (task.status === 'queued' &&
            (task.dependsOn ?? []).every(id => tasks.some(dependency => dependency.id === id && dependency.status === 'completed')) &&
            !task.claimStalled && job.teamContext.peers?.some(peer => peer.name === task.to && peer.online && peer.canAcceptTask)));
    }

    function checkpoint(type = 'state', data = job, id = job.id) {
        const copy = structuredClone(data);
        const pending = saves.then(() => save(id, type, copy));
        saves = pending.catch(() => {});
        return pending;
    }

    function record(kind, name, input, output) {
        job.events.push({ at: new Date().toISOString(), kind, name, input, output: compactResult(output) });
        if (job.events.length > 200) job.events.splice(0, job.events.length - 200);
        report('step', { kind, name, output: compactResult(output) });
    }

    async function run() {
        if (active) throw new Error('当前任务仍在运行，请先暂停或取消');
        const session = { abort: new AbortController(), stop: null, requests: 0, finishing: false };
        session.done = new Promise(resolve => { session.resolveDone = resolve; });
        active = session;
        const { signal } = session.abort;
        const started = Date.now();
        const timer = setTimeout(() => session.abort.abort(new LoopLimitError('达到本轮运行时限，可继续任务')), timeLimitMs);
        let result;
        let repeatedFailure = '';
        let repeatCount = 0;
        let invalidDecisions = 0;
        let decisionTeamRevision = job.teamEventRevision ?? 0;
        const waitForWorkers = reason => {
            session.waitRevision = decisionTeamRevision;
            return { status: 'waiting_team', reason, automatic: true };
        };
        const countedModel = {
            async sendRequest(...args) {
                signal.throwIfAborted();
                const revision = job.inputRevision;
                if (session.requests >= maxModelRequests) throw new LoopLimitError('达到本轮模型请求上限，可继续任务');
                session.requests++;
                job.modelRequests++;
                const options = args[3] ?? {};
                const requestStarted = Date.now();
                let waiting;
                let usageReceived = false;
                args[3] = { ...options, onUsage(usage) {
                    if (usageReceived) return;
                    usageReceived = true;
                    addTokenUsage(job.tokenUsage, usage);
                    options.onUsage?.(usage);
                } };
                try {
                    await checkpoint();
                    signal.throwIfAborted();
                    const info = { request: job.modelRequests, purpose: options.purpose ?? 'decision' };
                    report('model_request', { ...info, status: 'started', elapsedMs: 0 });
                    waiting = setInterval(() => {
                        if (!signal.aborted) report('model_request', { ...info, status: 'waiting', elapsedMs: Date.now() - requestStarted });
                    }, modelWaitReportMs);
                    const response = await model.sendRequest(...args);
                    // Save the final model answer separately, including invalid JSON.
                    // Never put API credentials or full prompts in these audit files.
                    await checkpoint('response-' + String(job.modelRequests).padStart(4, '0'), {
                        at: new Date().toISOString(), request: job.modelRequests, purpose: options.purpose ?? 'decision',
                        inputRevision: revision, text: typeof response === 'string' ? response.slice(0, 64000) : null,
                        truncated: typeof response === 'string' && response.length > 64000
                    });
                    if (job.inputRevision !== revision) throw new InputChangedError('收到新的用户消息，丢弃旧决策并重新规划');
                    return response;
                } catch (error) {
                    if (typeof error.rawResponse === 'string') await checkpoint('response-' + String(job.modelRequests).padStart(4, '0'), {
                        at: new Date().toISOString(), request: job.modelRequests, purpose: options.purpose ?? 'decision',
                        inputRevision: revision, text: error.rawResponse.slice(0, 64000), truncated: error.rawResponse.length > 64000,
                        error: { code: error.code, field: error.field }
                    });
                    throw error;
                } finally {
                    clearInterval(waiting);
                    if (!usageReceived) job.tokenUsage.unreportedRequests++;
                    await checkpoint();
                    if (!signal.aborted && job.inputRevision !== revision) throw new InputChangedError('收到新的用户消息，重新决策');
                }
            }
        };
        let tools;
        try {
            if (team?.runtime && !job.teamRunId) await team.openRun(job);
            if (team?.runtime && !job.teamTask && !job.teamCoordination) await team.resume(job);
            job.supportedMaterials = world.supportedMaterials?.() ?? MATERIALS;
            tools = createBuildingTools({ world, job, design: createBlueprintSkill(countedModel), checkpoint, sendMessage, peers, team,
                onProgress: info => report('progress', info) });
            job.status = 'thinking';
            // The model chooses whether and where to observe from the task and
            // current snapshot. Never silently scan a fixed region on start/resume.
            // Retain evidence across waits/resumes; the model decides whether
            // its age, coverage and possible changes warrant another read.
            markObservationsStale(job, 'round_resumed');
            job.lastInspection = null;
            await checkpoint();
            const trackProgress = createProgressTracker(job, world);
            while (!result) {
                signal.throwIfAborted();
                if (session.requests >= maxModelRequests) throw new LoopLimitError('达到本轮模型请求上限，可继续任务');
                job.status = 'thinking';
                job.decisions++;
                let action;
                let output;
                const decisionRevision = job.inputRevision;
                const teamRevision = job.teamEventRevision ?? 0;
                decisionTeamRevision = teamRevision;
                try {
                    if (team?.runtime) await team.refresh(job);
                    if (job.teamContext?.paused) {
                        job.teamPaused = true;
                        throw new LoopLimitError('团队工程已暂停，等待协调者恢复');
                    }
                    tools.refreshChecklist();
                    const request = createDecisionRequest(job, world.snapshot(), {
                        remainingModelRequests: maxModelRequests - session.requests,
                        remainingMs: Math.max(0, timeLimitMs - (Date.now() - started))
                    }, agentName, team);
                    const nativeProtocol = (model.decisionProtocol ?? (model.provider === 'DeepSeek' ? 'native_functions' : 'json_action')) === 'native_functions';
                    const instructions = nativeProtocol ? request.nativeInstructions : request.instructions;
                    const text = await countedModel.sendRequest(request.turns, instructions,
                        null, { signal, runId: job.id, purpose: 'decision', nativeFunctions: request.nativeFunctions,
                            contextMetrics: { ...request.contextMetrics, instructionsChars: instructions.length } });
                    signal.throwIfAborted();
                    action = parseAction(text);
                    if (job.teamCoordination && !['tool', 'batch', 'end_turn', 'blocked'].includes(action.action)) throw new Error('当前仅为队友协调回合：观察、让路、回复后 end_turn，不能修改施工任务');
                    // Persist the proposed action before invoking anything with side effects.
                    record('decision', action.action, action, { status: 'selected' });
                    await checkpoint();
                    signal.throwIfAborted();
                    if (job.inputRevision !== decisionRevision) throw new InputChangedError('收到新的用户消息，重新决策');
                    if (action.action === 'update_plan') output = updatePlan(job, action);
                    if (action.action === 'tool') {
                        job.status = PLACEMENT_ACTIONS.includes(action.name) ? 'building' : DEMOLITION_ACTIONS.includes(action.name) ? 'demolishing' :
                            ({ observe_environment: 'observing', observe_cells: 'observing', inspect_block: 'observing', look_at: 'looking',
                                inspect_build: 'verifying', move_to: 'moving', fly_to: 'flying', land_at: 'landing', dig_block: 'demolishing' })[action.name] ?? 'thinking';
                        output = await tools.call(action.name, action.args, signal);
                    }
                    if (action.action === 'batch') {
                        // A batch is sequential tool steps under the same budget and
                        // validation as single calls; the first failure stops it.
                        const preview = { plan: structuredClone(job.plan) };
                        for (const step of action.steps) if (step.name === 'update_plan') {
                            if (job.teamCoordination) throw new Error('队友协调回合不能修改施工计划');
                            updatePlan(preview, step.args);
                        }
                        const results = [];
                        for (const [index, step] of action.steps.entries()) {
                            signal?.throwIfAborted();
                            const args = step.args ?? {};
                            validateBatchStep(step.name, args);
                            job.status = PLACEMENT_ACTIONS.includes(step.name) ? 'building' : DEMOLITION_ACTIONS.includes(step.name) ? 'demolishing' : 'thinking';
                            try {
                                const result = step.name === 'update_plan' ? updatePlan(job, args) : await tools.call(step.name, args, signal);
                                results.push({ index, name: step.name, status: result?.status ?? 'ok', result: compactResult(result) });
                                record('tool', step.name, step.args, compactResult(result));
                                if (['error', 'blocked'].includes(results.at(-1).status)) break;
                            } catch (error) {
                                signal?.throwIfAborted();
                                results.push({ index, name: step.name, status: 'error', message: error.message });
                                break;
                            }
                        }
                        const failed = results.find(item => item.status === 'error' || item.status === 'blocked');
                        output = { status: failed ? 'blocked' : 'completed', action: 'batch',
                            steps: results, executed: results.length, ...(failed ? { failedAt: failed.index, reason: failed.message ?? failed.result?.reason } : {}) };
                    }
                    if (action.action === 'skill') {
                        job.status = 'designing';
                        if (!job.plan.steps.length) throw protocolError('steps',
                            '请先制定整体计划：design_blueprint 在计划存在后才被接受',
                            { steps: [{ id: 's1', title: '设计并验收', success: '现场与蓝图一致', status: 'running' }] },
                            'INVALID_PLAN');
                        output = await tools.useSkill(action.name, action.args, signal);
                    }
                    if (action.action === 'blocked') {
                        result = { status: 'blocked', reason: requiredText(action.reason, '阻塞原因') };
                        output = result;
                    }
                    if (action.action === 'wait_for_team') {
                        if (!team?.runtime) throw new Error('没有团队运行时');
                        // 持有正在执行的委托且没有未完成协作者时，等待必须有
                        // 唤醒源：task_result 事件只发给 lead 与发起者，等待队友
                        // 任务结束的 builder 永远等不到。范围已全部验收就直接
                        // 指路 complete_task；否则挂短超时自唤醒并注入事实反馈。
                        if (job.teamTask && !job.teamContext?.tasks.some(task => task.parentId === job.teamTask.id && task.status !== 'completed')) {
                            const remaining = tools.remainingInTask();
                            if (!remaining) throw new Error('本委托范围内的部件已全部现场验收通过，没有等待中的协作者；请直接 complete_task 结束本任务。任务描述中超出 workScope 的后续层属于其他排队任务，不是本任务的完成条件');
                            if ((job.teamEventRevision ?? 0) === teamRevision) {
                                session.waitTimeout = setTimeout(() => {
                                    // waiting_team 挂起时 active 已释放；仅当任务仍在
                                    // 等待且未被其他入口唤醒/接管时重启决策循环。
                                    if (active || job.status !== 'waiting_team') return;
                                    record('feedback', 'team_wait_timeout', {},
                                        { status: 'received', message: '等待团队事件超时：队友任务结果事件不会发送给执行者。检查 constructionChecklist/inspect_part——workScope 内工作（剩余 ' + remaining + ' 格）未完成时继续施工；已全部验收则 complete_task' });
                                    run().catch(error => report('team_error', { reason: error.message }));
                                }, 45000);
                                session.waitTimeout.unref?.();
                            }
                        }
                        if (!job.teamTask && !coordinatorHasWork()) {
                            // "没有可执行任务"可能是运行时接管尚未完成（进程退出
                            // 检测、重派与 sweep 都是秒级粒度）。转等待事件而非立刻
                            // 报错：重派/结束事件会推进 revision 并唤醒。
                            if (job.teamContext?.tasks?.some(task => !['completed', 'cancelled', 'failed'].includes(task.status))) {
                                session.waitRevision = teamRevision;
                                result = { status: 'waiting_team', reason: '暂无正在执行或可领取的子任务，等待运行时接管/结算事件', automatic: true };
                                output = { ...result, note: 'runtime takeover may still be in progress; task events will wake this run' };
                            } else throw new Error('没有正在执行或可领取的子任务。检查 team.agents 的 canAcceptTask 和任务 claimStalled；用 reassign_task(taskId, recipient) 重派阻塞或未领取的任务，用户主动暂停的成员需要用户恢复');
                        }
                        else if ((job.teamEventRevision ?? 0) !== teamRevision) output = { status: 'received', message: '有新的团队事件，请读取后继续决策' };
                        else {
                            session.waitRevision = teamRevision;
                            result = { status: 'waiting_team', reason: requiredText(action.reason, '等待原因') };
                            output = result;
                        }
                    }
                    if (action.action === 'complete_task') {
                        if (!job.teamTask) throw new Error('当前不是团队子任务，请使用 finish');
                        if (job.teamContext?.tasks.some(task => task.parentId === job.teamTask.id && task.status !== 'completed')) throw new Error('协作子任务尚未完成，请 wait_for_team 或联系 lead 处理阻塞');
                        if (!job.plan.steps.length || job.plan.steps.some(step => step.status !== 'done')) throw new Error('子任务计划仍有未完成步骤');
                        result = { status: 'completed', summary: requiredText(action.summary, '完成说明'), teamEvidence: tools.inspectTask() };
                        output = result;
                    }
                    if (['end_turn', 'wait_for_user'].includes(action.action)) {
                        if (!job.teamCoordination && job.messages.at(-1)?.role !== 'assistant') throw new Error('请先用 send_message 回复或向用户提问');
                        if (action.action === 'end_turn') {
                            if (job.assignment || job.demolition || job.plan.steps.length || job.placementAttempts || job.demolitionAttempts) {
                                throw new Error('建筑任务不能用 end_turn 跳过验收，请使用 finish 或 wait_for_user');
                            }
                            result = { status: 'completed', outcome: 'conversation' };
                            if (team?.runtime && !job.teamTask && !job.teamCoordination) await team.finish(job);
                        } else result = { status: 'waiting_user', reason: requiredText(action.reason, '待澄清事项') };
                        output = result;
                    }
                    if (action.action === 'finish') {
                        if (job.teamTask) throw new Error('请用 complete_task 完成自己的委托部件');
                        if (team?.spec()) {
                            const role = roleOf(team.spec(), team.self);
                            if (!role.finishGate) {
                                throw new Error('缺少全局验收权限，请向团队入口汇报完成情况');
                            }
                        }
                        const inspection = tools.inspect();
                        if (inspection.differences.length) throw Object.assign(
                            new Error('现场验收尚未通过：' + JSON.stringify(compactResult(inspection))),
                            { code: 'SITE_DIFFERENCES', recovery: 'Read differences: missing cells -> place via inspect_part suggestions; occupied/wrong-material cells -> dig_block(expectedBlock=observed) then place. Re-run inspect_build before finishing.' });
                        if (job.assignment && job.checklist.parts.some(part => part.status !== 'verified')) throw Object.assign(
                            new Error('部件验收尚未全部通过，请查看施工清单'),
                            { code: 'PARTS_UNVERIFIED', recovery: 'get_build_checklist -> inspect_part(nextPartId) -> execute suggestions; every part reaches verified before finish.' });
                        if (!job.plan.steps.length || job.plan.steps.some(step => step.status !== 'done')) throw Object.assign(
                            new Error('整体计划仍有未完成步骤：' + job.plan.steps.filter(step => step.status !== 'done').map(step => step.id).join(', ')),
                            { code: 'PLAN_INCOMPLETE', recovery: 'Steps with observed evidence should be marked done via update_plan {patch:true, steps:[{id, status:"done", evidence:"observed fact"}]}; genuinely unfinished steps need construction or inspection first.' });
                        const review = job.plan.requirements.map(requirement => {
                            const entry = action.requirementReview?.find(item => item?.requirementId === requirement.id);
                            if (entry?.satisfied !== true) throw new Error('尚未确认原始需求 ' + requirement.id);
                            return { requirementId: requirement.id, satisfied: true, evidence: requiredText(entry.evidence, '需求完成依据') };
                        });
                        const summary = requiredText(action.summary, '完成说明');
                        if (team?.runtime) await team.finish(job);
                        result = { ...inspection, status: 'completed', summary,
                            structuralVerification: 'machine_verified', semanticVerification: 'model_reported', requirementReview: review };
                        output = result;
                    }
                    signal.throwIfAborted();
                } catch (error) {
                    if (signal.aborted || error instanceof LoopLimitError) throw error;
                    if (['API_TIMEOUT', 'API_NETWORK_ERROR', 'API_HTTP_ERROR'].includes(error.code)) {
                        const reason = error.code === 'API_TIMEOUT' ? '模型请求等待 ' + Math.round(error.timeoutMs / 1000) +
                            ' 秒后超时，已保存进度。请检查 API 服务或推理配置，然后发送“继续”重试' :
                            '模型服务请求失败' + (error.httpStatus ? '（HTTP ' + error.httpStatus + '）' : '') +
                            '，已保存进度。请检查网络、额度或 API 配置，然后发送“继续”重试';
                        result = { status: 'paused', reason };
                    }
                    // 业务规则错误的 recovery 写的是"下一步动作"，不能被协议
                    // 恢复提示覆盖；协议错误才使用通用格式指引。
                    const protocolRecovery = ['INVALID_DECISION', 'INVALID_ARGUMENT', 'INVALID_PLAN', 'API_INVALID_RESPONSE', 'TEAM_ROLE_DENIED'].includes(error.code) ?
                        ((model.decisionProtocol === 'native_functions' || model.provider === 'DeepSeek') ?
                            'Correct the named field using expected, then call the provided native function directly. No submit_action/tool/batch wrapper or action field. Tool calls and update_plan may share a response; design/wait/finish must be called alone. New plan steps require id,title,success; patch=true updates existing steps and appends new IDs in order.' :
                            'Correct the named field using expected. The response must be ONE JSON object with a top-level "action" field — using the action name as the only top-level key (e.g. {"update_plan":{...}}) is invalid; write {"action":"update_plan",...} instead. Tool example: {"action":"tool","name":"inspect_build","args":{}}. New plan step requires id,title,success; patch=true updates existing steps and appends new IDs in order.') : null;
                    const blueprintRecovery = ['INVALID_BLUEPRINT_JSON', 'INVALID_BLUEPRINT_GEOMETRY'].includes(error.code) ?
                        'The design model could not compile its draft after repair. Use the reported field/message to correct the brief or choose a buildable origin only if needed, then call design_blueprint again. Tool help alone does not change the draft.' : null;
                    const recovery = protocolRecovery ?? blueprintRecovery ?? error.recovery;
                    output = { status: error instanceof InputChangedError ? 'superseded' : 'error', message: error.message,
                        ...(error.code ? { code: error.code } : {}),
                        ...(error.field ? { field: error.field, expected: error.expected } : {}),
                        ...(error.position ? { position: error.position } : {}),
                        ...(recovery ? { recovery } : {}),
                        // 被拒动作的紧凑摘要：让模型直接对照"我提交了什么"与错误，
                        // 而不是只看到错误文本后重写措辞。
                        ...(action && error instanceof InputChangedError === false && action.action ? { rejectedAction: compactResult({
                            action: action.action, ...(action.name ? { name: action.name } : {}), ...(action.args ? { args: action.args } : {})
                        }) } : {}) };
                }
                record('feedback', action?.name ?? action?.action ?? 'decision_error', action ?? {}, output);
                await checkpoint();
                if (job.inputRevision !== decisionRevision) result = null;
                invalidDecisions = ['INVALID_DECISION', 'INVALID_ARGUMENT', 'INVALID_PLAN', 'API_INVALID_RESPONSE'].includes(output?.code) ? invalidDecisions + 1 : 0;
                if (!result && invalidDecisions >= 3) result = { status: 'paused',
                    reason: '模型连续三次返回不符合当前函数或动作协议的调用，已保存进度及 response 原始响应日志。可发送“继续”重试' };
                const progress = trackProgress(action, output);
                // A coordinator's repeated reads do not mean its workers have
                // failed. Stop spending model calls and await task events.
                if (!result && progress.idle >= 3 && coordinatorHasWork()) {
                    if ((job.teamEventRevision ?? 0) !== teamRevision) continue;
                    result = waitForWorkers('子任务仍在执行或可领取；协调者重复查询无新进展，已转为等待团队事件，施工继续');
                }
                const fingerprint = failureFingerprint(action, output);
                repeatCount = fingerprint && fingerprint === repeatedFailure && !progress.progressed ? repeatCount + 1 : (fingerprint ? 1 : 0);
                repeatedFailure = fingerprint;
                if (!result && repeatCount >= 3) result = { status: 'blocked', reason: '相同操作连续三次没有进展，请检查现场或补充条件' };
                if (!result && progress.idle >= 6) result = { status: 'paused',
                    reason: '连续六次决策没有获得新现场信息或推进施工，已保存进度，避免重复更新计划和空转；可补充要求后继续' };
            }
        } catch (error) {
            const reason = signal.aborted ? signal.reason : error;
            result = { status: session.stop ?? (reason instanceof LoopLimitError ? 'paused' : 'blocked'), reason: reason.message };
            if (!session.stop && reason instanceof LoopLimitError && team?.runtime && !job.teamTask && !job.teamCoordination) {
                // The final call may have delegated work after our last read.
                try { await team.refresh(job); } catch { /* Keep the original failure if runtime is unavailable. */ }
            }
            if (!session.stop && reason instanceof LoopLimitError && coordinatorHasWork()) {
                result = waitForWorkers('协调者本轮预算已用完，子任务继续执行；等待团队事件后恢复协调');
            }
        } finally {
            session.finishing = true;
            clearTimeout(timer);
            clearTimeout(session.waitTimeout);
            if (tools && (job.assignment || job.demolition) && result?.status !== 'completed') {
                try { result = { ...tools.inspect(), ...result }; }
                catch { /* A disconnect or dimension change can make final inspection unavailable. */ }
            }
            job.elapsedMs += Date.now() - started;
            if (job.teamTask && result?.status === 'paused' && !session.stop && !job.teamPaused) {
                result = { ...result, status: 'blocked', reason: result.reason + '；已报告协调者，可重派此任务' };
            }
            // Exhausting a chat-only round must not strand the worker. Explicit
            // user/team pauses still require resume and never grant work rights.
            if (job.teamCoordination && result?.status === 'paused' && !session.stop && !job.teamPaused) {
                result = { ...result, status: 'blocked', reason: result.reason + '；协调回合已结束，等待正式任务' };
            }
            if (team?.runtime && !job.teamTask && !job.teamCoordination &&
                (result?.status === 'blocked' || (result?.status === 'paused' && !session.stop && !job.teamPaused))) {
                result = { ...result, status: 'failed' };
            }
            job.status = result?.status ?? 'blocked';
            job.result = { ...result, status: job.status, runId: job.id, modelRequests: job.modelRequests,
                decisions: job.decisions, roundModelRequests: session.requests, elapsedMs: job.elapsedMs,
                placementAttempts: job.placementAttempts, confirmedPlacements: Object.keys(job.placed).length,
                demolitionAttempts: job.demolitionAttempts, removalCount: job.removalCount,
                tokenUsage: structuredClone(job.tokenUsage), stopRequested: !!session.stop };
            try {
                await checkpoint();
                await checkpoint('result', job.result);
                await team?.settle?.(job, job.result);
            } finally {
                history.set(job.owner, structuredClone(job.messages));
                active = null;
                session.resolveDone();
                report('result', job.result);
                // A task may finish between the last context read and saving
                // waiting_team. Do not lose an event delivered in that window.
                if (job.status === 'waiting_team' && session.waitRevision !== undefined &&
                    (job.teamEventRevision ?? 0) !== session.waitRevision) {
                    const waitingJob = job;
                    queueMicrotask(() => {
                        if (!active && job === waitingJob && job.status === 'waiting_team' && !job.teamPaused) {
                            run().catch(error => report('team_error', { reason: error.message }));
                        }
                    });
                }
            }
        }
        return job.result;
    }

    const controller = {
        start({ request, origin, dimension, owner, originLocked = false, siteIssue = null, teamAssignment = null, coordination = null }) {
            if (active) throw new Error('当前任务仍在运行，请先暂停或取消');
            const content = requiredText(request, '用户消息');
            const messages = [...(history.get(owner) ?? []), { role: 'user', from: owner, content, at: new Date().toISOString() }].slice(-40);
            job = { version: 1, kind: 'building-loop', id: randomUUID(), request: content,
                origin: coordinates(origin, '施工原点'), dimension: requiredText(dimension, '维度', 100), owner,
                originLocked, siteIssue, messages, clarifications: [], inputRevision: 0, model: model.modelName ?? 'configured_model', status: 'planning',
                plan: { requirements: [{ id: 'goal', description: request.trim() }], steps: [] },
                assignment: null, assignmentVersion: 0, design: null, demolition: null, placed: {}, removed: {}, events: [],
                observation: null, blockObservations: [],
                modelRequests: 0, decisions: 0, placementAttempts: 0, demolitionAttempts: 0, removalCount: 0, elapsedMs: 0,
                tokenUsage: emptyTokenUsage() };
            if (teamAssignment) {
                const { task, run: assignedRun } = teamAssignment;
                job.teamRunId = assignedRun.id; job.teamTask = structuredClone(task); job.teamGoal = assignedRun.request;
                job.assignment = structuredClone(assignedRun.assignment); job.assignmentVersion = assignedRun.blueprintVersion;
                job.design = structuredClone(assignedRun.design);
            }
            if (coordination) {
                job.teamRunId = coordination.runId; job.teamCoordination = true; job.teamGoal = coordination.payload.context.request;
                job.teamEvents = [coordination.id];
                job.messages = [{ role: 'user', from: coordination.from, content: coordination.payload.text, at: new Date().toISOString() }];
            }
            return run();
        },
        canAcceptTask() { return !active && (!job || ['completed', 'cancelled'].includes(job.status) || ((job.teamTask || job.teamCoordination) && job.status === 'blocked')); },
        acceptTask(assignment) {
            if (!team?.runtime || !controller.canAcceptTask()) throw new Error('无法接受团队任务');
            return controller.start({ request: assignment.task.description, origin: assignment.run.origin,
                dimension: assignment.run.dimension, owner: assignment.run.owner, originLocked: true, teamAssignment: assignment });
        },
        async receiveTeamEvent(event) {
            if (active?.finishing) await active.done;
            if (job?.teamEvents?.includes(event.id)) return true;
            if (['message', 'share_proposal'].includes(event.kind) && event.payload.context && controller.canAcceptTask()) {
                const context = event.payload.context;
                controller.start({ request: '处理队友协调请求：' + event.payload.text.slice(0, 900),
                    owner: context.owner, origin: context.origin, dimension: context.dimension, originLocked: true,
                    coordination: event }).catch(error => report('team_error', { reason: error.message }));
                await checkpoint();
                return true;
            }
            if (!job || job.teamRunId !== event.runId) return event.kind === 'control';
            job.teamEvents ??= [];
            if (job.teamEvents.includes(event.id)) return true;
            job.teamEvents.push(event.id); job.teamEvents = job.teamEvents.slice(-200);
            job.teamEventRevision = (job.teamEventRevision ?? 0) + 1;
            // 生命周期事件进短动态流而非聊天窗口：完整任务状态每轮由 teamContext
            // 刷新并进入上下文，聊天窗口只保留真实对话，避免两处重复膨胀。
            if (['message', 'share_proposal'].includes(event.kind)) {
                job.messages.push({ role: 'user', from: event.from, content: ('[团队事件 ' + event.kind + '] ' + JSON.stringify(event.payload)).slice(0, 300), at: new Date().toISOString() });
                job.messages = job.messages.slice(-40);
            } else {
                job.teamFeed = [...(job.teamFeed ?? []), { at: new Date().toISOString(), kind: event.kind, from: event.from,
                    text: ('[团队 ' + event.kind + '] ' + (event.payload?.reason ?? event.payload?.summary ?? event.payload?.action ?? '')).toString().slice(0, 160) }].slice(-12);
            }
            await checkpoint();
            if (event.kind === 'control') {
                if (event.payload.action === 'cancel' && (job.teamTask || job.teamCoordination)) { await controller.stop('cancelled'); return true; }
                if (event.payload.action === 'pause' && (active || ['waiting_team', 'waiting_user'].includes(job.status))) {
                    job.teamPaused = true;
                    await controller.stop('paused');
                }
                if (event.payload.action === 'resume' && job.teamPaused) {
                    const resumeTeam = () => {
                        if (!active && job.status === 'paused') {
                            job.teamPaused = false;
                            run().catch(error => report('team_error', { reason: error.message }));
                        }
                    };
                    if (active) active.done.then(resumeTeam); else resumeTeam();
                }
                return true;
            }
            if (!active && job.status === 'waiting_team') run().catch(error => report('team_error', { reason: error.message }));
            else if (active) {
                const session = active;
                session.done.then(() => { if (!active && job.status === 'waiting_team') run().catch(error => report('team_error', { reason: error.message })); });
            }
            return true;
        },
        async receiveMessage(input) {
            const content = requiredText(input.request, '用户消息');
            if (active?.finishing) await active.done;
            if (!job || ['completed', 'cancelled', 'failed'].includes(job.status)) {
                // 队友消息不足以单独开启一个新任务；需要用户显式发起。
                if (input.peerMessage) return { status: 'ignored', reason: '没有运行中的任务，队友消息暂存' };
                return controller.start(input);
            }
            if (input.peerMessage) {
                job.messages.push({ role: 'user', from: input.owner, content, at: new Date().toISOString() });
                if (job.messages.length > 40) job.messages.splice(0, job.messages.length - 40);
                record('user', 'peer_message', { from: input.owner, text: content }, { status: 'received' });
                await checkpoint();
                if (!active && ['waiting_user', 'blocked'].includes(job.status)) return run();
                return { status: 'received', note: '队友消息已入队，不打断当前决策' };
            }
            if (job.siteIssue && input.siteIssue === null && input.dimension === job.dimension &&
                !job.assignment && !job.placementAttempts && !job.demolitionAttempts) {
                job.origin = coordinates(input.origin, '确认的施工原点');
                job.originLocked = input.originLocked ?? false;
                job.siteIssue = null;
                markObservationsStale(job, 'worksite_changed');
                world.setWorksite?.({ origin: job.origin, dimension: job.dimension });
            }
            if (input.origin && input.originLocked && input.origin.some((n, i) => n !== job.origin[i])) {
                throw new Error('当前任务原点已固定；请先取消，再指定新坐标开始任务');
            }
            job.messages.push({ role: 'user', from: input.owner, content, at: new Date().toISOString() });
            // User constraints are durable task memory, independent of the
            // rolling chat window. Peer messages never enter this collection.
            job.clarifications.push({ from: input.owner, content });
            if (job.messages.length > 40) job.messages.splice(0, job.messages.length - 40);
            job.inputRevision++;
            record('user', 'message', { from: input.owner, text: content }, { status: 'received' });
            // Queue the write before yielding; run() sets active synchronously.
            const saved = checkpoint();
            if (!active && ['waiting_user', 'waiting_team', 'blocked'].includes(job.status)) {
                const running = run();
                await saved;
                return running;
            }
            await saved;
            const paused = job.status === 'paused';
            return { status: 'received', paused, ...(paused ? {
                notice: '消息已保存，但当前任务仍处于暂停状态，尚未调用模型。发送“继续建造”恢复原任务；若要开始新任务，请先发送“取消建造”，再描述新任务。'
            } : {}) };
        },
        restore(state) {
            if (active) throw new Error('当前任务仍在运行');
            job = validateState(structuredClone(state));
            markObservationsStale(job, 'process_restored');
            if (job.status !== 'waiting_user') job.status = 'paused';
            return job.id;
        },
        resume() {
            if (active) throw new Error('当前任务仍在运行');
            if (!job || !['paused', 'blocked', 'waiting_user', 'waiting_team'].includes(job.status)) throw new Error('没有可恢复的 Agent 任务');
            return run();
        },
        async stop(status) {
            if (!['paused', 'cancelled'].includes(status)) throw new Error('无效的停止状态');
            if (status === 'paused' && job?.teamRunId && !job.teamTask && !job.teamCoordination && !['completed', 'cancelled', 'failed'].includes(job.status)) {
                try { await team?.pause?.(job); } catch (error) { report('team_error', { reason: error.message }); }
            }
            if (status === 'cancelled' && job?.teamRunId && !job.teamTask && !job.teamCoordination && !['completed', 'cancelled', 'failed'].includes(job.status)) await team?.cancel?.(job);
            if (active) {
                if (['completed', 'cancelled'].includes(job.status)) return false;
                active.stop = status;
                active.abort.abort(new Error(status === 'paused' ? '用户暂停' : '任务取消'));
                return true;
            }
            if (status === 'paused' && ['waiting_team', 'waiting_user', 'blocked'].includes(job?.status)) {
                job.status = 'paused'; await checkpoint(); return true;
            }
            if (status === 'cancelled' && ['paused', 'blocked', 'waiting_user', 'waiting_team'].includes(job?.status)) {
                const cancelled = job;
                cancelled.status = status;
                cancelled.result = { ...cancelled.result, status, reason: '用户取消' };
                await checkpoint('state', cancelled, cancelled.id);
                await checkpoint('result', cancelled.result, cancelled.id);
                await team?.settle?.(cancelled, cancelled.result);
                return true;
            }
            return false;
        },
        status() { return active?.stop ? 'stopping' : job?.status ?? 'idle'; },
        summary() {
            if (!job) return '等待用户消息';
            const step = job.plan.steps.find(item => item.status !== 'done');
            const verified = job.lastInspection;
            return '计划 ' + job.plan.steps.filter(item => item.status === 'done').length + '/' +
                job.plan.steps.length + (step ? '，当前：' + step.title : '') +
                (verified ? '，最近核验 ' + verified.verified + '/' + verified.total + ' 格' : '') +
                (job.checklist ? '，最近部件验收 ' + job.checklist.verifiedParts + '/' + job.checklist.totalParts +
                    '，剩余差异 ' + job.checklist.remainingCells + ' 格' : '') +
                '，模型请求 ' + job.modelRequests + ' 次';
        },
        snapshot() { return job ? structuredClone(job) : null; }
    };
    return controller;
}
