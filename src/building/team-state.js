// Editable team definitions. Legacy standalone lease helpers use SQLite too;
// managed teams keep scoped tasks and leases in team-runtime.sqlite.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openTeamStore } from './team-store.js';
import { TOOL_SCHEMAS } from './action-protocol.js';

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
    const entry = spec?.agents?.[agentName];
    // 自定义角色：内联 permissions 优先于内置角色表。名字自由，权限锚定能力。
    if (entry?.permissions) return { name: entry.role ?? 'custom', ...ROLE_PERMISSIONS.builder, ...entry.permissions };
    const role = entry?.role;
    return { name: role ?? 'builder', ...(ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.builder) };
}

export function actionAllowed(spec, agentName, toolName) {
    const role = roleOf(spec, agentName);
    const allowed = role.whitelistOnly
        ? role.allow.includes(toolName)
        : (role.allow.includes('*') || role.allow.includes(toolName)) && !role.deny.includes(toolName);
    return { allowed, role: role.name };
}

// 能力摘要：运行时与校验锚定的是能力位，不是角色头衔。
export function capabilities(spec, agentName) {
    const role = roleOf(spec, agentName);
    return { name: role.name, canBuild: actionAllowed(spec, agentName, 'place_block').allowed,
        canDelegate: actionAllowed(spec, agentName, 'delegate_task').allowed,
        blueprintAuthority: role.blueprintAuthority === true, finishGate: role.finishGate === true };
}

// Relationship descriptions guide the model; they never grant permissions.
export function edgeAllows(spec, from, to) {
    if (!spec?.agents?.[from] || !spec.agents[to] || from === to) return false;
    return (spec.edges ?? []).some(edge =>
        (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from));
}

// ---- team spec 校验：随手画的图必须先过这些硬规则 ----
export function validateTeamSpec(spec) {
    const errors = [];
    if (spec?.coordination !== 'relationships') errors.push('仅支持自然语言关系配置，请先转换旧配置（coordination: relationships）');
    if (spec?.rules != null) errors.push('旧 rules 已移除，请将协作约定写入关系说明并独立配置权限');
    const names = Object.keys(spec?.agents ?? {});
    if (!names.length) errors.push('团队至少需要一个 agent');
    for (const [name, entry] of Object.entries(spec?.agents ?? {})) {
        if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) errors.push('agent 名无效：' + name);
        // 角色名自由：内置表内的名字直接用；表外必须带内联 permissions。
        if (entry?.role != null) {
            if (typeof entry.role !== 'string' || !/^[a-z0-9_-]{1,20}$/.test(entry.role)) errors.push(name + ' 的角色名无效（小写字母/数字/-/_，≤20 字符）');
            else if (!Object.hasOwn(ROLE_PERMISSIONS, entry.role) && entry.permissions == null) errors.push(name + ' 使用自定义角色 ' + entry.role + '，必须提供 permissions（allow/deny/whitelistOnly/blueprintAuthority/finishGate）');
        }
        if (entry?.permissions != null) {
            const p = entry.permissions;
            if (typeof p !== 'object' || Array.isArray(p)) errors.push(name + ' 的 permissions 必须是对象');
            else {
                for (const key of ['allow', 'deny']) if (p[key] != null && (!Array.isArray(p[key]) ||
                    p[key].some(item => item !== '*' && !Object.hasOwn(TOOL_SCHEMAS, item) && item !== 'design_blueprint')))
                    errors.push(name + ' 的 permissions.' + key + ' 含未知工具名');
                if (p.whitelistOnly != null && typeof p.whitelistOnly !== 'boolean') errors.push(name + ' 的 permissions.whitelistOnly 必须是布尔');
                if (p.whitelistOnly === true && !Array.isArray(p.allow)) errors.push(name + ' 的 whitelistOnly 需要 allow 白名单');
                for (const key of ['blueprintAuthority', 'finishGate']) if (p[key] != null && typeof p[key] !== 'boolean') errors.push(name + ' 的 permissions.' + key + ' 必须是布尔');
            }
        }
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
        if (typeof edge?.description !== 'string' || !edge.description.trim() || edge.description.length > 2000) errors.push('边 ' + index + ' 需要 1–2000 字符的自然语言关系说明');
        if (edge?.kind != null || edge?.type != null) errors.push('自然语言关系不使用 kind/type，请先转换旧连线');
        if (edge?.label != null && (typeof edge.label !== 'string' || edge.label.length > 20)) errors.push('边 ' + index + ' 标签 ≤20 字符');
        if (edge?.note != null && (typeof edge.note !== 'string' || edge.note.length > 200)) errors.push('边 ' + index + ' 备注 ≤200 字符');
    }
    const pairs = new Set();
    for (const edge of spec?.edges ?? []) {
        const pair = [edge?.from, edge?.to].sort().join(':');
        if (pairs.has(pair)) errors.push('成员之间只需一条关系连线，请合并双方说明');
        pairs.add(pair);
    }
    // Communication cycles are fine; actual task dependency cycles are not.
    if (names.length > 1) {
        const adjacency = new Map(names.map(name => [name, new Set()]));
        for (const edge of spec?.edges ?? []) {
            adjacency.get(edge?.from)?.add(edge?.to);
            adjacency.get(edge?.to)?.add(edge?.from);
        }
        const seen = new Set([names[0]]);
        const queue = [names[0]];
        while (queue.length) for (const next of adjacency.get(queue.shift()) ?? []) {
            if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
        for (const name of names) if (!seen.has(name)) errors.push(name + ' 与团队不连通，请补边');
    }
    if (names.length) {
        const entry = spec.entryAgent ?? names.find(name => spec.agents[name].role === 'lead') ?? names[0];
        if (!capabilities(spec, entry).blueprintAuthority || !actionAllowed(spec, entry, 'design_blueprint').allowed) errors.push('本版团队入口需要蓝图设计权限');
        if (!capabilities(spec, entry).finishGate) errors.push('本版团队入口需要全局验收权限');
    }
    return { ok: !errors.length, errors };
}

