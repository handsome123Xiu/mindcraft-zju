import { prepareAssignment } from './blueprint.js';

export function inspectCells(expected, world, attempts = 0) {
    const differences = [];
    let verified = 0;
    let total = 0;
    for (const cell of expected) {
        if (cell.block !== 'air') total++;
        const actual = world.read(cell.pos);
        if (actual === cell.block) {
            if (cell.block !== 'air') verified++;
        } else {
            differences.push({ ...cell, actual, reason: actual == null ? 'unloaded' :
                actual === 'air' ? 'missing' : 'occupied' });
        }
    }
    return { total, verified, differences, attempts };
}

// Blueprints describe the goal for verification; they never schedule placement.
export function inspectAssignment(assignment, world) {
    return inspectCells(prepareAssignment(assignment).expected, world);
}
