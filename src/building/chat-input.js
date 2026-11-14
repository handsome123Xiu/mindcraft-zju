const CONTROLS = new Map([
    ['进度', 'status'], ['查询进度', 'status'], ['查看进度', 'status'], ['建造进度', 'status'],
    ['暂停', 'pause'], ['暂停建造', 'pause'], ['暂停施工', 'pause'],
    ['继续', 'resume'], ['继续建造', 'resume'], ['继续施工', 'resume'],
    ['取消', 'cancel'], ['取消建造', 'cancel'], ['取消施工', 'cancel'],
    ['!plan', 'status'], ['!buildStatus', 'status'], ['!pauseBuild', 'pause'], ['!pausePlan', 'pause'],
    ['!resumeBuild', 'resume'], ['!resumePlan', 'resume'], ['!cancelBuild', 'cancel'], ['!cancelPlan', 'cancel']
]);

export function parseBuildMessage(message, name) {
    let request = message.trim();
    const prefix = request.match(/^@?([^\s,，:：]+)[\s,，:：]+/);
    if (prefix?.[1].toLowerCase() === name.toLowerCase()) request = request.slice(prefix[0].length).trim();
    const control = request.replace(/[。.!！？?]+$/, '');
    if (CONTROLS.has(control)) return { action: CONTROLS.get(control) };
    const explicit = request.match(/^!build(?:\s+|$)/);
    if (explicit) {
        request = request.slice(explicit[0].length);
        const at = request.match(/^at\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:\s+|$)/);
        if (/^at(?:\s|$)/.test(request) && !at) throw new Error('请提供完整的三个整数坐标');
        const origin = at?.slice(1).map(Number);
        if (at) request = request.slice(at[0].length);
        return { action: 'message', origin, request: request.trim() };
    }
    // Intent is decided by the model, never by building keywords or punctuation.
    return request ? { action: 'message', request } : null;
}
