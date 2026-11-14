import { randomUUID } from 'node:crypto';

export function createTeamClient({ name, spec, channel = process, onError = error => console.error('[Team]', error.message) }) {
    const pending = new Map();
    const results = new Map();
    let controller, busy = false, ticking = false, closed = false;
    const send = (method, args = {}) => new Promise((resolve, reject) => {
        if (closed || !channel.connected) return reject(new Error('团队运行时已断开'));
        const id = randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('团队请求超时：' + method)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        channel.send({ type: 'team_request', id, method, args }, error => {
            if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
    });
    const onMessage = message => {
        if (message?.type !== 'team_response') return;
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
    };
    const close = () => {
        if (closed) return;
        closed = true; clearInterval(poll); clearInterval(heartbeat);
        controller?.stop('paused');
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('团队运行时已断开')); }
        pending.clear(); channel.off('message', onMessage);
    };
    channel.on('message', onMessage);
    channel.once('disconnect', close);
    const scope = job => ({ runId: job.teamRunId, blueprintVersion: job.assignmentVersion,
        ...(job.teamTask ? { taskId: job.teamTask.id, token: job.teamTask.token } : {}) });
    async function settle(job, result) {
        if (!job?.teamRunId || job.teamCoordination || result.status === 'waiting_user' || result.status === 'waiting_team') return;
        // User/team pauses retain their lease for explicit resume. Autonomous
        // failure pauses must release work and wake the coordinator for recovery.
        if (result.status === 'paused' && (result.stopRequested || job.teamPaused)) return;
        if (!job.teamTask) {
            if (!['failed', 'blocked', 'paused'].includes(result.status)) return;
            results.set('run:' + job.teamRunId, { method: 'fail_run', args: { runId: job.teamRunId,
                reason: (result.reason ?? '协调者执行失败').slice(0, 1000) } });
            try { await flushResults(); } catch (error) { onError(error); }
            return;
        }
        results.set(job.teamTask.id, { ...scope(job), status: result.status === 'completed' ? 'completed' : result.status === 'cancelled' ? 'cancelled' : 'blocked',
            summary: result.summary ?? result.reason ?? result.status, evidence: result.teamEvidence });
        try { await flushResults(); } catch (error) { onError(error); }
    }
    async function flushResults() {
        for (const [id, result] of results) {
            try { await send(result.method ?? 'task_result', result.args ?? result); results.delete(id); }
            catch (error) {
                if (/已失效|已结束/.test(error.message)) { results.delete(id); onError(error); }
                else throw error;
            }
        }
    }
    async function tick() {
        if (!controller || ticking || closed) return;
        ticking = true;
        try {
            await flushResults();
            const messages = await send('inbox');
            const ack = [];
            for (const message of messages) if (await controller.receiveTeamEvent(message)) ack.push(message.id);
            if (ack.length) await send('ack', { ids: ack });
            if (!busy && controller.canAcceptTask()) {
                const assignment = await send('take_task');
                if (assignment) {
                    busy = true;
                    controller.acceptTask(assignment).catch(onError).finally(() => { busy = false; });
                }
            }
        } catch (error) { onError(error); }
        finally { ticking = false; }
    }
    const heartbeat = setInterval(() => {
        if (controller && !closed) send('heartbeat', { status: controller.status(), canAcceptTask: !busy && controller.canAcceptTask() }).catch(onError);
    }, 2000);
    const poll = setInterval(tick, 1000);
    heartbeat.unref?.(); poll.unref?.();
    return {
        runtime: true, self: name, spec: () => spec, close,
        attach(value) { controller = value; send('heartbeat', { status: controller.status(), canAcceptTask: !busy && controller.canAcceptTask() }).then(tick).catch(onError); },
        async openRun(job) {
            const result = await send('open_run', { id: job.id, request: job.request, owner: job.owner, origin: job.origin, dimension: job.dimension });
            job.teamRunId = result.runId;
        },
        async refresh(job) {
            const context = await send('context', scope(job));
            if (job.teamTask && context.currentTask) job.teamTask = context.currentTask;
            delete context.currentTask;
            job.teamContext = context;
        },
        publish: (job, assignment, design) => send('publish', { ...scope(job), previousVersion: job.assignmentVersion, assignment, design }),
        delegate: (job, args) => send('delegate', { ...scope(job), ...args }),
        proposeShare: (job, args) => send('propose_share', { ...scope(job), ...args }),
        respondShare: (job, args) => send('respond_share', { ...scope(job), ...args }),
        async commitShare(job, args) {
            const result = await send('commit_share', { ...scope(job), ...args });
            job.teamTask = result.currentTask;
            return { status: result.status, taskId: result.taskId };
        },
        prepareParallel: (job, args) => send('prepare_parallel', { ...scope(job), ...args }),
        reassign: (job, args) => send('reassign', { ...scope(job), ...args }),
        claim: (partId, assignmentVersion, job) => send('claim', { ...scope(job), partId }),
        release: (partId, job) => send('release', { ...scope(job), partId }),
        queryClaims: job => send('claims', scope(job)),
        assertWrite: (job, partId, positions) => send('assert_write', { ...scope(job), partId, positions }),
        finish: job => send('finish_run', scope(job)),
        pause: job => send('pause_run', scope(job)),
        resume: job => send('resume_run', scope(job)),
        cancel: job => send(job.teamTask ? 'task_result' : 'cancel_run', { ...scope(job), status: 'cancelled', summary: '用户取消' }),
        settle,
        peers: {
            isPeer: peer => peer !== name && !!spec.agents[peer],
            list: () => send('peers'),
            sendToAgent: (recipient, text, job) => send('message', { ...scope(job), recipient, text }),
            broadcast: (text, job) => send('message', { ...scope(job), text })
        }
    };
}