// ---- 预设模板：前端一键生成 spec 的工厂 ----
// 每个角色的 instructions 与前端 defaultTeamSpec 保持同一套话术：API 调用方与
// 控制台点预设拿到的行为定义必须一致，否则手写 team.json 的团队会"裸奔"。
const PRESET_INSTRUCTIONS = {
    centralized: {
        entry: '你是团队中心，对整体目标和最终结果负责。观察场地、设计共享蓝图，根据实际支撑、通行、工作量、成员位置和进展自主分工：可以派不同模块，也可以给同一模块划定互不重叠的 scope 范围让成员一起建。不预设左右分区或必须同时开工；独立任务先全部派出，只有真实依赖才等待。允许 builder 交流并通过协作提案交接自己的局部工作。监督进度、调整阻塞任务，最后验收全部蓝图及空位并汇报。',
        member: '你是施工成员，按共享蓝图和任务 scope 施工；同一模块可有其他成员参与。根据现场选择顺序，与队友交流支撑、分工、让路和协助。需要分担时 propose_task_share 提出自己的局部范围，队友 respond_task_share 接受后，由你在动作之间 commit_task_share 正式交接。只有收到运行时任务才开工。交接后原目标仍由你负责，等待协作者完成并验收完整原任务后 complete_task。遇到阻塞向 lead 报告，不能擅改蓝图。requirements 保持原文，进度写入步骤 evidence。'
    },
    peers: {
        entry: '你是平等协作组成员之一，也是对外接单入口：收到用户目标后，先用 broadcast 把目标和场地证据告诉全组，公开讨论分工与由谁设计蓝图。设计者由协商推选（谁合适谁设计，不必是你）；你可以自荐或支持他人，自己也具备设计蓝图的能力。蓝图发布后按协商分工施工，任何成员都可以提议任务和交接范围。所有子任务完成且全组核验通过后，由你做最终验收（entry 职责，不是指挥权）。',
        member: '你是平等协作组成员。用 broadcast 或 send_message 与同伴讨论分工、推选蓝图设计者并表达意见；你同样具备设计蓝图的能力，被推选者用 design_blueprint 发布共享蓝图（发布者只负责设计，施工仍按协商分工）。按共享蓝图施工，可以把部分范围正式委托给相连成员，也可以接受同伴的委托。范围或顺序有异议时直接协商，不必等待指派。'
    },
    hierarchy: {
        entry: '你是工程入口，负责接收用户目标、发布共享蓝图和最终验收。根据关系说明与成员权限组织协作，通过正式任务登记范围和依赖；尊重成员的自主分工。',
        member: '根据关系说明、自己的权限和任务范围协作。可以执行，也可以把自己的部分范围正式委托给相连成员；等待下级完成并验收原始范围后，向任务分配者汇报。遇到阻塞与相连成员沟通，不擅自修改蓝图或扩大权限。'
    }
};
function preset(names, mode) {
    const pairs = mode === 'hierarchy' ? names.slice(1).map((to, i) => [names[i], to]) :
        names.flatMap((from, i) => names.slice(i + 1).map(to => [from, to]));
    // peers 模式没有权力中心：所有成员同为 builder 且都具备蓝图设计能力，
    // 设计者由协商推选；入口成员多 finishGate（最终验收的功能锚点，
    // entryAgent 校验要求），不是设计垄断也不是指挥权。
    const agents = mode === 'peers'
        ? Object.fromEntries(names.map((name, i) => [name, i === 0
            ? { role: 'builder', permissions: { allow: ['*'], deny: [], blueprintAuthority: true, finishGate: true },
                instructions: PRESET_INSTRUCTIONS.peers.entry }
            // 内联 permissions 以 builder 表为底（deny 含 design_blueprint），
            // 全员设计能力必须显式清空 deny。
            : { role: 'builder', permissions: { deny: [], blueprintAuthority: true },
                instructions: PRESET_INSTRUCTIONS.peers.member }]))
        : Object.fromEntries(names.map((name, i) => [name, i === 0
            ? { role: 'lead', instructions: PRESET_INSTRUCTIONS[mode].entry }
            : { role: 'builder', instructions: PRESET_INSTRUCTIONS[mode].member }]));
    return { coordination: 'relationships', entryAgent: names[0],
        agents,
        edges: pairs.map(([from, to]) => ({ from, to, description: mode === 'hierarchy' || (mode === 'centralized' && from === names[0]) ?
            `${from} 分配目标和范围，${to} 按权限执行或组织下级完成，并汇报结果。` : `${from} 与 ${to} 平等协商，根据能力分担工作；通过正式任务或交接记录避免重复施工。` })) };
}
function reviewRevision(names = ['lead', 'builder', 'reviewer']) {
    if (!Array.isArray(names) || names.length !== 3 || new Set(names).size !== 3 || names.some(name => typeof name !== 'string' || !name)) {
        throw new Error('审查修订预设需要 3 位不同的成员');
    }
    const [lead, builder, reviewer] = names;
    return { coordination: 'relationships', entryAgent: lead, agents: {
        [lead]: {
            role: 'lead',
            permissions: { allow: ['*'], deny: ['prepare_parallel_build'], blueprintAuthority: true, finishGate: true },
            instructions: [
                '按设计、施工、语义审查三个阶段更新整体计划，保留用户原始指令及后续要求。先观察工地、发布共享蓝图，再只把初版施工委托给 ' + builder + '。',
                '等施工任务全部完成并释放租约，再给 ' + reviewer + ' 派「语义审查」任务，覆盖整栋建筑。原始指令由 TEAM_GOAL 提供，任务描述转交用户后续补充。验收要求按原始指令逐项给出现场证据、必修项和可选点缀。审查任务在旧版上完成，施工结果与蓝图一致并不代表审查通过。',
                '派出任务后用 wait_for_team 等待，不靠轮询猜测阶段。收到审查完成事件后用 list_tasks 读取完整 summary，将审查发现和处理决定写入计划证据，之后再修订。',
                '根据现场证据核对审查建议。只有满足用户原始要求确需拆除或替换时，才在确认替代方案和改动坐标后，使用 claim_part 认领旧版对应部件，确认坐标和实际方块，通过 dig_block 显式拆除，再用 release_part 释放租约。可选点缀不得触发拆除。',
                '有改动时保留其余成品和全部用户要求，调用 design_blueprint 发布新版。用新版部件和实际待改格子向 ' + reviewer + ' 单独派「修复/点缀」任务，要求审查员在完成报告中按原始要求复核改动。旧版审查已完成，新版任务不要引用旧版任务 ID 作为 dependsOn。',
                '没有可采纳的改动时记录原因。有修补时，等 ' + reviewer + ' 汇报已完成修补与复核。完成整体计划、重新核验现场后再 finish。最终向用户说明哪些要求已满足、做了哪些修复及点缀。'
            ].join('\n')
        },
        [builder]: {
            role: 'builder',
            permissions: { deny: ['design_blueprint', 'delegate_task', 'propose_task_share', 'respond_task_share', 'commit_task_share'] },
            instructions: '你负责初版施工。只在 ' + lead + ' 下达的正式任务范围内按共享蓝图施工，验收范围后用 complete_task 回报实际完成情况和施工证据。在提交完成结果前，可以向审查员 ' + reviewer + ' 提供现场重点和需要留意的部件；审查由 Lead 发起。遇到阻塞向 Lead 报告，按其安排继续。'
        },
        [reviewer]: {
            role: 'reviewer',
            permissions: { whitelistOnly: true, allow: [
                'get_tool_help', 'send_message', 'observe_environment', 'observe_cells', 'inspect_block',
                'look_at', 'move_to', 'fly_to', 'land_at', 'inspect_build', 'inspect_blueprint',
                'get_build_checklist', 'inspect_part', 'list_materials', 'list_tasks',
                'place_block', 'place_row', 'place_rectangle', 'place_cube'
            ] },
            instructions: [
                '你负责语义审查和修复。仅在接到 ' + lead + ' 的正式任务后开始对应工作。收到施工成员消息可记录现场线索，等待正式指派。',
                '「语义审查」：现场观察真实建筑，逐项对照 TEAM_GOAL（用户最初的自然语言指令）和任务描述里的用户补充要求。检查功能、布局、外观与出入口等实际效果，按需求提供位置或观察证据。区分必修问题与少量可选点缀；可选点缀应匹配原风格，不能挤占主要功能。',
                '审查阶段只观察、记录、提建议。完成本地审查计划并记录观察证据，把需求符合情况、必修项（坐标、现状、目标）、可选点缀和理由写入 complete_task 的 summary。现有任务结算仍核对旧版现场，语义缺口写入审查结果交 Lead 处理。若现场变化导致旧任务无法结算，向 Lead 报告具体差异和坐标。',
                '「修复/点缀」：等 Lead 发布新版并正式委托后，按新版和分配范围补建。若需要拆改或现场未清理，报告 Lead 处理。完成后观察改动后的整体效果，对照原始要求复核，在 complete_task 说明实际效果和仍存在的问题。'
            ].join('\n')
        }
    }, edges: [
        { from: lead, to: builder, label: '蓝图 → 施工', description: lead + ' 发布蓝图并委托初版施工；' + builder + ' 核验委托范围后回报，释放施工租约。' },
        { from: builder, to: reviewer, label: '成品 → 审查', description: builder + ' 向 ' + reviewer + ' 交接成品位置及施工线索。只有在初版工序完成且收到 Lead 正式审查任务后，审查员才开始按用户原始指令检查。' },
        { from: lead, to: reviewer, label: '审查反馈与修订', description: reviewer + ' 向 ' + lead + ' 提交语义审查结果；Lead 决定必要拆改并发布修订蓝图，再向审查员委托明确的修补或点缀范围。' }
    ] };
}

