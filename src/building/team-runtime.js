import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { openTeamStore } from './team-store.js';
import { validateTeamSpec, capabilities, actionAllowed, edgeAllows } from './team-state.js';
export { edgeAllows } from './team-state.js';
import { checklistParts } from './checklist.js';
import { bounds, coordinates } from './blueprint.js';
import { partitionBuilding, independentBuilding, containsPosition, enclosingBounds } from './parallel-building.js';
import { normalizeScope, scopedParts, taskScope, scopeSummary } from './task-scope.js';

const initial = () => ({ runs: {}, tasks: {}, claims: {}, messages: [], proposals: {} });
const terminal = task => ['completed', 'cancelled', 'superseded'].includes(task.status);
const text = (value, label, max = 1000) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + ' 无效');
    return value.trim();
};
export function entryAgent(spec) {
    return spec.entryAgent ?? Object.keys(spec.agents).find(name => spec.agents[name].role === 'lead') ?? Object.keys(spec.agents)[0];
}

// The console owns one runtime. Children never write shared JSON state. A run
// pins its topology; editing the canvas affects the next team launch/run.
export function createTeamRuntime({ spec, path = ':memory:', now = Date.now, leaseMs = 15000, taskClaimTimeoutMs = 15000, onEvent = () => {}, pauseOnRestore = false, archiveLegacyRuns = false }) {
    const validation = validateTeamSpec(spec);
    if (!validation.ok) throw new Error(validation.errors.join('；'));
    spec = structuredClone(spec);
    const store = openTeamStore(path);
    const oldRuns = Object.values(store.read('runtime', initial()).runs).filter(run => run.status === 'active' && !validateTeamSpec(run.spec).ok);
    if (oldRuns.length && !archiveLegacyRuns) {
        store.close();
        throw new Error('旧版工程不能按新版关系恢复。请转换配置并开始新工程；历史任务和现场建筑会保留');
    }
    const ownerToken = randomUUID();
    try {
        store.transaction('owner', {}, owner => {
            if (owner.pid) {
                let alive = true;
                try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
                if (alive) throw new Error('已有团队运行时使用这个工作目录');
            }
            owner.pid = process.pid; owner.token = ownerToken;
        });
    } catch (error) { store.close(); throw error; }
    const live = new Map();
    const peerState = name => ({ name, capabilities: capabilities(spec, name), online: live.has(name), status: live.get(name)?.status ?? 'offline',
        canAcceptTask: live.get(name)?.canAcceptTask === true });
    const canWork = (spec, name) => capabilities(spec, name).canBuild || capabilities(spec, name).canDelegate;
    const dispatcher = (state, task) => state.tasks[task.parentId]?.to ?? task.from;
    const waitsFor = (state, id, target, seen = new Set()) => {
        if (id === target) return true;
        if (seen.has(id) || !state.tasks[id] || terminal(state.tasks[id])) return false;
        seen.add(id);
        return [...state.tasks[id].dependsOn, ...Object.values(state.tasks).filter(t => t.parentId === id && !terminal(t)).map(t => t.id)]
            .some(next => waitsFor(state, next, target, seen));
    };
    const resetClaimWait = task => {
        delete task.claimWaitSince; delete task.claimStalled;
    };
    const conflictHint = task => `taskId=${task.id}, recipient=${task.to}, status=${task.status}。` +
        (['blocked', 'queued'].includes(task.status) ? '请使用 reassign_task(taskId, recipient) 重派原任务，不要重复 delegate_task' : '请查看 list_tasks，不能重复委托已有范围');
    const partCache = new Map();
    const scopeCache = new Map();
    const parts = (run, task) => {
        const assignment = task?.site ? task.assignment : run.assignment;
        if (!assignment) return [];
        const cacheKey = task?.site ? run.id + ':' + task.id + ':' + task.blueprintVersion : run.id + ':' + run.blueprintVersion;
        if (!partCache.has(cacheKey)) partCache.set(cacheKey, checklistParts({ assignment, removed: {} })
            .map(part => ({ ...part, keys: new Set(part.cells.map(cell => cell.pos.join(','))) })));
        return partCache.get(cacheKey);
    };
    let current, closed = false;
    const key = (run, partId, task) => `${run.id}:${task?.blueprintVersion ?? run.blueprintVersion}:${partId}${task ? ':task:' + task.id : ''}`;
    const taskParts = (run, task, full = false) => {
        const cacheKey = `${task.id}:${task.blueprintVersion}:${task.scopeRevision ?? 0}:${full}`;
        if (!scopeCache.has(cacheKey)) scopeCache.set(cacheKey, scopedParts(parts(run, task), task.partIds, taskScope(task, full))
            .map(part => ({ ...part, keys: new Set(part.cells.map(cell => cell.pos.join(','))) })));
        return scopeCache.get(cacheKey);
    };
    const overlaps = (a, b) => a.some(part => {
        const other = b.find(p => p.id === part.id);
        return other && part.cells.some(cell => other.keys?.has(cell.pos.join(',')) ?? other.cells.some(c => c.pos.join(',') === cell.pos.join(',')));
    });
    const claimParts = (state, claim) => {
        const run = state.runs[claim.runId];
        return (claim.taskId ? taskParts(run, state.tasks[claim.taskId]) : parts(run)).filter(part => part.id === claim.partId);
    };
    const ancestorOwns = (state, task, name) => {
        let parent = task.parentId && state.tasks[task.parentId];
        while (parent) {
            if (parent.to === name && !terminal(parent)) return true;
            parent = parent.parentId && state.tasks[parent.parentId];
        }
        return false;
    };
    const descendantOwns = (state, task, name) => Object.values(state.tasks).some(child =>
        child.parentId === task.id && !terminal(child) && (child.to === name || descendantOwns(state, child, name)));
    const taskForWorker = ({ assignment, design, ...task }) => task;
    const publicTask = ({ token, finishedToken, scope, workScope, signature, assignment, design, ...task }) => ({ ...task,
        ...(design?.summary ? { designSummary: design.summary } : {}),
        scope: scopeSummary(scope), workScope: scopeSummary(workScope ?? scope) });
    const taskRun = (run, task) => task.site ? { ...run, origin: task.site.origin, assignment: task.assignment ?? null,
        design: task.design ?? null, blueprintVersion: task.blueprintVersion } : run;
    const publicProposal = ({ scope, sourceToken, signature, ...proposal }) => ({ ...proposal, scope: scopeSummary(scope) });
    function allocation(state, run) {
        if (!run.assignment || run.spec.blueprintMode === 'independent') return [];
        const owned = new Set();
        for (const task of Object.values(state.tasks)) {
            if (task.runId !== run.id || task.blueprintVersion !== run.blueprintVersion || ['cancelled', 'superseded'].includes(task.status)) continue;
            for (const part of taskParts(run, task, true)) for (const cell of part.cells) owned.add(cell.pos.join(','));
        }
        return parts(run).map(part => {
            const remaining = part.cells.filter(cell => !owned.has(cell.pos.join(',')));
            return { partId: part.id, total: part.cells.length, unallocated: remaining.length,
                sampleWorld: remaining.slice(0, 8).map(cell => cell.pos), truncated: remaining.length > 8 };
        });
    }
    const notify = (state, run, from, to, kind, payload) => {
        state.messages.push({ id: randomUUID(), runId: run.id, from, to, kind, payload, at: now() });
    };
    const report = (state, task, kind, detail = {}) => {
        const run = state.runs[task.runId];
        const recipients = new Set([run.root, task.from, dispatcher(state, task)]);
        let parent = state.tasks[task.parentId];
        while (parent) { recipients.add(parent.to); parent = state.tasks[parent.parentId]; }
        recipients.delete(task.to);
        for (const to of recipients) notify(state, run, task.to, to, kind, {
            taskId: task.id, status: task.status, partIds: task.partIds, summary: task.summary ?? task.reason ?? '', ...detail
        });
    };
    function releaseTask(state, task) {
        for (const [id, claim] of Object.entries(state.claims)) if (claim.taskId === task.id) delete state.claims[id];
        for (const proposal of Object.values(state.proposals ?? {})) if (proposal.taskId === task.id && ['proposed', 'accepted'].includes(proposal.status)) proposal.status = 'expired';
        task.token = null;
    }
    function endRun(state, run, status, reason = '') {
        for (const task of Object.values(state.tasks)) if (task.runId === run.id && !terminal(task)) {
            task.status = 'cancelled'; task.reason = reason;
            task.finishedToken = task.token ?? task.finishedToken;
            releaseTask(state, task);
        }
        run.status = status; run.reason = reason; run.endedAt = now(); run.paused = false;
        state.messages = state.messages.filter(message => message.runId !== run.id);
        if (status !== 'completed') for (const to of Object.keys(run.spec.agents)) if (to !== run.root) {
            notify(state, run, run.root, to, 'control', { action: 'cancel' });
        }
        for (const [id, claim] of Object.entries(state.claims)) if (claim.runId === run.id) delete state.claims[id];
        for (const proposal of Object.values(state.proposals)) if (proposal.runId === run.id && ['proposed', 'accepted'].includes(proposal.status)) proposal.status = 'expired';
        return { status: run.status };
    }
    function leaseTask(state, run, task, session) {
        task.session = session; task.leaseUntil = now() + leaseMs;
        for (const part of taskParts(run, task)) state.claims[key(run, part.id, task)] = {
            runId: run.id, blueprintVersion: task.blueprintVersion, partId: part.id, taskId: task.id,
            owner: task.to, session, token: task.token, expiresAt: now() + leaseMs
        };
    }
    function recover(state) {
        for (const [id, claim] of Object.entries(state.claims)) if (claim.expiresAt <= now()) delete state.claims[id];
        for (const task of Object.values(state.tasks)) {
            if (task.status !== 'running') continue;
            if (task.leaseUntil > now() && taskParts(state.runs[task.runId], task).every(part => state.claims[key(state.runs[task.runId], part.id, task)]?.token === task.token)) continue;
            releaseTask(state, task);
            task.status = 'queued';
            resetClaimWait(task);
            task.reason = '执行者离线或租约失效，等待接管';
            report(state, task, 'task_requeued');
        }
        for (const task of Object.values(state.tasks)) {
            if (task.status !== 'queued' || task.site || live.has(task.to)) continue;
            const run = state.runs[task.runId];
            if (run.status !== 'active' || run.paused) continue;
            const replacement = [...live.keys()].find(name => name !== run.root &&
                peerState(name).canAcceptTask &&
                !ancestorOwns(state, task, name) &&
                !descendantOwns(state, task, name) &&
                !Object.values(state.tasks).some(t => t.to === name && t.status === 'running') &&
                canWork(run.spec, name) && edgeAllows(run.spec, dispatcher(state, task), name));
            if (replacement) { task.to = replacement; resetClaimWait(task); report(state, task, 'task_reassigned'); }
        }
        for (const task of Object.values(state.tasks)) {
            if (task.status !== 'queued') continue;
            const run = state.runs[task.runId];
            if (run.status !== 'active' || run.paused || !task.dependsOn.every(id => state.tasks[id]?.status === 'completed')) {
                delete task.claimWaitSince;
                continue;
            }
            task.claimWaitSince ??= now();
            if (task.claimStalled || now() - task.claimWaitSince < taskClaimTimeoutMs) continue;
            task.claimStalled = true;
            report(state, task, 'task_unclaimed', { recipient: task.to, peer: peerState(task.to),
                summary: '任务超过领取时限仍未开始；检查成员 canAcceptTask，使用 reassign_task 重派原任务。用户主动暂停的成员需用户恢复。' });
        }
    }
    // A restarted supervisor cannot assume a previous worker still owns work.
    current = store.transaction('runtime', initial(), state => {
        state.proposals ??= {};
        for (const old of oldRuns) endRun(state, state.runs[old.id], 'cancelled', '用户开始新版工程，保留旧版历史记录');
        if (pauseOnRestore) for (const run of Object.values(state.runs)) if (run.status === 'active') run.paused = true;
        for (const proposal of Object.values(state.proposals)) if (['proposed', 'accepted'].includes(proposal.status)) proposal.status = 'expired';
        state.claims = {};
        for (const task of Object.values(state.tasks)) if (task.status === 'running') {
            task.status = 'queued'; task.token = null; task.reason = '运行时已重启，等待重新执行';
        }
        for (const task of Object.values(state.tasks)) if (task.status === 'queued') resetClaimWait(task);
        return state;
    });
    function mutate(fn) {
        let changed;
        try { changed = store.transaction('runtime', initial(), state => { recover(state); return { state, result: fn(state) }; }); }
        catch (error) { partCache.clear(); scopeCache.clear(); throw error; }
        const { state, result } = changed;
        current = state;
        onEvent();
        return structuredClone(result);
    }
    const runtime = {
        spec,
        archiveRun(runId, { status = 'cancelled', reason = '开始新测试' } = {}) {
            if (live.size) throw new Error('归档旧工程前必须停止所有团队成员');
            if (!['failed', 'cancelled'].includes(status)) throw new Error('无效的归档状态');
            return mutate(state => {
                const run = state.runs[runId];
                if (!run || run.status !== 'active') return { status: run?.status ?? 'missing' };
                return endRun(state, run, status, reason);
            });
        },
        connect(name, session = randomUUID()) {
            if (!spec.agents[name]) throw new Error('未知团队成员');
            if (live.has(name)) throw new Error('团队成员已连接：' + name);
            live.set(name, { session, lastSeen: now(), status: 'starting' });
            return session;
        },
        disconnect(name, session) {
            if (live.get(name)?.session !== session) return;
            live.delete(name);
            mutate(state => {
                for (const claim of Object.values(state.claims)) if (claim.owner === name) claim.expiresAt = 0;
                for (const task of Object.values(state.tasks)) if (task.to === name) task.leaseUntil = 0;
                recover(state);
                return { status: 'offline' };
            });
        },
        sweep() {
            for (const [name, peer] of live) if (peer.status !== 'starting' && now() - peer.lastSeen > leaseMs) live.delete(name);
            return mutate(() => ({ status: 'ok' }));
        },
        snapshot() {
            const state = current;
            return { agents: Object.entries(spec.agents).map(([name, config]) => ({ name, ...config,
                ...peerState(name) })),
            runs: Object.values(state.runs).map(({ assignment, design, ...run }) => run),
            tasks: Object.values(state.tasks).map(publicTask), proposals: Object.values(state.proposals).map(publicProposal), claims: state.claims };
        },
        request(name, session, method, args = {}) {
            const peer = live.get(name);
            if (!peer || peer.session !== session) throw new Error('团队连接已失效');
            peer.lastSeen = now();
            if (method === 'heartbeat') {
                peer.status = args.status ?? 'idle';
                peer.canAcceptTask = args.canAcceptTask === true;
            }
            const readOnly = ['peers', 'context', 'claims', 'assert_write', 'inbox'].includes(method);
            const execute = readOnly ? fn => structuredClone(fn(current)) : mutate;
            return execute(state => {
                const run = args.runId && state.runs[args.runId];
                const permission = { delegate_site: 'delegate_site', delegate: 'delegate_task', prepare_parallel: 'prepare_parallel_build', reassign: 'reassign_task',
                    propose_share: 'propose_task_share', respond_share: 'respond_task_share', commit_share: 'commit_task_share',
                    publish: 'design_blueprint', claim: 'claim_part', release: 'release_part',
                    message: args.recipient ? 'send_message' : 'broadcast' }[method];
                if (permission && !actionAllowed(run?.spec ?? spec, name, permission).allowed) throw new Error('权限不足：' + permission + '；请调整协作方案或由用户修改权限');
                const independent = run?.spec.blueprintMode === 'independent';
                if (independent && ['delegate', 'prepare_parallel', 'propose_share', 'respond_share', 'commit_share'].includes(method)) {
                    throw new Error('独立蓝图工程通过 delegate_site 分配工地');
                }
                const requireRun = () => {
                    if (!run || !run.spec.agents[name] || run.status !== 'active') throw new Error('工程不存在或已结束');
                    return run;
                };
                const requireTask = () => {
                    requireRun();
                    const task = state.tasks[args.taskId];
                    if (!task || task.runId !== run.id || task.to !== name || task.status !== 'running' ||
                        task.token !== args.token || (!task.site && task.blueprintVersion !== run.blueprintVersion)) throw new Error('任务或执行租约已失效');
                    return task;
                };
                if (method === 'heartbeat') {
                    for (const claim of Object.values(state.claims)) if (claim.owner === name && claim.session === session) claim.expiresAt = now() + leaseMs;
                    for (const task of Object.values(state.tasks)) if (task.to === name && task.session === session && task.status === 'running') task.leaseUntil = now() + leaseMs;
                    return { status: 'ok' };
                }
                if (method === 'peers') return Object.keys(spec.agents).filter(n => n !== name).map(peerState);
                if (method === 'open_run') {
                    if (name !== entryAgent(spec)) throw new Error('请向团队入口提交整体任务');
                    const id = text(args.id, '工程 ID', 80);
                    if (!state.runs[id]) state.runs[id] = { id, root: name, owner: text(args.owner, '用户', 16),
                        request: text(args.request, '工程目标'), origin: coordinates(args.origin, '施工原点'),
                        dimension: text(args.dimension, '维度', 100), spec, status: 'active', blueprintVersion: 0 };
                    return { runId: id };
                }
                if (method === 'context') {
                    requireRun();
                    const task = args.taskId ? requireTask() : null;
                    const view = task?.site ? task : independent && name !== run.root ? {} : run;
                    return { tasks: Object.values(state.tasks).filter(t => t.runId === run.id).map(publicTask),
                        ...(name === run.root ? { allocation: allocation(state, run) } : {}),
                        ...(view.assignment ? { blueprint: { version: view.blueprintVersion,
                            bounds: view.assignment.blueprint.bounds, blocks: view.assignment.blueprint.blocks.length },
                            sharedAssignment: view.assignment, sharedDesign: view.design } : {}),
                        proposals: Object.values(state.proposals).filter(p => p.runId === run.id).map(publicProposal),
                        currentTask: task && taskForWorker(task),
                        paused: run.paused ?? false, blueprintVersion: view.blueprintVersion ?? 0, peers: Object.keys(run.spec.agents).map(peerState) };
                }
                if (method === 'pause_run' || method === 'resume_run') {
                    requireRun(); if (run.root !== name) throw new Error('只有协调者可以暂停或恢复整个工程');
                    const paused = method === 'pause_run';
                    if (!!run.paused !== paused) {
                        run.paused = paused;
                        for (const to of Object.keys(run.spec.agents)) if (to !== name) notify(state, run, name, to, 'control', { action: paused ? 'pause' : 'resume' });
                    }
                    return { status: paused ? 'paused' : 'active' };
                }
                if (method === 'delegate_site') {
                    requireRun();
                    if (!independent || name !== run.root) throw new Error('只有独立蓝图工程的入口可以分配工地');
                    if (run.paused) throw new Error('团队工程已暂停');
                    const to = args.recipient;
                    if (!edgeAllows(run.spec, name, to)) throw new Error('执行者需要与入口直连');
                    const region = bounds(args.region, '工地边界');
                    const origin = coordinates(args.origin, '施工原点');
                    if (!containsPosition(region, origin)) throw new Error('施工原点必须在工地内');
                    const tasks = Object.values(state.tasks).filter(t => t.runId === run.id);
                    const existing = tasks.find(task => task.to === to);
                    if (existing) {
                        if (!isDeepStrictEqual(existing.site, { origin, region })) throw new Error(to + ' 已经分配了工地');
                        return { taskId: existing.id, recipient: to, site: existing.site, status: existing.status };
                    }
                    for (const task of tasks) {
                        const other = task.site.region;
                        if ([0, 2].every(i => region.min[i] <= other.max[i] && other.min[i] <= region.max[i])) {
                            throw new Error('工地的水平投影与 ' + task.to + ' 重叠');
                        }
                    }
                    if (Math.hypot(...run.origin.map((n, i) => Math.max(Math.abs(n - region.min[i]), Math.abs(n - region.max[i])))) > 256) {
                        throw new Error('工地超出工程原点周围 256 格的范围');
                    }
                    bounds(enclosingBounds([...tasks.map(task => task.site.region), region]), '工地总范围');
                    const task = { id: randomUUID(), runId: run.id, from: name, to, site: { origin, region },
                        scope: { region }, partIds: [], dependsOn: [], blueprintVersion: 0, description: run.request,
                        success: '在本工地独立交付符合原始要求的完整建筑，核验实体和预留空位',
                        status: 'queued', attempt: 0, createdAt: now() };
                    state.tasks[task.id] = task;
                    return { taskId: task.id, recipient: to, site: task.site, status: task.status };
                }
                if (method === 'publish') {
                    requireRun();
                    if (independent) {
                        const task = requireTask();
                        if (run.paused) throw new Error('团队工程已暂停');
                        if (task.assignment) {
                            if (args.previousVersion === 0 && isDeepStrictEqual(args.assignment, task.assignment) && isDeepStrictEqual(args.design, task.design)) {
                                return { assignmentVersion: task.blueprintVersion, currentTask: taskForWorker(task) };
                            }
                            throw new Error('本工地已有发布的蓝图');
                        }
                        if (args.previousVersion !== 0) throw new Error('蓝图版本已变化');
                        if (args.assignment?.dimension !== run.dimension || args.assignment.region != null) throw new Error('需要当前维度的完整蓝图');
                        if (!isDeepStrictEqual(args.design?.origin, task.site.origin)) throw new Error('设计原点必须使用工地原点');
                        const blueprintBounds = bounds(args.assignment.blueprint?.bounds, '蓝图边界');
                        if (!containsPosition(task.site.region, blueprintBounds.min) || !containsPosition(task.site.region, blueprintBounds.max)) {
                            throw new Error('蓝图及预留空位必须在自己的工地内');
                        }
                        task.partIds = checklistParts({ assignment: args.assignment }).map(part => part.id);
                        task.assignment = args.assignment;
                        task.design = args.design;
                        task.blueprintVersion = 1;
                        leaseTask(state, run, task, session);
                        return { assignmentVersion: task.blueprintVersion, currentTask: taskForWorker(task) };
                    }
                    // 设计者由团队协商推选：任何具备 design_blueprint 权限的成员都可发布，
                    // 不硬绑 run.root（peers 模式全员可设计；层级模式只有 lead）。
                    if (Object.values(state.tasks).some(t => t.runId === run.id && !terminal(t))) throw new Error('请先完成或取消现有子任务，再修订蓝图');
                    if (Object.values(state.claims).some(c => c.runId === run.id)) throw new Error('请先释放施工租约再修订蓝图');
                    if (args.previousVersion !== run.blueprintVersion) throw new Error('蓝图版本已变化');
                    if (args.assignment?.dimension !== run.dimension) throw new Error('蓝图维度不匹配');
                    checklistParts({ assignment: args.assignment });
                    run.assignment = args.assignment; run.design = args.design; run.blueprintVersion++;
                    delete run.parallel;
                    for (const task of Object.values(state.tasks)) if (task.runId === run.id && task.status === 'completed') task.status = 'superseded';
                    return { assignmentVersion: run.blueprintVersion };
                }
                if (method === 'prepare_parallel') {
                    requireRun();
                    if (run.root !== name) throw new Error('只有工程协调者可以准备并行施工');
                    const groupKey = text(args.key, '并行 key', 80);
                    const workers = args.workers;
                    if (!Array.isArray(workers) || new Set(workers).size !== workers.length || workers.length < 2 || workers.length > 8) throw new Error('需要 2–8 名不同施工成员');
                    for (const worker of workers) if (!edgeAllows(run.spec, name, worker) || !capabilities(run.spec, worker).canBuild) throw new Error('施工成员缺少施工权限或协作连线');
                    const signature = JSON.stringify({ workers, axis: args.axis ?? 'auto', version: args.blueprintVersion });
                    if (run.parallel?.key === groupKey) {
                        if (run.parallel.signature !== signature) throw new Error('同一个 key 对应不同并行方案');
                        return { status: 'delegated', assignment: run.assignment, assignmentVersion: run.blueprintVersion, tasks: run.parallel.tasks };
                    }
                    if (!run.assignment || args.blueprintVersion !== run.blueprintVersion) throw new Error('请先发布当前蓝图');
                    if (Object.values(state.tasks).some(t => t.runId === run.id && !terminal(t)) || Object.values(state.claims).some(c => c.runId === run.id)) throw new Error('请先完成现有子任务并释放租约，再重新分区');
                    const assignment = partitionBuilding(run.assignment, workers.length, args.axis);
                    checklistParts({ assignment });
                    run.assignment = assignment; run.blueprintVersion++;
                    for (const task of Object.values(state.tasks)) if (task.runId === run.id && task.status === 'completed') task.status = 'superseded';
                    const tasks = assignment.blueprint.parts.map((part, i) => {
                        const task = { id: randomUUID(), key: groupKey + ':' + i, runId: run.id, blueprintVersion: run.blueprintVersion,
                            from: name, to: workers[i], partIds: [part.id], dependsOn: [],
                            description: '按共享蓝图完成' + part.title + '。只建本区，从低处向高处推进，与其他施工区并行。完成后移到不挡路的位置再回报。',
                            success: '本施工区所有方块现场验收通过，坐标和材料与共享蓝图一致', status: 'queued', attempt: 0, createdAt: now() };
                        state.tasks[task.id] = task;
                        return { taskId: task.id, recipient: task.to, partIds: task.partIds };
                    });
                    run.parallel = { key: groupKey, signature, tasks };
                    return { status: 'delegated', assignment, assignmentVersion: run.blueprintVersion, tasks };
                }
                if (method === 'delegate') {
                    requireRun();
                    if (run.paused) throw new Error('团队工程已暂停');
                    if (!run.assignment || args.blueprintVersion !== run.blueprintVersion) throw new Error('请先发布当前蓝图');
                    if (!edgeAllows(run.spec, name, args.recipient)) throw new Error('画布没有允许此委托的连线');
                    if (!canWork(run.spec, args.recipient)) throw new Error('任务接收者需要施工或范围内委托权限');
                    const parent = name === run.root ? null : requireTask();
                    if (args.recipient === run.root || (parent && (args.recipient === parent.to || ancestorOwns(state, parent, args.recipient)))) throw new Error('不能委托给正在等待它的上级任务执行者或工程入口');
                    const idempotencyKey = text(args.key, '委托 key', 80);
                    let partIds = [...new Set(args.partIds ?? [])];
                    const known = parts(run);
                    if (!partIds.length || partIds.some(id => !known.some(p => p.id === id))) throw new Error('委托包含未知部件');
                    const scope = normalizeScope(known, partIds, args.scope);
                    const selected = scopedParts(known, partIds, scope);
                    // Scope is the explicit requested subset. Store only modules
                    // actually intersecting it, so evidence never requires empty parts.
                    partIds = selected.map(part => part.id);
                    const dependsOn = [...new Set(args.dependsOn ?? [])];
                    if (dependsOn.some(id => !state.tasks[id] || state.tasks[id].runId !== run.id || state.tasks[id].blueprintVersion !== run.blueprintVersion || ['cancelled', 'superseded'].includes(state.tasks[id].status))) throw new Error('任务依赖无效');
                    const description = text(args.description, '子任务目标'), success = text(args.success, '验收标准');
                    if (parent && dependsOn.some(id => waitsFor(state, id, parent.id))) throw new Error('任务依赖会形成循环等待，不能依赖自己或等待自己的任务');
                    const signature = JSON.stringify({ to: args.recipient, partIds: [...partIds].sort(), dependsOn: [...dependsOn].sort(), description, success,
                        ...(parent ? { parentId: parent.id } : {}),
                        ...(scope ? { scope } : {}) });
                    const existing = Object.values(state.tasks).find(t => t.runId === run.id && t.blueprintVersion === run.blueprintVersion && t.key === idempotencyKey && t.from === name && t.parentId === parent?.id);
                    if (existing) { if (existing.signature !== signature) throw new Error('同一个 key 对应不同委托；' + conflictHint(existing)); return { taskId: existing.id, status: existing.status, partIds, scope: scopeSummary(scope), ...(parent ? { currentTask: parent } : {}) }; }
                    if (parent && Object.values(state.tasks).some(t => t.to === args.recipient && t.status === 'running')) throw new Error('接收者仍在执行任务，请等待其空闲或选择其他成员，避免相互等待');
                    const own = parent ? taskParts(run, parent).flatMap(p => p.cells) : [];
                    const transferred = new Set(selected.flatMap(p => p.cells.map(c => c.pos.join(','))));
                    if (parent) {
                        const ownKeys = new Set(own.map(c => c.pos.join(',')));
                        if ([...transferred].some(pos => !ownKeys.has(pos))) throw new Error('不能委托自己施工范围以外的方块');
                    }
                    const conflicting = Object.values(state.tasks).find(t => t.id !== parent?.id && t.runId === run.id && t.blueprintVersion === run.blueprintVersion && !terminal(t) && overlaps(selected, taskParts(run, t)));
                    if (conflicting) throw new Error('施工范围已有未完成委托；' + conflictHint(conflicting));
                    if (Object.values(state.claims).some(c => (!parent || c.taskId !== parent.id) && c.runId === run.id && overlaps(selected, claimParts(state, c)))) throw new Error('请释放施工范围租约后再委托');
                    const task = { id: randomUUID(), key: idempotencyKey, signature, runId: run.id, blueprintVersion: run.blueprintVersion,
                        ...(parent ? { parentId: parent.id } : {}),
                        from: name, to: args.recipient, partIds, scope, dependsOn, description, success, status: 'queued', attempt: 0, createdAt: now() };
                    if (parent) {
                        for (const [id, claim] of Object.entries(state.claims)) if (claim.taskId === parent.id) delete state.claims[id];
                        parent.workScope = { positions: own.filter(c => !transferred.has(c.pos.join(','))).map(c => c.pos) };
                        parent.scopeRevision = (parent.scopeRevision ?? 0) + 1;
                        leaseTask(state, run, parent, session);
                    }
                    state.tasks[task.id] = task;
                    if (parent) report(state, task, 'task_delegated');
                    // 描述里提到的部件若不在生效范围内，执行者会被文字误导去等
                    // 无法写入的层（真实事故：pyr-b2 描述含 part-4/5 但 scope 只有
                    // 底层）。不阻止委托，但让 lead 立即看到矛盾。
                    const mentioned = [...description.matchAll(/part-\d+/gi)].map(m => m[0].toLowerCase());
                    const outside = [...new Set(mentioned)].filter(id => !partIds.includes(id) && known.some(p => p.id === id));
                    return { taskId: task.id, status: task.status, partIds, scope: scopeSummary(scope), ...(parent ? { currentTask: parent } : {}),
                        ...(outside.length ? { warning: '描述提到了不在本任务施工范围内的部件 ' + outside.join(', ') +
                            '；这些格不在 workScope 内且不可写入。请让描述与范围一致，或用 scope 扩大委托' } : {}) };
                }
                if (method === 'propose_share') {
                    const task = requireTask();
                    if (run.paused) throw new Error('团队工程已暂停');
                    if (!edgeAllows(run.spec, name, args.recipient) || !canWork(run.spec, args.recipient)) throw new Error('协作需要双方连线及接收者的施工或委托权限');
                    if (args.recipient === run.root || ancestorOwns(state, task, args.recipient)) throw new Error('不能转交给正在等待它的上级任务执行者或工程入口');
                    const idempotencyKey = text(args.key, '协作 key', 80);
                    const description = text(args.description, '协作目标'), success = text(args.success, '协作验收标准');
                    let partIds = [...new Set(args.partIds ?? [])];
                    if (!args.scope) throw new Error('协作必须明确 scope 范围');
                    const scope = normalizeScope(parts(run), partIds, args.scope);
                    partIds = scopedParts(parts(run), partIds, scope).map(part => part.id);
                    const signature = JSON.stringify({ recipient: args.recipient, partIds: [...partIds].sort(), scope, description, success });
                    const existing = Object.values(state.proposals).find(p => p.taskId === task.id && p.key === idempotencyKey);
                    if (existing) {
                        if (existing.signature !== signature) throw new Error('同一个 key 对应不同协作提案');
                        return { status: existing.status, proposal: publicProposal(existing) };
                    }
                    const ownKeys = new Set(taskParts(run, task).flatMap(p => p.cells.map(c => c.pos.join(','))));
                    if (scope.positions.some(pos => !ownKeys.has(pos.join(',')))) throw new Error('不能转交自己施工范围以外的方块');
                    const proposal = { id: randomUUID(), key: idempotencyKey, signature, runId: run.id,
                        taskId: task.id, from: name, to: args.recipient, partIds, scope, description, success,
                        sourceToken: task.token, status: 'proposed', createdAt: now() };
                    state.proposals[proposal.id] = proposal;
                    notify(state, run, name, proposal.to, 'share_proposal', {
                        text: '协作提案 ' + proposal.id + '：' + description + '。查看 list_tasks 的 proposals，用 respond_task_share 明确接受或拒绝；接受后等待原执行者正式交接，不能直接施工。',
                        context: { owner: run.owner, origin: run.origin, dimension: run.dimension, request: run.request }
                    });
                    return { status: 'proposed', proposal: publicProposal(proposal) };
                }
                if (method === 'respond_share') {
                    requireRun();
                    const proposal = state.proposals[args.proposalId];
                    if (!proposal || proposal.runId !== run.id || proposal.to !== name || typeof args.accept !== 'boolean') throw new Error('无权回应此协作提案');
                    const status = args.accept ? 'accepted' : 'declined';
                    if (proposal.status === status || (proposal.status === 'committed' && args.accept)) return { status: proposal.status, proposal: publicProposal(proposal) };
                    if (proposal.status !== 'proposed') throw new Error('提案已经回应，请重新协商');
                    const source = state.tasks[proposal.taskId];
                    if (source.status !== 'running' || source.token !== proposal.sourceToken) throw new Error('原任务执行会话已变化，请重新提出协作');
                    proposal.status = status;
                    notify(state, run, name, proposal.from, 'share_response', { proposalId: proposal.id, status });
                    return { status, proposal: publicProposal(proposal) };
                }
                if (method === 'commit_share') {
                    const task = requireTask();
                    const proposal = state.proposals[args.proposalId];
                    if (!proposal || proposal.runId !== run.id || proposal.taskId !== task.id || proposal.from !== name) throw new Error('无权交接此协作提案');
                    if (proposal.status === 'committed') return { status: 'delegated', taskId: proposal.childTaskId, currentTask: task };
                    if (run.paused || proposal.status !== 'accepted' || proposal.sourceToken !== task.token) throw new Error('协作尚未接受、工程暂停或原执行会话已变化');
                    if (Object.values(state.tasks).some(t => t.to === proposal.to && !terminal(t))) throw new Error('接收者仍有未完成任务，请协商完成或交还现有任务后再交接');
                    const own = taskParts(run, task).flatMap(p => p.cells);
                    const ownKeys = new Set(own.map(c => c.pos.join(',')));
                    const transferred = new Set(proposal.scope.positions.map(pos => pos.join(',')));
                    if ([...transferred].some(pos => !ownKeys.has(pos))) throw new Error('协作范围已变化，请重新提出提案');
                    const child = { id: randomUUID(), key: 'share:' + proposal.id, runId: run.id, blueprintVersion: run.blueprintVersion,
                        parentId: task.id, from: name, to: proposal.to, partIds: proposal.partIds, scope: proposal.scope,
                        dependsOn: [], description: proposal.description, success: proposal.success,
                        status: 'queued', attempt: 0, createdAt: now() };
                    // The source calls this between actions. Acceptance alone never
                    // revokes a write while its placement operation is in flight.
                    for (const [id, claim] of Object.entries(state.claims)) if (claim.taskId === task.id) delete state.claims[id];
                    task.workScope = { positions: own.filter(cell => !transferred.has(cell.pos.join(','))).map(cell => cell.pos) };
                    task.scopeRevision = (task.scopeRevision ?? 0) + 1;
                    leaseTask(state, run, task, session);
                    state.tasks[child.id] = child;
                    proposal.status = 'committed'; proposal.childTaskId = child.id;
                    report(state, child, 'task_shared');
                    return { status: 'delegated', taskId: child.id, currentTask: task };
                }
                if (method === 'take_task') {
                    if (Object.values(state.tasks).some(t => t.to === name && t.status === 'running')) return null;
                    const task = Object.values(state.tasks).find(t => t.to === name && t.status === 'queued' && state.runs[t.runId].status === 'active' && !state.runs[t.runId].paused &&
                        !ancestorOwns(state, t, name) &&
                        t.dependsOn.every(id => state.tasks[id]?.status === 'completed') && !Object.values(state.claims).some(c => c.runId === t.runId && overlaps(taskParts(state.runs[t.runId], t), claimParts(state, c))));
                    if (!task) return null;
                    const assignedRun = state.runs[task.runId];
                    task.status = 'running'; task.token = randomUUID(); task.attempt++;
                    resetClaimWait(task);
                    peer.canAcceptTask = false;
                    leaseTask(state, assignedRun, task, session);
                    report(state, task, 'task_started');
                    return { task: taskForWorker(task), run: taskRun(assignedRun, task) };
                }
                if (method === 'claim') {
                    requireRun();
                    const task = args.taskId ? requireTask() : null;
                    if (args.blueprintVersion !== (task?.blueprintVersion ?? run.blueprintVersion) || !parts(run, task).some(p => p.id === args.partId)) throw new Error('蓝图版本或部件无效');
                    if (task) {
                        if (!taskParts(run, task).some(p => p.id === args.partId)) throw new Error('部件不属于当前任务的自行施工范围');
                        return { status: 'claimed', ...state.claims[key(run, args.partId, task)] };
                    }
                    if (independent || run.root !== name) throw new Error('请先接受施工委托');
                    const held = state.claims[key(run, args.partId)];
                    if (held && (held.owner !== name || held.taskId !== args.taskId)) return { status: 'conflict', owner: held.owner };
                    if (!args.taskId && Object.values(state.tasks).some(t => t.runId === run.id && !terminal(t) && taskParts(run, t).some(p => p.id === args.partId))) throw new Error('该部件已委托');
                    const claim = held ?? { runId: run.id, blueprintVersion: run.blueprintVersion, partId: args.partId,
                        taskId: args.taskId, owner: name, session, token: randomUUID() };
                    claim.expiresAt = now() + leaseMs;
                    state.claims[key(run, args.partId)] = claim;
                    return { status: 'claimed', ...claim };
                }
                if (method === 'release') {
                    requireRun();
                    if (args.taskId) throw new Error('委托部件由运行时在任务结束时释放');
                    const held = state.claims[key(run, args.partId)];
                    if (held?.owner !== name) throw new Error('未持有该部件');
                    delete state.claims[key(run, args.partId)]; return { status: 'released' };
                }
                if (method === 'claims') {
                    requireRun();
                    const leases = Object.values(state.claims).filter(c => c.runId === run.id && (!independent || c.owner === name));
                    return { leases, claims: Object.fromEntries([...leases.filter(c => c.owner !== name), ...leases.filter(c => c.owner === name)].map(c => [c.partId, c])) };
                }
                if (method === 'assert_write') {
                    requireRun();
                    if (!capabilities(run.spec, name).canBuild) throw new Error('缺少施工权限');
                    if (run.paused) throw new Error('团队工程已暂停');
                    const task = args.taskId ? requireTask() : null;
                    if (independent && !task?.assignment) throw new Error('请先发布本工地的独立蓝图');
                    if (args.blueprintVersion !== (task?.blueprintVersion ?? run.blueprintVersion)) throw new Error('拒绝旧蓝图施工');
                    if (task && !task.partIds.includes(args.partId)) throw new Error('超出委托部件范围');
                    const held = state.claims[key(run, args.partId, task)];
                    if (!held || held.expiresAt <= now() || held.owner !== name || held.session !== session || (args.taskId && held.token !== args.token)) throw new Error('必须持有有效施工租约');
                    const selected = (task ? taskParts(run, task) : parts(run)).find(p => p.id === args.partId);
                    if (!args.positions?.length || args.positions.some(pos => !selected?.keys.has(coordinates(pos, '施工坐标').join(',')))) throw new Error('施工坐标超出认领部件');
                    // Distinct runs can target the same physical world. Never allow
                    // their leases to authorize overlapping writes.
                    for (const claim of Object.values(state.claims)) {
                        if (claim.runId === run.id) continue;
                        const other = state.runs[claim.runId];
                        if (other.dimension !== run.dimension) continue;
                        const occupied = claimParts(state, claim)[0]?.keys;
                        if (claim.expiresAt > now() && args.positions.some(pos => occupied?.has(pos.join(',')))) throw new Error('施工位置被其他工程占用');
                    }
                    return { status: 'allowed' };
                }
                if (method === 'task_result') {
                    const previous = state.tasks[args.taskId];
                    if (previous?.runId === args.runId && previous.to === name && previous.finishedToken === args.token && previous.status === args.status) return { status: previous.status };
                    const task = requireTask();
                    if (!['completed', 'blocked', 'cancelled'].includes(args.status)) throw new Error('任务结果无效');
                    if (args.status === 'completed' && task.site && (!task.assignment || args.blueprintVersion !== task.blueprintVersion)) {
                        throw new Error('需使用本工地已发布的当前蓝图提交验收');
                    }
                    if (args.status === 'completed' && Object.values(state.tasks).some(t => t.parentId === task.id && t.status !== 'completed')) throw new Error('协作子任务尚未完成，请等待或联系 lead 处理');
                    if (args.status === 'completed' && (args.evidence?.length !== task.partIds.length || task.partIds.some(id =>
                        !args.evidence.some(e => e.partId === id && e.remaining === 0 && e.total === taskParts(run, task, true).find(p => p.id === id)?.cells.length)))) throw new Error('缺少任务范围现场验收证据');
                    task.status = args.status; task.summary = text(args.summary, '任务结果'); task.evidence = args.evidence ?? [];
                    task.finishedToken = task.token;
                    releaseTask(state, task); report(state, task, 'task_result');
                    if (task.site && task.status === 'completed') {
                        // 独立蓝图：所有已委托的工地都完工即可汇总验收（不要求每个非入口成员都有工地）。
                        const sites = Object.values(state.tasks).filter(t => t.runId === run.id && t.site);
                        if (sites.length > 0 && sites.every(t => t.status === 'completed')) {
                            run.assignment = independentBuilding(run.dimension, sites);
                            run.design = { origin: run.origin, summary: '已完工的独立蓝图汇总' };
                            run.blueprintVersion++;
                        }
                    }
                    return { status: task.status };
                }
                if (method === 'reassign') {
                    requireRun(); const task = state.tasks[args.taskId];
                    if (!task || task.runId !== run.id || (dispatcher(state, task) !== name && run.root !== name) || !['blocked', 'queued'].includes(task.status)) throw new Error('只能重派阻塞或排队中的自己的委托');
                    if (!edgeAllows(run.spec, name, args.recipient) || !canWork(run.spec, args.recipient)) throw new Error('目标没有可用的协作连线或施工能力');
                    if (args.recipient === run.root) throw new Error('不能重派给正在等待它的工程入口');
                    if (task.site && args.recipient !== task.to) throw new Error('独立工地只能由原执行者续建');
                    if (descendantOwns(state, task, args.recipient)) throw new Error('不能把上级任务重派给尚未完成下级任务的成员');
                    let parent = task.parentId && state.tasks[task.parentId];
                    while (parent) {
                        if (parent.to === args.recipient && !terminal(parent)) throw new Error('不能把协作任务派给正在等待它的上级任务执行者');
                        parent = parent.parentId && state.tasks[parent.parentId];
                    }
                    task.to = args.recipient; task.status = 'queued'; task.reason = null;
                    resetClaimWait(task);
                    return { taskId: task.id, status: task.status, recipient: peerState(task.to) };
                }
                if (method === 'message') {
                    requireRun();
                    const recipients = args.recipient ? [args.recipient] : Object.keys(run.spec.agents).filter(to => edgeAllows(run.spec, name, to));
                    for (const to of recipients) {
                        if (!edgeAllows(run.spec, name, to)) throw new Error('画布没有允许此消息的连线');
                        notify(state, run, name, to, 'message', { text: text(args.text, '消息'),
                            context: { owner: run.owner, origin: run.origin, dimension: run.dimension, request: run.request } });
                    }
                    return { status: 'delivered', delivered: recipients.length, channel: 'team-inbox' };
                }
                if (method === 'inbox') return state.messages.filter(m => m.to === name).slice(0, 50);
                if (method === 'ack') { state.messages = state.messages.filter(m => m.to !== name || !args.ids?.includes(m.id)); return { status: 'ok' }; }
                if (method === 'finish_run' || method === 'cancel_run' || method === 'fail_run') {
                    const status = { finish_run: 'completed', cancel_run: 'cancelled', fail_run: 'failed' }[method];
                    if (run?.root === name && run.status === status) return { status }; // lost-response retry
                    requireRun(); if (run.root !== name) throw new Error('只有协调者可以结束工程');
                    if (method === 'finish_run' && !capabilities(run.spec, name).finishGate) throw new Error('缺少全局验收权限');
                    const tasks = Object.values(state.tasks).filter(t => t.runId === run.id);
                    if (method === 'finish_run' && independent && !run.assignment) throw new Error('所有独立工地均须完工后才能整体验收');
                    if (method === 'finish_run' && tasks.some(t => !terminal(t))) throw new Error('仍有未完成子任务');
                    return endRun(state, run, status, method === 'fail_run' ? text(args.reason, '失败原因') : '');
                }
                throw new Error('未知团队请求：' + method);
            });
        },
        close() {
            if (closed) return;
            closed = true;
            store.transaction('owner', {}, owner => { if (owner.token === ownerToken) { delete owner.pid; delete owner.token; } });
            store.close();
        }
    };
    return runtime;
}
