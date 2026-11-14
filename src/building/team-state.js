// Editable team definitions. Legacy standalone lease helpers use SQLite too;
// managed teams keep scoped tasks and leases in team-runtime.sqlite.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openTeamStore } from './team-store.js';

export const ROLE_PERMISSIONS = Object.freeze({
    lead: {
        // 蓝图权威：设计、派单、全局验收；也可以下场施工。
        allow: ['*'],
        deny: [],
        blueprintAuthority: true,
        finishGate: true
    },
    builder: {
        allow: ['*'],
        deny: ['design_blueprint'],
        blueprintAuthority: false,
        finishGate: false
    },
    inspector: {
        allow: ['get_tool_help', 'send_message', 'broadcast', 'list_peers', 'observe_environment', 'observe_cells',
            'inspect_block', 'look_at', 'inspect_build', 'get_build_checklist', 'inspect_part',
            'inspect_blueprint', 'list_materials', 'claim_part', 'release_part', 'query_claims',
            'move_to', 'fly_to', 'land_at'],
        deny: [],
        whitelistOnly: true,
        blueprintAuthority: false,
        finishGate: false
    }
});

export function roleOf(spec, agentName) {
    const role = spec?.agents?.[agentName]?.role;
    return { name: role ?? 'builder', ...(ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.builder) };
}

export function actionAllowed(spec, agentName, toolName) {
    const role = roleOf(spec, agentName);
    const allowed = role.whitelistOnly
        ? role.allow.includes(toolName)
        : (role.allow.includes('*') || role.allow.includes(toolName)) && !role.deny.includes(toolName);
    return { allowed, role: role.name };
}

// ---- team spec 校验：随手画的图必须先过这些硬规则 ----
export function validateTeamSpec(spec) {
    const errors = [];
    const names = Object.keys(spec?.agents ?? {});
    if (!names.length) errors.push('团队至少需要一个 agent');
    for (const [name, entry] of Object.entries(spec?.agents ?? {})) {
        if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) errors.push('agent 名无效：' + name);
        if (entry?.role && !Object.hasOwn(ROLE_PERMISSIONS, entry.role)) errors.push(name + ' 的角色未知：' + entry.role);
        if (entry?.profile != null && (typeof entry.profile !== 'string' || !entry.profile.endsWith('.json'))) errors.push(name + ' 的 profile 必须为 JSON 文件路径');
        if (entry?.position != null && (!Number.isFinite(entry.position.x) || !Number.isFinite(entry.position.y))) errors.push(name + ' 的画布坐标无效');
        if (entry?.instructions != null && (typeof entry.instructions !== 'string' || entry.instructions.length > 2000)) errors.push(name + ' 的职责说明无效');
    }
    if (spec?.entryAgent && !names.includes(spec.entryAgent)) errors.push('团队入口必须是已有成员');
    if (!Array.isArray(spec?.edges ?? [])) return { ok: false, errors: [...errors, 'edges 必须是数组'] };
    for (const [index, edge] of (spec?.edges ?? []).entries()) {
        if (!names.includes(edge?.from) || !names.includes(edge?.to)) {
            errors.push('边 ' + index + ' 引用了不存在的 agent');
        }
        if (edge?.from === edge?.to) errors.push('边 ' + index + ' 不能自连');
        if (!['delegate', 'report', 'message'].includes(edge?.type)) {
            errors.push('边 ' + index + ' 类型必须是 delegate/report/message');
        }
        if (edge?.type === 'delegate' && !['lead', 'builder'].includes(spec?.agents?.[edge.from]?.role)) {
            errors.push('delegate 边的起点 ' + edge.from + ' 必须是 lead 或 builder');
        }
    }
    const rules = spec?.rules ?? {};
    for (const [key, allowed] of Object.entries({
        assignment: ['lead-assigns', 'spatial-parallel', 'first-claim'],
        handoff: ['on-part-verified', 'agent-driven'],
        finish: ['lead-gates', 'any-gates']
    })) if (rules[key] != null && !allowed.includes(rules[key])) errors.push('规则 ' + key + ' 取值无效');
    // 连通性：成员之间必须可达（任意边视作无向）。没有任何边时视为
    // 全对等（消息互通是默认能力，边只用来收紧拓扑）。
    if (names.length > 1 && (spec?.edges ?? []).length) {
        const adjacency = new Map(names.map(name => [name, new Set()]));
        for (const edge of spec?.edges ?? []) {
            adjacency.get(edge.from)?.add(edge.to);
            adjacency.get(edge.to)?.add(edge.from);
        }
        const seen = new Set([names[0]]);
        const queue = [names[0]];
        while (queue.length) for (const next of adjacency.get(queue.shift()) ?? []) {
            if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
        for (const name of names) if (!seen.has(name)) errors.push(name + ' 与团队不连通，请补边');
    }
    // 委托无环（delegate 边沿 from→to 方向不能成环）。
    const delegate = new Map(names.map(name => [name, []]));
    for (const edge of spec?.edges ?? []) if (edge.type === 'delegate') delegate.get(edge.from)?.push(edge.to);
    const visiting = new Set(), done = new Set();
    const cycle = node => {
        if (done.has(node)) return false;
        if (visiting.has(node)) return true;
        visiting.add(node);
        for (const next of delegate.get(node) ?? []) if (cycle(next)) return true;
        visiting.delete(node);
        done.add(node);
        return false;
    };
    for (const name of names) if (cycle(name)) { errors.push('delegate 边形成环：' + name); break; }
    // 唯一蓝图权威：lead-gates 或 lead-assigns 时必须恰有一个 lead。
    const leads = names.filter(name => spec.agents[name].role === 'lead');
    if ((rules.finish === 'lead-gates' || ['lead-assigns', 'spatial-parallel'].includes(rules.assignment)) && leads.length !== 1) {
        errors.push('该规则需要恰好一个 lead，当前 ' + leads.length + ' 个');
    }
    return { ok: !errors.length, errors };
}