function routerPreset(names = ['lead', 'router', 'builder_1', 'builder_2']) {
    if (!Array.isArray(names) || names.length < 3 || new Set(names).size !== names.length ||
        names.some(name => typeof name !== 'string' || !name)) {
        throw new Error('模型路由预设需要独立的蓝图 Lead、Router 和至少一位执行者');
    }
    const [lead, router, ...workers] = names;
    return {
        coordination: 'relationships',
        entryAgent: lead,
        agents: {
            [lead]: {
                role: 'lead',
                permissions: { allow: ['*'], deny: ['prepare_parallel_build'], blueprintAuthority: true, finishGate: true },
                instructions: [
                    '负责接收原始指令、观察现场、发布共享蓝图和最终验收。发布后把未完成施工范围通过一个正式父任务交给 ' + router + '，说明要求、整体范围和已知依赖。',
                    '执行者的筛选和细分由 Router 完成。用 wait_for_team 等待 Router 汇总已验收的结果。蓝图需要变更时由你处理。最终对照用户要求与现场证据完成项目。'
                ].join('\n')
            },
            [router]: {
                role: 'router',
                permissions: { whitelistOnly: true, allow: [
                    'get_tool_help', 'send_message', 'list_peers', 'list_tasks', 'get_build_checklist',
                    'inspect_part', 'inspect_blueprint', 'inspect_build', 'observe_environment', 'observe_cells', 'inspect_block',
                    'delegate_task', 'reassign_task'
                ] },
                instructions: [
                    '你专职路由。收到 Lead 的父任务后，读取共享蓝图、施工清单和成员状态，把父任务中尚未完成的格子按所需能力拆成明确范围。',
                    '每条「模型路由」关系的备注列出执行者所配模型，关系说明可补充模型擅长的任务或实测经验。选择时优先匹配明确的能力证据，再考虑在线、可领任务和场地条件。档案相同或能力未知时，用就绪状态、相关已验证结果和当前任务量分配，模型名本身不代表强弱。',
                    '用 delegate_task 将各段交给合适的执行者，每段只选一个接收者。可以选择多个执行者处理不同且不重叠的范围，也可以让一人负责适合其完成的连续工作。任务描述注明选派依据、范围和验收条件；只对真实施工依赖设置 dependsOn。',
                    '派单后用 wait_for_team 等结果。阻塞时读任务状态和现场问题，必要时用 reassign_task 重派同一任务。无人具备必要能力时如实向 Lead 报告缺口。所有子任务完成且父范围现场核验通过后，用 complete_task 汇报路由决定和结果。'
                ].join('\n')
            },
            ...Object.fromEntries(workers.map(name => [name, {
                role: 'builder',
                permissions: { deny: ['design_blueprint', 'delegate_task', 'prepare_parallel_build', 'propose_task_share', 'respond_task_share', 'commit_task_share'] },
                instructions: '你负责执行。只在收到 ' + router + ' 的正式任务后按共享蓝图施工，仅操作分配范围。按任务要求完成并现场核验，再用 complete_task 向 Router 报告实际结果和证据；遇到阻塞说明位置和原因。'
            }]))
        },
        edges: [
            { from: lead, to: router, label: '蓝图与路由委托', description: lead + ' 发布共享蓝图并把施工范围交给 ' + router + '；Router 根据执行者模型和任务要求选人、细分、派单，最后向 Lead 汇总。' },
            ...workers.map(worker => ({ from: router, to: worker, label: '模型路由',
                description: router + ' 根据 ' + worker + ' 的模型和能力选择合适的工作。可在本关系说明补充该模型的擅长项或实测表现。' + worker + ' 仅执行收到的正式任务并汇报。' }))
        ]
    };
}

