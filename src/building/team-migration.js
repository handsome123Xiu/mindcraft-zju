// Import boundary only. The executor never interprets legacy edge types.
export function migrateTeamSpec(source) {
    if (!source || typeof source !== 'object' || !source.agents || !Array.isArray(source.edges ?? [])) throw new Error('旧团队配置格式无效');
    const spec = structuredClone(source);
    if (spec.coordination === 'relationships' && !spec.rules && (spec.edges ?? []).every(e => !e.kind && !e.type)) return spec;
    const grouped = new Map();
    for (const edge of spec.edges ?? []) {
        if (!spec.agents[edge.from] || !spec.agents[edge.to] || edge.from === edge.to) throw new Error('旧连线包含不存在或相同的成员');
        const kind = edge.kind ?? edge.type;
        const description = edge.description ?? ({
            delegate: `${edge.from} 向 ${edge.to} 分配工作，${edge.to} 完成后汇报。`,
            report: `${edge.from} 向 ${edge.to} 汇报进展和结果。`,
            message: `${edge.from} 与 ${edge.to} 沟通协作。`
        })[kind];
        if (!description) throw new Error('无法转换未知旧连线，请补充自然语言关系说明');
        const key = [edge.from, edge.to].sort().join(':');
        const words = description + (edge.label ? ` 关系名称：${edge.label}。` : '') + (edge.note ? ` ${edge.note}` : '');
        const prior = grouped.get(key);
        if (prior) prior.description += '\n' + words;
        else grouped.set(key, { from: edge.from, to: edge.to, description: words });
    }
    const names = Object.keys(spec.agents);
    // Old empty graphs allowed everyone to communicate. Materialize those links.
    spec.edges = grouped.size ? [...grouped.values()] : names.flatMap((from, i) => names.slice(i + 1)
        .map(to => ({ from, to, description: `${from} 与 ${to} 自由沟通，根据各自权限协商分工。` })));
    spec.coordination = 'relationships';
    delete spec.rules;
    return spec; // Permissions, responsibilities and profiles are never elevated.
}
