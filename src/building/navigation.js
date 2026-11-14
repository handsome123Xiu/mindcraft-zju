// Bound each walk independently of pathfinder's own events. Some goto() results
// resolve on an empty path even when the goal was never reached.
export function createWalkingNavigation(bot, { timeoutMs = 8000, stuckMs = 2000, pollMs = 100,
    canOccupy = () => true, report = () => {} } = {}) {
    if (![timeoutMs, stuckMs, pollMs].every(value => Number.isFinite(value) && value > 0)) throw new Error('移动时限无效');
    const point = () => ['x', 'y', 'z'].map(key => bot.entity.position[key]);
    const stop = () => { bot.pathfinder.setGoal(null); bot.clearControlStates(); };
    return async function walk(goal, signal) {
        signal?.throwIfAborted();
        let last = point();
        let lastProgress = Date.now();
        let deadline, monitor, onAbort, onReset;
        let reason;
        const reached = () => {
            const position = point();
            const [x, y, z] = position.map(Math.floor);
            return goal.isEnd({ x, y, z }) && canOccupy(position);
        };
        try {
            if (reached()) { report({ mode: 'walking', status: 'completed', reason: null }); return true; }
            const interrupted = new Promise((resolve, reject) => {
                const fail = why => { reason = why; resolve(false); stop(); };
                deadline = setTimeout(() => fail('walk_timeout'), timeoutMs);
                monitor = setInterval(() => {
                    const current = point();
                    if (Math.hypot(...current.map((n, i) => n - last[i])) >= 0.15) {
                        last = current;
                        lastProgress = Date.now();
                    } else if (Date.now() - lastProgress >= stuckMs) fail('walk_stuck');
                }, pollMs);
                onAbort = () => { reason = 'cancelled'; reject(signal.reason); stop(); };
                onReset = why => { if (why === 'stuck') fail('walk_stuck'); };
                signal?.addEventListener('abort', onAbort, { once: true });
                bot.on('path_reset', onReset);
                if (signal?.aborted) onAbort();
            });
            report({ mode: 'walking', status: 'moving' });
            const moving = Promise.resolve().then(() => {
                signal?.throwIfAborted();
                return bot.pathfinder.goto(goal);
            }).then(() => reached(), () => { signal?.throwIfAborted(); return false; });
            const success = await Promise.race([moving, interrupted]);
            signal?.throwIfAborted();
            report({ mode: 'walking', status: success ? 'completed' : 'blocked', reason: success ? null : reason ?? 'no_ground_path' });
            return success;
        } finally {
            clearTimeout(deadline);
            clearInterval(monitor);
            signal?.removeEventListener('abort', onAbort);
            if (onReset) bot.removeListener('path_reset', onReset);
            stop();
        }
    };
}