function competitivePreset(names = ['lead', 'candidate_a', 'candidate_b']) {
    if (!Array.isArray(names) || names.length !== 3 || new Set(names).size !== 3 ||
        names.some(name => typeof name !== 'string' || !name)) {
        throw new Error('竞争择优预设需要一位 Lead 和两位不同的候选');
    }
    const [lead, ...candidates] = names;
    return {
        coordination: 'relationships',
        entryAgent: lead,
        agents: {
            [lead]: {
                role: 'lead',
                permissions: { whitelistOnly: true, blueprintAuthority: true, finishGate: true, allow: [
                    'get_tool_help', 'send_message', 'list_peers', 'observe_environment', 'observe_cells', 'inspect_block',
                    'look_at', 'move_to', 'fly_to', 'land_at', 'list_materials', 'design_blueprint', 'inspect_blueprint',
                    'get_build_checklist', 'inspect_part', 'inspect_build', 'delegate_task', 'reassign_task', 'list_tasks'
                ] },
                instructions: [
                    '你是竞争评选的 Lead。更新整体计划并先观察场地。用 send_message 分别给 ' + candidates.join(' 和 ') +
                    ' 发同一份【方案征集】，包含用户原始要求及补充、同一场地摘要和评选标准。每位候选独立回复一次；不要向候选转发另一份提案。征集阶段先不设计或发布蓝图，也不派施工任务。',
                    '根据团队消息的发送者识别提案。两份到齐就评选。尚未齐时用 send_message 告诉用户缺少哪份，并提示稍后发「开始评选」，随后 wait_for_user。队友回信会保留到下一轮。没有子任务时不要用 wait_for_team，也不要重复发送征集。用户发送「开始评选」后先检查已收到的回复；缺案仍需等待，除非用户明确同意按单案继续。',
                    '用同一标准比较：先核对用户硬性要求，排除不符合者；再比较场地适配、支撑与通行风险，最后比较施工复杂度。选一个可行方案，不拼接候选方案。同等条件下优先施工更简单者；仍相同按征集顺序选。都不可行时说明缺口，向用户确认后再处理。',
                    '把胜出者、采用的方案和选择理由记录到计划证据，并向用户说明。随后用 design_blueprint 将胜出方案转成符合原始要求的共享蓝图。蓝图发布后用 delegate_task 把全部未完成范围交给胜出者；其余候选不施工。',
                    '等待胜出者完成施工，仅在其可恢复时重派给同一成员。胜出者无法继续时先告知用户，由用户决定下一步。最后按用户原始要求和现场证据验收，再用 finish 汇报。'
                ].join('\n')
            },
            ...Object.fromEntries(candidates.map(name => [name, {
                role: 'candidate',
                permissions: { deny: ['design_blueprint', 'delegate_task', 'prepare_parallel_build',
                    'propose_task_share', 'respond_task_share', 'commit_task_share'] },
                instructions: [
                    '收到 ' + lead + ' 的【方案征集】时，在协调回合根据 TEAM_GOAL、征集中的补充要求和同一场地摘要独立提出一份建筑方案。只给 Lead 发一条【参赛方案】消息，不超过 160 字，包含布局或关键尺寸、材料、工序和主要风险，然后 end_turn。无法满足某个硬要求时直接说明，勿假定场地条件。',
                    '只有在收到 Lead 发来的正式施工委托时，才按共享蓝图和任务范围实施胜出的方案。施工完成后核验现场并 complete_task 汇报。其他消息在协调回合处理，未获正式施工委托时不施工。'
                ].join('\n')
            }]))
        },
        edges: candidates.map(candidate => ({ from: lead, to: candidate, label: '独立提案与择优',
            description: lead + ' 发统一的征集条件，' + candidate + ' 独立提交给 Lead；评选结束后仅胜出者接收正式施工委托。' }))
    };
}

