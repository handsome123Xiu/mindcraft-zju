// Observation metadata describes evidence, never authorizes construction or
// forces another scan. Keep timestamps out of tool feedback/progress hashes.
export function rememberObservation(job, observation) {
    job.observation = { ...observation, observedAt: new Date().toISOString(),
        freshness: 'observed', staleReasons: [] };
}

export function rememberBlockObservation(job, result, state) {
    const previous = job.blockObservations ?? [];
    job.blockObservations = [...previous.filter(item => item.dimension !== state.dimension ||
        item.position.some((n, i) => n !== result.position[i])),
    { ...result, dimension: state.dimension, observedFrom: state.position,
        observedAt: new Date().toISOString(), freshness: 'observed', staleReasons: [] }].slice(-16);
}

export function markObservationsStale(job, reason) {
    for (const observation of [job.observation, ...(job.blockObservations ?? [])]) {
        if (!observation) continue;
        observation.observedAt ??= null; // Legacy timestamps are unknown.
        observation.freshness = 'possibly_stale';
        observation.staleReasons = [...new Set([...(observation.staleReasons ?? []), reason])];
    }
}
