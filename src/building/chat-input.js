const CONTROLS = new Map([
    ['查询进度', 'status'], ['查看进度', 'status'], ['建造进度', 'status'],
    ['暂停', 'pause'], ['暂停建造', 'pause'], ['暂停施工', 'pause'],
    ['继续', 'resume'], ['继续建造', 'resume'], ['继续施工', 'resume'],
    ['取消', 'cancel'], ['取消建造', 'cancel'], ['取消施工', 'cancel'],
    ['!plan', 'status'], ['!buildStatus', 'status'], ['!pauseBuild', 'pause'], ['!pausePlan', 'pause'],
    ['!resumeBuild', 'resume'], ['!resumePlan', 'resume'], ['!cancelBuild', 'cancel'], ['!cancelPlan', 'cancel']
]);

export function parseBuildMessage(message, name) {
    let request = message.trim().replace(/[。.!！？?]+$/, '');
    const prefix = request.match(/^@?([^\s,，:：]+)[\s,，:：]+/);
    if (prefix?.[1].toLowerCase() === name.toLowerCase()) request = request.slice(prefix[0].length).trim();
    if (CONTROLS.has(request)) return { action: CONTROLS.get(request) };
    // Recognize renovation requests without treating them as a new build elsewhere.
    const editEnglish = /^(?:(?:please|can you|could you|help me)\s+)*(?:add|modify|edit|replace|remove|change|renovate|extend|repair|decorate)\b/i;
    const editChinese = /^(?:(?:请|帮我|给我|再|继续)\s*)*(?:添加|增加|加上|加个|加一|修改|改造|装修|扩建|拆除|替换|修复|给.{1,30}(?:加|装)|在.{1,30}(?:加|装))/;
    if (editEnglish.test(request) || editChinese.test(request)) return { action: 'unsupported_edit', request };
    const explicit = request.match(/^!build(?:\s+|$)/);
    if (explicit) {
        request = request.slice(explicit[0].length);
        const at = request.match(/^at\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:\s+|$)/);
        if (/^at(?:\s|$)/.test(request) && !at) throw new Error('请提供完整的三个整数坐标');
        const origin = at?.slice(1).map(Number);
        if (at) request = request.slice(at[0].length);
        return { action: 'build', origin, request };
    }
    const chineseBuild = /^(?:(?:请|能不能|能否|可以|麻烦|帮我|给我|我想让你|在附近)\s*)*(?:用[^，。]{1,16})?(?:建(?:造)?|盖|搭(?:建)?|修建|造)[一-龥0-9\s]/;
    const englishBuild = /^(?:(?:please|can you|could you|help me)\s+)*(?:build|bulid|buidl|construct|erect)\b/i;
    if (prefix?.[1].toLowerCase() === name.toLowerCase() || chineseBuild.test(request) || englishBuild.test(request)) {
        return { action: 'build', request };
    }
    return null;
}
