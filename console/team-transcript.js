// Summarize accepted team operations for the player, outside the agent's inbox.
const observed = new Set(['message', 'publish', 'delegate', 'delegate_site', 'prepare_parallel', 'take_task', 'task_result',
    'reassign', 'propose_share', 'respond_share', 'commit_share', 'finish_run', 'cancel_run', 'fail_run']);
const taskStatus = { completed: '完工', blocked: '阻塞', cancelled: '取消' };
const short = id => id.slice(0, 8);

function describeTask(task) {
    if (task.site) {
        const { min, max } = task.site.region;
        return '#' + short(task.id) + ' 工地 [' + min.join(',') + '] 至 [' + max.join(',') + ']';
    }
    const parts = task.partIds.join('、');
    const dependency = task.dependsOn.length ? '，等待 ' + task.dependsOn.map(short).join('、') + ' 完成' : '';
    const scope = task.scope?.count == null ? '' : '，' + task.scope.count + ' 格';
    return '#' + short(task.id) + ' ' + parts + scope + dependency;
}

export function createTeamTranscript({ snapshot, log, notify }) {
    const reported = new Set();
    function emit(actor, text, key) {
        if (key) {
            if (reported.has(key)) return;
            reported.add(key);
            if (reported.size > 2000) reported.delete(reported.values().next().value);
        }
        log('[团队] ' + actor + ' ' + text);
        notify?.(actor, text);
    }

    return (actor, method, args, result) => {
        if (!observed.has(method) || !result || (method === 'message' && !result.delivered)) return;
        const state = snapshot();
        const run = state.runs.find(item => item.id === (result.run?.id ?? args.runId));
        if (!run) return;
        const task = state.tasks.find(item => item.id === (result.task?.id ?? result.taskId ?? args.taskId));
        const proposal = result.proposal;
        const dispatcher = task && (state.tasks.find(parent => parent.id === task.parentId)?.to ?? task.from);
        const speak = (text, key) => emit(actor, text, key);
        const address = (to, text, key) => speak('[-> ' + to + '] ' + text, key);
        const taskLine = (label, item) => '[' + label + ' ' + describeTask(item) + ']';

        switch (method) {
            case 'message': {
                if (args.recipient) return address(args.recipient, args.text);
                const recipients = run.spec.edges.flatMap(edge =>
                    edge.from === actor ? [edge.to] : edge.to === actor ? [edge.from] : []);
                return address(recipients.join('、'), args.text);
            }
            case 'publish': {
                const summary = args.design?.summary ? ' ' + args.design.summary : '';
                if (task?.site) return address(dispatcher, '[发布独立蓝图 v' + result.assignmentVersion + ']' + summary, 'site-blueprint:' + task.id);
                return speak('[发布蓝图 v' + result.assignmentVersion + ']' + summary);
            }
            case 'propose_share':
                if (result.status === 'proposed') return address(proposal.to, '[提议协作] ' + proposal.description, 'proposal:' + proposal.id);
                return;
            case 'respond_share':
                if (result.status === 'accepted' || result.status === 'declined') {
                    const choice = result.status === 'accepted' ? '接受协作' : '拒绝协作';
                    return address(proposal.from, '[' + choice + '] ' + proposal.description, 'share-response:' + proposal.id);
                }
                return;
            case 'prepare_parallel':
                for (const item of result.tasks) {
                    const queued = state.tasks.find(candidate => candidate.id === item.taskId);
                    if (queued) address(queued.to, taskLine('派工', queued) + ' ' + queued.description, 'delegate:' + queued.id);
                }
                return;
            case 'delegate':
            case 'delegate_site':
            case 'commit_share':
                if (task) {
                    const label = { commit_share: '交接', delegate_site: '划定工地' }[method] ?? '派工';
                    return address(task.to, taskLine(label, task) + ' ' + task.description, 'delegate:' + task.id);
                }
                return;
            case 'take_task':
                if (task) return address(dispatcher, taskLine('领工', task), 'start:' + task.id + ':' + task.attempt);
                return;
            case 'task_result':
                if (task && taskStatus[result.status]) {
                    return address(dispatcher, taskLine(taskStatus[result.status], task) + ' ' + task.summary,
                        'result:' + task.id + ':' + task.attempt + ':' + result.status);
                }
                return;
            case 'reassign':
                if (task) return address(task.to, taskLine('重派', task), 'reassign:' + task.id + ':' + task.attempt + ':' + task.to);
                return;
            case 'finish_run':
            case 'cancel_run':
            case 'fail_run': {
                const label = { finish_run: '整体验收通过', cancel_run: '工程取消', fail_run: '工程失败' }[method];
                return speak('[' + label + ']' + (run.reason ? ' ' + run.reason : ''), 'end:' + run.id + ':' + result.status);
            }
        }
    };
}
