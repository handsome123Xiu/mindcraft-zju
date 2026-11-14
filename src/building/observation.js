// Page the matching cells, not the entire scan. Counts always cover the full
// region so a page full of ground can never imply that all other cells are air.
export function scanEnvironment(region, world, { blocks, excludeBlocks = [], offset = 0, limit = 64 } = {}) {
    const counts = {};
    const matches = [];
    const unloaded = [];
    const groundHeights = {};
    let scanned = 0;
    for (let x = region.min[0]; x <= region.max[0]; x++) {
        for (let z = region.min[2]; z <= region.max[2]; z++) {
            let surface = null;
            for (let y = region.min[1]; y <= region.max[1]; y++) {
                const pos = [x, y, z];
                const actual = world.read(pos);
                scanned++;
                counts[actual ?? 'unloaded'] = (counts[actual ?? 'unloaded'] ?? 0) + 1;
                if (actual == null) { if (unloaded.length < 32) unloaded.push(pos); continue; }
                if (actual !== 'air') surface = y;
                if ((blocks ? blocks.includes(actual) : actual !== 'air') && !excludeBlocks.includes(actual)) matches.push({ pos, block: actual });
            }
            if (surface != null) groundHeights[surface] = (groundHeights[surface] ?? 0) + 1;
        }
    }
    const occupied = matches.slice(offset, offset + limit);
    const nextOffset = offset + occupied.length < matches.length ? offset + occupied.length : null;
    return { region, scanned, counts, occupied, occupiedTruncated: offset > 0 || nextOffset != null,
        filter: { blocks, excludeBlocks }, matched: matches.length, offset, nextOffset, unloaded,
        highestSolidYHistogram: groundHeights };
}

// Read exactly the requested cells instead of a whole region. Same counting
// rules as scanEnvironment: every requested position appears once, and an
// unloaded cell is reported as such, never assumed to be air.
export function scanCells(positions, world) {
    const counts = {};
    const cells = [];
    const unloaded = [];
    const seen = new Set();
    for (const value of positions) {
        const pos = [...value];
        const key = pos.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const actual = world.read(pos);
        counts[actual ?? 'unloaded'] = (counts[actual ?? 'unloaded'] ?? 0) + 1;
        if (actual == null) { if (unloaded.length < 32) unloaded.push(pos); continue; }
        if (actual !== 'air') cells.push({ pos, block: actual });
    }
    return { requested: seen.size, counts, cells, unloaded,
        airCount: seen.size - cells.length - unloaded.length };
}
