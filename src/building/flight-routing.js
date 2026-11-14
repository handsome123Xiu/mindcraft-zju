const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
const key = point => point.join(',');
const OFFSETS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// A bounded 3D A* fallback for low ceilings, sideways detours and doorways.
// Edges are swept through the full body collision checker, not just cell occupancy.
export function planFlightDetour(start, end, { canOccupy, clearSegment, maxNodes = 4096, margin = 8, maxPlanningMs = 250 }) {
    const started = Date.now();
    const heap = [];
    const best = new Map();
    const edges = new Map();
    const low = start.map((n, i) => Math.floor(Math.min(n, end[i])) - margin);
    const high = start.map((n, i) => Math.ceil(Math.max(n, end[i])) + margin);
    const estimate = point => point.reduce((sum, n, i) => sum + Math.abs(n - end[i]), 0);
    function push(node) {
        heap.push(node);
        let i = heap.length - 1;
        while (i) {
            const parent = (i - 1) >> 1;
            if (heap[parent].f <= node.f) break;
            heap[i] = heap[parent]; i = parent;
        }
        heap[i] = node;
    }
    function pop() {
        const first = heap[0], last = heap.pop();
        if (heap.length) {
            let i = 0;
            while (i * 2 + 1 < heap.length) {
                let child = i * 2 + 1;
                if (child + 1 < heap.length && heap[child + 1].f < heap[child].f) child++;
                if (heap[child].f >= last.f) break;
                heap[i] = heap[child]; i = child;
            }
            heap[i] = last;
        }
        return first;
    }
    const center = start.map((n, i) => Math.floor(n) + (i === 1 ? 0 : 0.5));
    // A fractional standing pose may not have a clear route to its own cell center.
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const point = [center[0] + dx, center[1] + dy, center[2] + dz];
        if (!canOccupy(point) || !clearSegment(start, point)) continue;
        const g = distance(start, point);
        const node = { point, g, f: g + estimate(point), parent: null };
        best.set(key(point), g); push(node);
    }
    let visited = 0;
    while (heap.length && visited++ < maxNodes && Date.now() - started < maxPlanningMs) {
        const current = pop();
        const fromKey = key(current.point);
        if (current.g !== best.get(fromKey)) continue;
        if (distance(current.point, end) < 0.001) {
            const path = [];
            for (let node = current; node; node = node.parent) path.push(node.point);
            return path.reverse();
        }
        for (const offset of OFFSETS) {
            const point = current.point.map((n, i) => n + offset[i]);
            const nextKey = key(point), g = current.g + 1;
            if (point.some((n, i) => n < low[i] || n > high[i]) || g >= (best.get(nextKey) ?? Infinity)) continue;
            const edgeKey = fromKey < nextKey ? fromKey + ':' + nextKey : nextKey + ':' + fromKey;
            if (!edges.has(edgeKey)) edges.set(edgeKey, canOccupy(point) && clearSegment(current.point, point));
            if (!edges.get(edgeKey)) continue;
            best.set(nextKey, g);
            push({ point, g, f: g + estimate(point), parent: current });
        }
    }
    return null;
}