// ---- 预设模板：前端一键生成 spec 的工厂 ----
export const TEAM_PRESETS = Object.freeze({
    centralized: names => ({
        agents: Object.fromEntries(names.map((name, i) => [name, { role: i === 0 ? 'lead' : 'builder' }])),
        edges: [...names.slice(1).flatMap(name => [{ from: names[0], to: name, type: 'delegate' }, { from: name, to: names[0], type: 'report' }]),
            ...names.flatMap(from => names.filter(to => to !== from).map(to => ({ from, to, type: 'message' })))],
        rules: { assignment: 'lead-assigns', handoff: 'on-part-verified', finish: 'lead-gates' }
    }),
    pipeline: names => ({
        agents: Object.fromEntries(names.map((name, i) => [name, { role: i === 0 ? 'lead' : 'builder' }])),
        edges: names.slice(1).map(name => ({ from: names[0], to: name, type: 'delegate' })),
        rules: { assignment: 'first-claim', handoff: 'on-part-verified', finish: 'any-gates' }
    }),
    peers: names => ({
        agents: Object.fromEntries(names.map((name, i) => [name, { role: i === 0 ? 'lead' : 'builder' }])),
        edges: [], rules: { assignment: 'first-claim', handoff: 'agent-driven', finish: 'any-gates' }
    })
});

// ---- 文件读写 ----
async function readJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

export function teamSpecPath(botsDir) { return join(botsDir, 'team.json'); }
export function claimsPath(botsDir) { return join(botsDir, 'claims.sqlite'); }

export async function readTeamSpec(botsDir) { return readJson(teamSpecPath(botsDir)); }
export async function readClaims(botsDir) {
    const store = openTeamStore(join(botsDir, 'claims.sqlite'));
    try { return store.read('claims', { version: 1, claims: {} }); }
    finally { store.close(); }
}

// 租约条目：{ partId, owner, since, expiresAt, assignmentVersion }。
// 过期条目在每次读写时惰性清理。
export function pruneExpired(claims) {
    const now = Date.now();
    const live = {};
    for (const [partId, entry] of Object.entries(claims)) if (entry.expiresAt > now) live[partId] = entry;
    return live;
}

export async function claimPart(botsDir, agentName, partId, { ttlMs = 5 * 60 * 1000, assignmentVersion = null } = {}) {
    const store = openTeamStore(join(botsDir, 'claims.sqlite'));
    try { return store.transaction('claims', { version: 1, claims: {} }, state => {
    const claims = pruneExpired(state.claims ?? {});
    const existing = claims[partId];
    if (existing && existing.owner !== agentName && existing.expiresAt > Date.now()) {
        return { status: 'conflict', partId, owner: existing.owner, expiresAt: existing.expiresAt };
    }
    claims[partId] = { partId, owner: agentName, since: Date.now(),
        expiresAt: Date.now() + ttlMs, ...(assignmentVersion != null ? { assignmentVersion } : {}) };
    state.claims = claims;
    return { status: 'claimed', partId, owner: agentName, expiresAt: claims[partId].expiresAt };
    }); } finally { store.close(); }
}

export async function releasePart(botsDir, agentName, partId) {
    const store = openTeamStore(join(botsDir, 'claims.sqlite'));
    try { return store.transaction('claims', { version: 1, claims: {} }, state => {
    const claims = pruneExpired(state.claims ?? {});
    const existing = claims[partId];
    if (!existing) return { status: 'not_claimed', partId };
    if (existing.owner !== agentName) return { status: 'conflict', partId, owner: existing.owner };
    delete claims[partId];
    state.claims = claims;
    return { status: 'released', partId };
    }); } finally { store.close(); }
}

export async function queryClaims(botsDir) {
    const state = await readClaims(botsDir);
    return { version: 1, claims: pruneExpired(state.claims ?? {}) };
}
