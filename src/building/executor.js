import { prepareAssignment } from './blueprint.js';

// The executor consumes only a JSON assignment and a world adapter.
export async function executeAssignment(assignment, world, { signal, onProgress } = {}) {
    const { expected, targets, region } = prepareAssignment(assignment);
    await world.prepare(assignment.dimension, region, signal);
    signal?.throwIfAborted();
    let attempts = 0;
    function inspect() {
        const differences = [];
        let verified = 0;
        for (const cell of expected) {
            const actual = world.read(cell.pos);
            if (actual === cell.block) {
                if (cell.block !== 'air') verified++;
            } else {
                differences.push({ ...cell, actual, reason: actual == null ? 'unloaded' :
                    actual === 'air' ? 'missing' : 'occupied' });
            }
        }
        return { total: targets.length, verified, differences, attempts };
    }
    const initial = inspect();
    if (initial.differences.some(cell => cell.reason === 'occupied' || cell.reason === 'unloaded')) {
        return { status: 'blocked', ...initial };
    }
    const reasons = new Map();
    const layers = Map.groupBy(initial.differences, cell => cell.pos[1]);
    for (const [height, layer] of layers) {
        let pending = layer;
        // Resolve holes before the next level can cover their placement faces.
        for (let pass = 0; pass < 3 && pending.length; pass++) {
            const deferred = [];
            for (const cell of pending) {
                signal?.throwIfAborted();
                attempts++;
                const result = await world.place(cell, signal);
                signal?.throwIfAborted();
                if (world.read(cell.pos) !== cell.block) {
                    deferred.push(cell);
                    reasons.set(cell.pos.join(','), result);
                }
                if (attempts % 25 === 0) onProgress?.({ attempts, total: targets.length });
            }
            const madeProgress = pending.length > deferred.length;
            pending = deferred;
            if (pass > 0 && !madeProgress) break;
        }
        if (pending.length) {
            for (const cell of initial.differences) {
                if (cell.pos[1] > height) reasons.set(cell.pos.join(','), 'waiting_for_lower_layer');
            }
            break;
        }
    }
    const result = inspect();
    for (const cell of result.differences) {
        if (cell.reason === 'missing') cell.reason = reasons.get(cell.pos.join(',')) ?? cell.reason;
    }
    return { status: result.differences.length ? 'blocked' : 'completed', ...result };
}
