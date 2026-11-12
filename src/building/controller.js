import { randomUUID } from 'node:crypto';
import { executeAssignment } from './executor.js';

export function createBuildController({ world, save, report, timeLimitMs = 20 * 60 * 1000 }) {
    let job;
    let active;

    async function run(plan, previous) {
        if (active) throw new Error('当前任务仍在运行，请先暂停或取消');
        const abort = new AbortController();
        active = { abort, stop: null };
        const started = Date.now();
        const timer = setTimeout(() => abort.abort(new Error('达到本轮施工时限')), timeLimitMs);
        job = previous ?? { id: randomUUID(), modelRequests: 0, elapsedMs: 0 };
        job.status = job.assignment ? 'building' : 'planning';
        let result;
        try {
            if (!job.assignment) {
                job.assignment = await plan({ signal: abort.signal, runId: job.id });
                abort.signal.throwIfAborted();
                await save(job.id, 'assignment', job.assignment);
            }
            job.status = 'building';
            result = await executeAssignment(job.assignment, world, {
                signal: abort.signal,
                onProgress: info => report('progress', info)
            });
        } catch (error) {
            result = { status: active.stop ?? 'blocked', reason: error.message };
        } finally {
            clearTimeout(timer);
            job.status = result.status;
            job.elapsedMs += Date.now() - started;
            const summary = { ...result, runId: job.id, modelRequests: job.modelRequests, elapsedMs: job.elapsedMs };
            try {
                await save(job.id, 'result', summary);
            } finally {
                active = null;
                report('result', summary);
            }
        }
        return result;
    }

    return {
        start(plan, { usesModel = false } = {}) {
            return run(context => {
                if (usesModel) job.modelRequests++;
                return plan(context);
            });
        },
        resume() {
            if (!job?.assignment || !['paused', 'blocked'].includes(job.status)) throw new Error('没有可恢复的蓝图任务');
            return run(null, job);
        },
        stop(status) {
            if (!active) {
                if (status === 'cancelled' && ['paused', 'blocked'].includes(job?.status)) {
                    job.status = 'cancelled';
                    return true;
                }
                return false;
            }
            active.stop = status;
            active.abort.abort(new Error(status === 'paused' ? '用户暂停' : '任务取消'));
            return true;
        },
        status() { return active?.stop ? 'stopping' : job?.status ?? 'idle'; }
    };
}
