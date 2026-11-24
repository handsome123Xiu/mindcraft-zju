// Older open consoles can omit fields introduced after that page was loaded.
// Keep an existing prerequisite for the same member and handoff route. An
// explicit null clears it; changing presets/routes does not inherit old ordering.
export function preserveTaskDependencies(candidate, previous) {
    const spec = structuredClone(candidate);
    const preserved = [];
    if (spec?.entryAgent !== previous?.entryAgent) return { spec, preserved };
    for (const [name, node] of Object.entries(spec?.agents ?? {})) {
        const before = previous?.agents?.[name];
        if (!node || !before || node.role !== before.role || node.taskReportTo !== before.taskReportTo) continue;
        for (const field of ['taskAfter', 'taskAcceptanceTo']) {
            if (!before[field] || Object.hasOwn(node, field)) continue;
            node[field] = before[field];
            if (!preserved.includes(name)) preserved.push(name);
        }
    }
    return { spec, preserved };
}