function votingPreset(names = ['lead', 'voter_1', 'voter_2', 'voter_3']) {
    if (!Array.isArray(names) || names.length !== 4 || new Set(names).size !== 4 ||
        names.some(name => typeof name !== 'string' || !name)) {
        throw new Error('多数投票预设需要一位 Lead 和三位不同的投票者');
    }
    const [lead, ...voters] = names;
    return {
        coordination: 'relationships',
        entryAgent: lead,
        agents: {
            [lead]: {
                role: 'lead',
                permissions: { whitelistOnly: true, blueprintAuthority: true, finishGate: true, allow: [
                    'get_tool_help', 'send_message', 'list_peers', 'observe_environment', 'observe_cells', 'inspect_block',
                    'look_at', 'move_to', 'fly_to', 'land_at', 'list_materials', 'design_blueprint', 'inspect_blueprint',
                    'get_build_checklist', 'inspect_part', 'inspect_build', 'delegate_task', 'reassign_task', 'list_tasks'
                ] },
                instructions: [
                    '你主持 A/B 多数投票，自己不投票。更新整体计划并观察场地。选一个确实影响建筑、且用户尚未确定的决策，给出两个可行且符合用户硬性要求的备选。通过 send_message 向 ' + voters.join('、') +
                    ' 分别发送同一份【征集投票#1】，写清 A、B 各代表什么、场地证据和相关用户约束。不得在同一轮改变选项或转发其他人的票。确定结果前不发布蓝图或派工。',
                    '只按团队消息的真实发送者计票。同一轮每位指定成员只计第一张有效 A/B 票，重复票、上一轮选票、弃权和无效回复不计。两票投同一选项即为多数，可直接采用该选项；不得用自己的偏好改票或决定胜负。',
                    '尚无多数且仍缺有效回复时，说明当前票数及缺少谁，发消息请用户稍后发送「开始计票」，随后 wait_for_user。唤醒后检查已收到的同一轮消息，不重新征集或轮询团队。若分不出多数且成员已全部回复，说明原因，必要时更新选项并使用新轮次编号。',
                    '把票数、胜出选项、具体设计决定和主要理由记录在计划证据。调用 design_blueprint 之前，必须先用 send_message 向用户公布票数与结果，写清 A 与 B 各有几票、采用哪个选项及对应的设计，并简述理由。公布后再用 design_blueprint 将胜出选项落实到共享蓝图；若只是几何格式错误，修正几何并保留投票选择。若现场证实该选项不可实施，报告原因后换可行选项重新表决。',
                    '蓝图发布后先核对返回的 bounds，必要时用 inspect_blueprint 检查关键格子。确保胜出特征落实在实际蓝图里，并用现场观测确认最低施工层有支撑；发现位置或支撑错误时修订蓝图。核对通过后，用一次 delegate_task 把全部未完成施工范围交给一名就绪成员。派工前查 team.agents，只选 online=true 且 canAcceptTask=true 的成员；投票内容不影响施工资格。等待该成员完成，再结合原始要求和现场结果 finish。'
                ].join('\n')
            },
            ...Object.fromEntries(voters.map(name => [name, {
                role: 'voter',
                permissions: { deny: ['design_blueprint', 'delegate_task', 'prepare_parallel_build',
                    'propose_task_share', 'respond_task_share', 'commit_task_share'] },
                instructions: [
                    '收到 ' + lead + ' 的【征集投票#N】时，对照 TEAM_GOAL、补充要求和题面中的现场证据独立判断。只向 Lead 私发一次「【投票#N】A｜一句理由」或「【投票#N】B｜一句理由」，编号沿用题面，回复不超过 100 字，然后 end_turn。若两案都违反硬性要求，回复「【投票#N】弃权｜原因」。',
                    '只有收到 Lead 的正式施工委托后才按共享蓝图和任务范围施工。投了另一案也按最终蓝图执行，完成后现场核验并 complete_task。'
                ].join('\n')
            }]))
        },
        edges: voters.map(voter => ({ from: lead, to: voter, label: '独立投票',
            description: lead + ' 发同一份 A/B 选项，' + voter + ' 独立回投一票。Lead 按多数票落实蓝图，再按施工需求派工。' }))
    };
}

export const TEAM_PRESETS = Object.freeze({
    centralized: names => preset(names, 'centralized'),
    peers: names => preset(names, 'peers'),
    hierarchy: names => preset(names, 'hierarchy'),
    review_revision: reviewRevision,
    router: routerPreset,
    competitive: competitivePreset,
    voting: votingPreset
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
