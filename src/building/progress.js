import { createHash } from 'node:crypto';

// Text edits, repeated successful reads and repeated plan submissions are not
// construction progress. New facts and genuinely different geometry can help.
export function createProgressTracker(job, world) {
    const seen = new Map();
    let idle = 0;
    let maxDone = 0;
    let planned = false;
    function observe(key, value) {
        if (value == null) return false;
        const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
        if (!seen.has(key)) seen.set(key, new Set());
        if (seen.get(key).has(hash)) return false;
        seen.get(key).add(hash);
        return true;
    }
    function sample(action, output) {
        const facts = [
            observe('blackboard', job.blackboardSeenRevision),
            observe('placed', job.placed), observe('removed', job.removed),
            observe('position', world.snapshot().position?.map(Math.floor)),
            observe('blueprint', job.assignment?.blueprint.blocks),
            observe('demolition', job.demolition?.targets),
            observe('checklist', job.checklist),
            observe('team', job.teamContext && {
                tasks: job.teamContext.tasks?.map(t => [t.id, t.status, t.to, t.attempt]),
                proposals: job.teamContext.proposals?.map(p => [p.id, p.status])
            }),
            observe('observation', job.observation && { region: job.observation.region, counts: job.observation.counts,
                occupied: job.observation.occupied, offset: job.observation.offset, unloaded: job.observation.unloaded }),
            observe('inspection', job.lastInspection && { verified: job.lastInspection.verified, differences: job.lastInspection.differences })
        ];
        if (['inspect_block', 'inspect_blueprint', 'inspect_part', 'list_materials'].includes(action?.name) && output && output.status !== 'error') {
            facts.push(observe(action.name, output));
        }
        if(action?.name==='read_blackboard'&&output?.status==='observed') facts.push(observe('blackboardRead',output));
        if(job.teamContext?.blackboard && action?.name==='claim_part' && output?.status==='claimed') {
            facts.push(observe('blackboardLease',[output.partId,output.blueprintVersion,output.owner,output.token]));
        }
        for(const step of output?.steps??[]) if(step.name==='read_blackboard'&&step.status==='ok') facts.push(observe('blackboardRead',step.result));
        // Dispatch/consent is real progress even before the next runtime refresh.
        const teamResult = result => {
            if (result?.taskId) facts.push(observe('task:' + result.taskId, [result.status, result.taskId]));
            if (result?.proposal?.id) facts.push(observe('proposal:' + result.proposal.id, result.proposal.status));
        };
        if (!['error', 'blocked'].includes(output?.status)) teamResult(output);
        for (const step of output?.steps ?? []) if (!['error', 'blocked'].includes(step.status)) teamResult(step.result);
        if (!planned && job.plan.steps.length) { planned = true; facts.push(true); }
        const done = job.plan.steps.filter(step => step.status === 'done').length;
        if (done > maxDone) { maxDone = done; facts.push(true); }
        if (output?.status === 'superseded') facts.push(true);
        return facts.some(Boolean);
    }
    sample();
    return (action, output) => {
        const progressed = sample(action, output);
        idle = progressed ? 0 : idle + 1;
        return { progressed, idle };
    };
}

export function failureFingerprint(action, output) {
    if (!['error', 'blocked', 'unreachable'].includes(output?.status)) return '';
    // Changing a plan title or the failing coordinates does not fix the cause.
    const reason = output.code ?? output.reason ?? output.differences?.[0]?.reason ??
        output.message?.replace(/-?\d+(?:\.\d+)?/g, '#').split('：')[0];
    return JSON.stringify([action?.name ?? action?.action ?? 'decision', reason, output.field ?? null]);
}
