// Shared resource mechanics only: no role counts, approvals or workflow policy.
export const BLACKBOARD_TOOLS = new Set(['read_blackboard', 'write_blackboard', 'wait_for_blackboard', 'blueprint_blackboard']);
export const blackboardEnabled = spec => spec?.modules?.blackboard?.enabled === true;
export function blackboardPermission(spec, name, tool) {
    const p = spec?.agents?.[name]?.permissions;
    return blackboardEnabled(spec) && p?.allow?.includes(tool) && !p.deny?.includes(tool);
}
export function boardFor(run) {
    return run.blackboard ??= { revision: 0, entries: {}, changes: [] };
}
export function boardDigest(run) {
    const b = boardFor(run), d = run.blueprintDrafts;
    const latest = d?.items?.[d.latest];
    return { revision: b.revision, entries: Object.keys(b.entries).length,
        currentDraft: latest ? { id: latest.id, author: latest.author, summary: latest.summary, origin: latest.origin,
            blocks: latest.blueprint.blocks.length, shapes: latest.shapes.length } : null,
        publishedDraftId: run.publishedDraftId ?? null, revisionRequest: run.designRevisionRequest ?? null };
}
export function putBoard(run, author, { key, content, expectedRevision = 0 }, now = Date.now()) {
    if (typeof key !== 'string' || !/^[\w./:-]{1,100}$/.test(key)) throw new Error('黑板 key 需要 1–100 位字母、数字或 _./:-');
    if (typeof content !== 'string' || !content.trim() || content.length > 12000) throw new Error('黑板内容需要 1–12000 字符');
    const b = boardFor(run), before = b.entries[key];
    if (before?.author === author && before.content === content) return { status: 'unchanged', entry: before, revision: b.revision };
    if ((before?.revision ?? 0) !== expectedRevision) throw new Error('黑板版本冲突：请先读取 ' + key + '，当前条目版本 ' + (before?.revision ?? 0));
    if (!before && Object.keys(b.entries).length >= 512) throw new Error('黑板条目达到 512 项上限，请结束或拆分工程');
    if (b.changes.length >= 4096) throw new Error('黑板修订达到 4096 次上限，已保留全部记录');
    const entry = { key, content, author, revision: ++b.revision, at: now };
    b.entries[key] = entry;
    b.changes.push(entry);
    return { status: 'written', revision: b.revision, entry };
}
export function readBoard(run, { sinceRevision = 0, prefix = '', offset = 0, limit = 32, draftId } = {}) {
    const b = boardFor(run);
    const entries = Object.values(b.entries).filter(e => e.revision > sinceRevision && e.key.startsWith(prefix)).sort((a,b) => a.revision-b.revision);
    const result = { status: 'observed', ...boardDigest(run), goal: run.request, dimension: run.dimension,
        origin: run.origin, members: Object.keys(run.spec.agents), entries: entries.slice(offset, offset+limit),
        nextOffset: offset+limit < entries.length ? offset+limit : null };
    if (run.designRevisionRequest) {
        const cells = Object.entries(run.blackboardProtected ?? {});
        result.protected = { count: cells.length, cells: cells.slice(offset, offset+limit).map(([key,block])=>({pos:key.split(',').map(Number),block})),
            nextOffset: offset+limit < cells.length ? offset+limit : null };
    }
    if (draftId) {
        const draft = run.blueprintDrafts?.items?.[draftId];
        if (!draft) throw new Error('未知蓝图草稿 ' + draftId);
        result.draft = { id: draft.id, author: draft.author, baseDraftId: draft.baseDraftId,
            summary: draft.summary, origin: draft.origin, coverage: draft.coverage,
            bounds: draft.blueprint.bounds, coordinateSpace: 'blueprint',
            shapes: draft.shapes.slice(offset, offset+limit), shapeCount: draft.shapes.length,
            nextOffset: offset+limit < draft.shapes.length ? offset+limit : null };
    }
    return result;
}
