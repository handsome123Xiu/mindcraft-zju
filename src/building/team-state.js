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

// ---- 预设模板：角色约定写进 agents[name].instructions，连线和权限单独配置 ----
const PRESET_INSTRUCTIONS = {
    pipeline: {
        entry: stages => [
            '你负责固定施工流水线：' + stages.join(' → ') + '。观察场地，发布一份共享蓝图。按建筑实际部件划分基底、主体和收尾；简单建筑可用三个连续区段。三个阶段各有可核验、互不重叠的范围，前序留下的支撑或边界应能现场检查。',
            '按工序为三人分别调用 delegate_task。首段可直接领取；后两项各用 dependsOn 引用上一条委托返回的 taskId。任务描述写清阶段、部件、范围和开工条件，引用已发布的蓝图版本。材料以当前蓝图的方块 ID 为准，任务描述里避免复述未经核对的材质或坐标。登记完整任务链后用 wait_for_team 等待。',
            '若有阻塞，用 list_tasks 查看是哪个阶段，条件恢复后用 reassign_task 恢复原任务，保留其下游依赖。最后一段完成且所有前序已结算，再按原要求和现场结果整体核验并 finish。'
        ].join('\n'),
        stage: (index, previous, next) => [
            '你负责流水线第 ' + (index + 1) + ' 段。收到正式任务后按 partIds 和 workScope 施工。' +
                (previous ? '先核对 ' + previous + ' 的阶段完成记录与现场支撑。聊天交接用于了解现场，正式任务是开工依据。若仅在协调回合收到交接消息，简短确认并 end_turn 等放行。' : '按任务要求完成后续工序需要的首段支撑或边界。'),
            '领取或重派时，用 inspect_part 检查当前委托范围。材料、坐标和版本以该工具返回的已发布蓝图为准；任务描述或旧计划里的别名、翻译和推测，仅用于理解任务。',
            '已有可执行的 suggestions.actions 时，在下一步直接执行当前范围内的建议，保留原样的 block、坐标、partId、assignmentVersion。若没有建议，按 differences 中的实际缺失格和精确材料调用合适的放置工具，先建有支撑的格。施工后再复查；若工具报错，按具体错误调整。',
            '现场核验本段后，' + (next ? '用 send_message 直接向 ' + next + ' 交接验收结果、边界或支撑位置，提醒对方等正式放行。' : '向入口说明最后一段结果和整体验收要注意的位置。'),
            '用 complete_task 提交本段结果。若支撑或现场条件不符，报告准确坐标、现状和期望状态。'
        ].join('\n')
    },
    centralized: {
        entry: [
            '你是团队派工中心，负责共享蓝图、整体调度和最终验收。观察场地，结合支撑、动线、工作量及成员状态分工。可以分给成员独立模块，也可以在同一模块给不同人清楚且互不重叠的 scope。独立任务先派出，真实依赖用 dependsOn 登记。',
            '用 wait_for_team 等事件。任务阻塞时核对原因及成员是否可领工，优先恢复或重派原任务。伙伴可直接商量让路或局部分担；你负责调整整体安排。全部任务结算后，按原始目标核验建筑和空位，再 finish。'
        ].join('\n'),
        member: [
            '你承接中心分配的施工。收到正式委托后查看 workScope，核验支撑与动线，按蓝图施工。需要同伴让路或配合时，用 send_message 直接联系相关人，说明位置和所需动作。',
            '用 propose_task_share 提出局部分担，接收人 respond_task_share 接受后再 commit_task_share。空闲时可以回应，接受后 end_turn 等正式任务。交接发起者等协作者完成后核验原范围，再 complete_task；阻塞时给派工人具体坐标和原因。'
        ].join('\n')
    },
    parallel: {
        entry: workers => [
            '你负责在一份总蓝图上组织并行作业。为 ' + workers.join('、') + ' 各划一个独立模块或区段，核对目标格、支撑和施工动线互不依赖。若存在共用前置支撑，重新划出独立模块，或先完成共同准备再发这一批。',
            '发布蓝图后，用 delegate_task 给每位 Builder 分配独立范围和验收标准，同批连续发出全部委托，留空 dependsOn，全部发出后再 wait_for_team。',
            '一条分支受阻时让其他分支继续，定位被阻塞任务并处理。等每个模块都正式完成后，一次核验模块边界和整体要求并 finish。'
        ].join('\n'),
        member: lead => [
            '你负责一条并行施工分支。收到正式任务即可核对现场后开工，只写自己的 workScope，保持其他模块入口畅通。',
            '完成本区后现场验收，用 complete_task 向 ' + lead + ' 交付本模块的范围和证据。发现实际依赖别区时，向 ' + lead + ' 报告缺少的支撑、通路或坐标，由入口处理。'
        ].join('\n')
    },
    peers: {
        entry: [
            '你是平等协作组成员之一，也是对外接单入口：收到用户目标后，先用 broadcast 把目标和场地证据告诉全组，公开讨论分工与由谁设计蓝图。设计者由协商推选（谁合适谁设计，不必是你）；你可以自荐或支持他人，自己也具备设计蓝图的能力。蓝图发布后按协商分工施工，任何成员都可以提议任务和交接范围。所有子任务完成且全组核验通过后，由你做最终验收（entry 职责，不是指挥权）。',
            '讨论用短消息。还没有施工任务而需要等队友时，先向玩家发一句单行进度，再单独调用 wait_for_user，reason 以【等队友】开头；有施工任务后用 wait_for_team。若被推选的同伴只能协调，请他提交方案，由你按商定方案发布。发布蓝图应单独调用。',
            '把已经约定的范围尽快登记为正式任务。整部件用 partIds，省略 scope；切分连续区域只填 scope.region，coordinateSpace 放在 scope 外。不要填空的 positions，也不要同时写 region 和 positions。先登记实际前序任务，再用其返回的 taskId 填 dependsOn；如果前序是你自建的范围，先完成并现场验收，再派依赖该支撑的任务。',
            '模型调用按工具提供的字段填写。派工和修改计划分别调用；wait_for_user、wait_for_team、finish 单独调用。'
        ].join('\n'),
        member: [
            '你是平等协作组成员。用 broadcast 或 send_message 与同伴讨论分工、推选蓝图设计者并表达意见；你同样具备设计蓝图的能力，被推选者用 design_blueprint 发布共享蓝图（发布者只负责设计，施工仍按协商分工）。按共享蓝图施工，可以把部分范围正式委托给相连成员，也可以接受同伴的委托。范围或顺序有异议时直接协商，不必等待指派。',
            '协调回合先用 send_message（recipient 填队友名）发送一条简短主张；若你被推选但当前未提供设计动作，把方案交给入口发布。发完或看到任务已排队后，单独调用 end_turn。正式领到委托后按 workScope 施工，有新的范围、顺序或让路问题时与同伴直接协商。'
        ].join('\n')
    },
    handoff: {
        entry: (source, target) => [
            '你负责共享蓝图和总验收。选一项适合中途接棒的连续工作，例如同一段墙的前后两段。只向 ' + source + ' 派发覆盖整段的一项任务，写明交接点、留给 ' + target + ' 的范围和续接时需核对的支撑。',
            '由首棒与接棒者直接提议、接受并正式交出剩余范围。用 wait_for_team 等原任务结算；接棒任务阻塞时与首棒核对证据，由首棒恢复原交接任务。交接及原任务均结束后核验全段，最后 finish。'
        ].join('\n'),
        source: target => [
            '你是首棒。按正式任务做到交接点，检查已完成部分和续接所需支撑。把蓝图版本、已完成位置和现场注意项写在给 ' + target + ' 的提案说明里。',
            '用 propose_task_share 向接棒者提出剩余范围，scope 只包含要交出的未完工格。用 wait_for_team 等回应。对方接受且可领工时，在施工动作之间调用 commit_task_share；交接成功后停止在转出范围施工。',
            '等待接棒者完工。若交接任务阻塞，向接棒者核对解除条件，确认恢复后用 reassign_task 派回同一任务。接力完成后核验原始完整范围，再 complete_task。'
        ].join('\n'),
        target: source => [
            '你是接棒者。收到 ' + source + ' 的协作提案时，用 list_tasks 查看 proposalId 和交接范围。能接则用 respond_task_share 接受，再 end_turn 等正式委托；有范围或支撑疑问直接回首棒。',
            '正式领取任务后抽查续接点和支撑，在自己的 workScope 内从断点继续。验收后用 complete_task 报告余下范围；无法续接时提供缺少的支撑或冲突坐标。'
        ].join('\n')
    },
    blackboard: {
        entry: (preparers, finisher) => [
            '你维护共享任务板上的施工依据。发布蓝图，派 ' + preparers.join('、') + ' 准备两个独立施工区的基础。任务写清区域、准备范围和可现场核验的标准。list_tasks 是共用板面，以正式状态、summary 和 evidence 判断就绪、阻塞或完工。',
            '哪个基础条目先验收完成且有证据，就给 ' + finisher + ' 派该区后续任务，描述引用准备条目的 taskId 和检查结论。结算当前任务后再派下一个就绪区。遇到阻塞先记录解除条件，让可推进区域继续，障碍解决后恢复原条目。',
            '要求成员在板上记录变化，消息只用来提醒关注具体条目。等各区准备、后续施工均有验收证据，再核验全场并 finish。'
        ].join('\n'),
        preparer: [
            '你负责分给你的基础准备条目。按正式任务范围施工并检查支撑及动线，在 complete_task 的 summary 写「区域｜关键坐标｜就绪依据」。如有障碍，用 blocked 在 reason 写清区域、坐标、现状和解除条件。',
            '队友需要跟进时，用 send_message 提醒查看相应任务 ID。以后续施工者能从 list_tasks 复核证据为准。'
        ].join('\n'),
        finisher: [
            '按共享任务板接续施工。领取委托时，用 list_tasks 对照该区准备任务，读已完成状态及验收依据，抽查现场支撑。证据齐全后再施工。',
            '用 complete_task 把「区域｜准备任务 ID｜后续施工验收结果」写进条目。若板上资料与现场不符，报告实测坐标和差异，让协调员按记录处理。'
        ].join('\n')
    },
    swarm: {
        entry: workers => [
            '你负责启动和全局验收。发布可分为相邻区段的共享蓝图，比如三段围栏。同一轮把初始区分别交给 ' + workers.join('、') + '，写明边界和通路，各区可立即开工。',
            '用 wait_for_team 等正式结果。边界、让路和局部分担交给相邻施工成员协商。遇到连线外或无法自行解除的阻塞再协调。所有区域及其转交子任务完成后做最终验收。'
        ].join('\n'),
        member: neighbors => [
            '你施工自己的初始区域。你的施工邻居是 ' + neighbors.join('、') + '。遇到边界冲突、让路或工作量不均，用 send_message 直接与相关邻居沟通，说明本地位置和可行帮助。',
            '本区现场验收完毕时，可发一条消息告诉邻居你即将空闲，再立即 complete_task。尚在施工的邻居可把相邻的一小段剩余 workScope 移交给你；正式交接前确认接收人已结算当前任务。用 propose_task_share、respond_task_share、commit_task_share 完成移交；接受后 end_turn，等正式任务开始施工。',
            '交接后各自只施工当前范围。已转出的子任务阻塞时，由发起者与接收者核对原因，确认解除后恢复原任务；子任务完工后再核验原范围。无协助需求时直接完成本区。'
        ].join('\n')
    },

    router: {
        entry: (router) => [
            '负责接收原始指令、观察现场、发布共享蓝图和最终验收。发布后核对自己的站位与蓝图世界边界、进出通路。若占用施工区或通路，先观察范围外有支撑且脚头空间畅通的站位，用 move_to 移过去。确认站位安全后，把未完工范围作为一个正式父任务交给 ' + router + '，写明要求和依赖。',
            '收到 ' + router + ' 转达的【让路】时，优先移到施工区和通路外。移动确认后立即用 send_message 回给 ' + router + '，开头写【已让路】，附原受阻的世界坐标和现在的位置。随后用 list_tasks 检查 Router 的父任务；该任务若为 blocked，用 reassign_task 把同一个任务 ID 恢复给 Router。无法安全移开时，回复实测限制。',
            '执行者的筛选和细分由 Router 完成。用 wait_for_team 等待 Router 汇总已验收的结果。若 Router 报告蓝图与现场冲突，观察具体坐标并如实说明阻塞。最终对照用户要求与现场证据完成项目。'
        ].join('\n'),
        router: lead => [
            '你专职路由。收到 Lead 的父任务后，读取共享蓝图、施工清单和成员状态，把父任务中尚未完成的格子按所需能力拆成明确范围。',
            '派工前对照当前站位、蓝图实际施工边界和 Builder 动线。若身处目标格、施工落脚点或进出通道，先观察边界外的安全站位（下方有支撑，脚和头有空间），用 move_to 自主移开。等待期间留在施工范围与进出路径之外。',
            '收到【让路】时核对挡路者和世界坐标。若是你挡路，观察可达的安全站位并 move_to；创造模式下也可用 fly_to 绕行，再在施工区外 land_at（需要时先 get_tool_help）。确认实际位置后回复【已让路】；若无法移动则告知限制。若是 ' + lead + ' 挡路，立即转发原任务 ID、Builder 名称和受阻坐标给 ' + lead + '，等待其确认。挡路者是其他相连成员时同样转达。',
            '收到【已让路】或你自行移开后，用 list_tasks 查原施工任务，并把已确认的位置和原受阻坐标发给对应 Builder。任务仍 running 时请它复查并继续；若已 blocked，用 reassign_task 恢复同一任务。若只在协调回合，消息发完后 end_turn，等领回父任务再恢复子任务。父任务恢复后沿用原子任务和依赖。',
            '每条「模型路由」关系的备注列出执行者所配模型，关系说明可补充模型擅长的任务或实测经验。选择时优先匹配明确的能力证据，再考虑在线、可领任务和场地条件。档案相同或能力未知时，用就绪状态、相关已验证结果和当前任务量分配，模型名本身不代表强弱。',
            '先按现场支撑和通路明确施工依赖，再决定何时派给谁。不同范围也可能互相提供支撑。例如金字塔顶层必须等待中间层，不能因为格子互不重叠就当作可独立开工。',
            '用 delegate_task 按依赖顺序先登记前序任务，拿到返回的 taskId 后，再给后序任务填写 dependsOn。填写实际任务 ID，而不是部件号或 Router 的父任务 ID。若前序还没登记、暂时无人可接，则先保留下游范围，等前序登记或现场已核验就绪再派。任务描述写清选派依据、范围和验收条件。独立任务可以并行，也可由同一位合适的执行者连续完成。',
            '派单后用 wait_for_team 等事件。前序验收完成时，若发现某个已领任务的执行者正等待这个支撑，立即用 send_message 直接通知该执行者前序已完成，请其复查支撑并继续。若任务已报告 blocked，确认障碍解除后用 reassign_task 恢复原任务；任务仍 running 时直接沟通，避免重复派单。',
            '用 list_tasks 查看已经转交的部件和子任务证据。子任务全完成后汇总各部分证据并调用 complete_task，由验收检查原委托完整范围。无人具备必要能力时向 Lead 说明缺口。'
        ].join('\n'),
        member: router => [
            '只在领到 ' + router + ' 的正式任务后施工。开工时用 inspect_part 确认分配范围、材料和坐标，再抽查关键支撑。支撑已就绪就执行范围内的放置建议，保留蓝图版本与精确材料 ID，施工后再复查。',
            '若 entity_in_way 指向自己，先移开；目标格或通路被队友占用时，向 ' + router + ' 发一次【让路】，把原任务 ID、挡路者和受阻世界坐标放在消息开头。先继续范围内其他安全工序；若因占位无法继续，用 blocked 记录同样的信息。',
            '收到【已让路】后，仍持有任务时复查原受阻格并继续施工。处于协调回合时用 end_turn 等正式重派。领回原任务后先检查实际缺失格，从保留的进度接着做。',
            '现场仍缺前序支撑时，把受阻坐标、所缺支撑和解除条件直接发给 ' + router + '，再用 blocked 报告，释放这项任务以便恢复。等待其他执行者的结果不能替代正式阻塞上报。',
            '完成后现场核验当前任务全部范围，再用 complete_task 回报结果和证据。'
        ].join('\n')
    },
    competitive: {
        entry: (candidates) => [
            '你是竞争评选的 Lead。更新整体计划并先观察场地。用 send_message 分别给 ' + candidates.join(' 和 ') +
            ' 发同一份【方案征集】，包含用户原始要求的关键约束、同一场地摘要和评选标准；整条征集尽量在 160 字内。先确认候选可接收协调消息。每位候选独立回复一次；不要向候选转发另一份提案。征集阶段先不设计或发布蓝图，也不派施工任务。',
            '根据团队消息的发送者识别提案。同一候选只收一份有效提案。两份到齐就自主评选。尚有缺案时，向用户简短报告进度，然后调用 wait_for_user，reason 以【等队友】开头。新提案会恢复本轮评选，先查看新回复，勿重复征集。用户真实需求有待确认时使用普通原因。',
            '用同一标准比较：先核对用户硬性要求，排除不符合者；再比较场地适配、支撑与通行风险，最后比较施工复杂度。选一个可行方案，不拼接候选方案。同等条件下优先施工更简单者；仍相同按征集顺序选。都不可行时说明缺口，向用户确认后再处理。',
            '把胜出者、采用的方案和选择理由记录到计划证据，并向用户说明。随后用 design_blueprint 将胜出方案转成符合原始要求的共享蓝图。蓝图发布后用 delegate_task 把全部未完成范围交给胜出者；其余候选不施工。',
            '等待胜出者完成施工，仅在其可恢复时重派给同一成员。胜出者无法继续时先告知用户，由用户决定下一步。最后按用户原始要求和现场证据验收，再用 finish 汇报。'
        ].join('\n'),
        member: (lead) => [
            '收到 ' + lead + ' 的【方案征集】时，在协调回合根据 TEAM_GOAL、征集中的补充要求和同一场地摘要独立提出一份建筑方案。只给 Lead 发一条【参赛方案】消息，不超过 160 字，包含布局或关键尺寸、材料、工序和主要风险，然后 end_turn。无法满足某个硬要求时直接说明，勿假定场地条件。',
            '只有在收到 Lead 发来的正式施工委托时，才按共享蓝图和任务范围实施胜出的方案。施工完成后核验现场并 complete_task 汇报。其他消息在协调回合处理，未获正式施工委托时不施工。'
        ].join('\n')
    },
    voting: {
        entry: (voters) => [
            '你主持 A/B 多数投票，自己不投票。更新整体计划并观察场地。选一个确实影响建筑、且用户尚未确定的决策，给出两个可行且符合用户硬性要求的备选。通过 send_message 向 ' + voters.join('、') +
            ' 分别发送同一份【征集投票#1】，写清 A、B 各代表什么、场地证据和相关用户约束；把关键内容放在前 160 字。不得在同一轮改变选项或转发其他人的票。确定结果前不发布蓝图或派工。',
            '只按团队消息的真实发送者计票。同一轮每位指定成员只计第一张有效 A/B 票，重复票、上一轮选票、弃权和无效回复不计。两票投同一选项即为多数，可直接采用该选项；不得用自己的偏好改票或决定胜负。',
            '尚无多数且仍缺回复时，先用 send_message 向玩家发一句单行进度，再单独调用 wait_for_user，reason 以【等队友】开头。征集投票期间尚无施工任务，wait_for_team 无法等到选票。新票会自动恢复本轮计票。按原轮次去重；若全员已回复却无多数，先说明原因，必要时用新轮次征集。',
            '把票数、胜出选项和设计依据记录在计划证据。发布蓝图前用 send_message 向玩家公布单行结果，含两边票数和采用的设计。例如【投票#1结果】A 得 3 票，B 得 0 票。采用 A，建砂岩三层金字塔并加金块塔尖。',
            '发给玩家的 text 只用一行；用句号或空格分隔要点。若工具报控制字符，先移除换行和制表符，再用一行简短结果重发。送出后单独调用 design_blueprint 落实胜出选项。几何格式错误时修正几何并保留投票选择；现场证实该选项不可实施时说明原因并重新表决。',
            '蓝图发布后先核对返回的 bounds，必要时用 inspect_blueprint 检查关键格子。确保胜出特征落实在实际蓝图里，并用现场观测确认最低施工层有支撑；若实际位置、支撑或票选特征不符，说明差异和现场证据，先暂停派工。核对通过后，用一次 delegate_task 把全部未完成施工范围交给一名就绪成员。派工前查 team.agents，只选 online=true 且 canAcceptTask=true 的成员；投票内容不影响施工资格。等待该成员完成，再结合原始要求和现场结果 finish。'
        ].join('\n'),
        member: (lead) => [
            '收到 ' + lead + ' 的【征集投票#N】时，对照 TEAM_GOAL、补充要求和题面中的现场证据独立判断。只向 Lead 私发一次「【投票#N】A｜一句理由」或「【投票#N】B｜一句理由」，编号沿用题面，回复不超过 100 字。send_message 用 recipient 填 Lead 名称，用 text 填选票；发送成功后直接 end_turn。若两案都违反硬性要求，回复「【投票#N】弃权｜原因」。',
            '只有收到 Lead 的正式施工委托后才按共享蓝图和任务范围施工。投了另一案也按最终蓝图执行，完成后现场核验并 complete_task。'
        ].join('\n')
    }
};
const NO_SHARE = ['propose_task_share', 'respond_task_share', 'commit_task_share'];
const NO_DELEGATE = ['design_blueprint', 'delegate_task', 'prepare_parallel_build'];
const COORDINATOR_PERMISSIONS = {
    whitelistOnly: true, blueprintAuthority: true, finishGate: true, allow: [
        'get_tool_help', 'send_message', 'list_peers', 'observe_environment', 'observe_cells', 'inspect_block',
        'look_at', 'move_to', 'fly_to', 'land_at', 'list_materials', 'design_blueprint', 'inspect_blueprint',
        'get_build_checklist', 'inspect_part', 'inspect_build', 'delegate_task', 'reassign_task', 'list_tasks'
    ]
};
function coordinator(instructions) {
    return { role: 'lead', permissions: { ...COORDINATOR_PERMISSIONS, allow: [...COORDINATOR_PERMISSIONS.allow] }, instructions };
}
function scopedBuilder(instructions, role = 'builder', canShare = false) {
    return { role, permissions: { deny: canShare ? [...NO_DELEGATE] : [...NO_DELEGATE, 'reassign_task', ...NO_SHARE] }, instructions };
}
function requireMembers(names, count, label) {
    if (!Array.isArray(names) || names.length !== count || new Set(names).size !== count ||
        names.some(name => typeof name !== 'string' || !name)) {
        throw new Error(label + '预设需要 ' + count + ' 位不同的成员');
    }
}
function teamSpec(entryAgent, agents, edges) {
    return { coordination: 'relationships', entryAgent, agents, edges };
}
function relation(from, to, label, description) {
    return { from, to, label, description };
}
function fullMesh(names, describe) {
    return names.flatMap((from, i) => names.slice(i + 1).map(to => describe(from, to)));
}
function centralizedPreset(names = ['lead', 'builder_1', 'builder_2']) {
    const [lead] = names;
    const instructions = PRESET_INSTRUCTIONS.centralized;
    const agents = Object.fromEntries(names.map(name => [name,
        name === lead ? { role: 'lead', instructions: instructions.entry }
            : { role: 'builder', instructions: instructions.member }
    ]));
    return teamSpec(lead, agents, fullMesh(names, (from, to) => from === lead
        ? relation(from, to, '派工与汇报', from + ' 结合现场为 ' + to + ' 分配任务，执行者核验本范围并回报。')
        : relation(from, to, '现场协调', from + ' 和 ' + to + ' 可直接商量让路、支撑与局部分担。')));
}
function debatingPreset(names = ['arch_1', 'arch_2', 'arch_3']) {
    const [entry] = names;
    const instructions = PRESET_INSTRUCTIONS.peers;
    const agents = Object.fromEntries(names.map(name => [name, {
        role: 'builder',
        permissions: name === entry
            ? { allow: ['*'], deny: [], blueprintAuthority: true, finishGate: true }
            : { deny: [], blueprintAuthority: true },
        instructions: name === entry ? instructions.entry : instructions.member
    }]));
    return teamSpec(entry, agents, fullMesh(names, (from, to) =>
        relation(from, to, '协商互助', `${from} 与 ${to} 平等协商，根据能力分担工作。需要帮助时说明范围，达成一致后登记任务或交接；避免重复施工。`)));
}
function pipelinePreset(names = ['lead', 'builder1', 'builder2', 'builder3']) {
    requireMembers(names, 4, '流水线');
    const [lead, ...stages] = names;
    const instructions = PRESET_INSTRUCTIONS.pipeline;
    return teamSpec(lead, {
        [lead]: coordinator(instructions.entry(stages)),
        ...Object.fromEntries(stages.map((name, i) => [name,
            scopedBuilder(instructions.stage(i, stages[i - 1], stages[i + 1]), 'stage_builder')]))
    }, [
        ...stages.map((name, i) => relation(lead, name, '第 ' + (i + 1) + ' 段委托',
            lead + ' 登记本段任务和前置任务 ID，' + name + ' 现场验收后正式结算。')),
        ...stages.slice(1).map((name, i) => relation(stages[i], name, '阶段交接',
            stages[i] + ' 直接说明现场验收结果和续接条件，' + name + ' 在任务依赖满足后正式开工。'))
    ]);
}
function parallelPreset(names = ['lead', 'builder_left', 'builder_right']) {
    requireMembers(names, 3, '并行');
    const [lead, ...workers] = names;
    const instructions = PRESET_INSTRUCTIONS.parallel;
    return teamSpec(lead, {
        [lead]: coordinator(instructions.entry(workers)),
        ...Object.fromEntries(workers.map(name => [name, scopedBuilder(instructions.member(lead), 'module_builder')]))
    }, workers.map(name => relation(lead, name, '独立模块', name + ' 收到委托即可独立完成本区，' + lead + ' 等所有模块完成后统一验收。')));
}
function handoffPreset(names = ['lead', 'builder_a', 'builder_b']) {
    requireMembers(names, 3, '接力交接');
    const [lead, source, target] = names;
    const instructions = PRESET_INSTRUCTIONS.handoff;
    return teamSpec(lead, {
        [lead]: coordinator(instructions.entry(source, target)),
        [source]: scopedBuilder(instructions.source(target), 'starter', true),
        [target]: scopedBuilder(instructions.target(source), 'receiver', true)
    }, [
        relation(lead, source, '首棒委托', lead + ' 委托整段施工并说明中途交接点，' + source + ' 完成接力后负责核验原任务。'),
        relation(source, target, '施工权交接', source + ' 提议交出指定剩余范围，' + target + ' 接受并收到正式任务后续接。')
    ]);
}
function blackboardPreset(names = ['lead', 'prep_a', 'prep_b', 'finisher']) {
    requireMembers(names, 4, '共享黑板');
    const [lead, first, second, finisher] = names;
    const preparers = [first, second];
    const instructions = PRESET_INSTRUCTIONS.blackboard;
    return teamSpec(lead, {
        [lead]: coordinator(instructions.entry(preparers, finisher)),
        [first]: scopedBuilder(instructions.preparer, 'preparer'),
        [second]: scopedBuilder(instructions.preparer, 'preparer'),
        [finisher]: scopedBuilder(instructions.finisher, 'finisher')
    }, [
        ...preparers.map(name => relation(lead, name, '记录准备状态',
            name + ' 把区域的就绪证据或阻塞原因写进任务板，' + lead + ' 查看板面决定后续工作。')),
        relation(lead, finisher, '依据记录派工', lead + ' 引用已就绪的准备记录派工，' + finisher + ' 复查该条目再施工并更新结果。')
    ]);
}
function swarmPreset(names = ['lead', 'builder_a', 'builder_b', 'builder_c']) {
    requireMembers(names, 4, '群体协作');
    const [lead, ...workers] = names;
    const instructions = PRESET_INSTRUCTIONS.swarm;
    return teamSpec(lead, {
        [lead]: coordinator(instructions.entry(workers)),
        ...Object.fromEntries(workers.map((name, i) => [name,
            scopedBuilder(instructions.member([workers[i - 1], workers[i + 1]].filter(Boolean)),
                'neighbor', true)]))
    }, [
        ...workers.map(name => relation(lead, name, '初始区域', lead + ' 交给 ' + name + ' 初始施工区，最后汇总验收。')),
        ...workers.slice(1).map((name, i) => relation(workers[i], name, '邻域互助',
            workers[i] + ' 与 ' + name + ' 直接协调共有边界，并可向已空闲邻居移交少量剩余工作。'))
    ]);
}


function routerPreset(names = ['lead', 'router', 'builder_1', 'builder_2']) {
    if (!Array.isArray(names) || names.length < 3 || new Set(names).size !== names.length ||
        names.some(name => typeof name !== 'string' || !name)) {
        throw new Error('模型路由预设需要独立的蓝图 Lead、Router 和至少一位执行者');
    }
    const [lead, router, ...workers] = names;
    const instructions = PRESET_INSTRUCTIONS.router;
    return {
        coordination: 'relationships',
        entryAgent: lead,
        agents: {
            [lead]: {
                role: 'lead',
                permissions: { allow: ['*'], deny: ['prepare_parallel_build'], blueprintAuthority: true, finishGate: true },
                instructions: instructions.entry(router)
            },
            [router]: {
                role: 'router',
                permissions: { whitelistOnly: true, allow: [
                    'get_tool_help', 'send_message', 'list_peers', 'list_tasks', 'get_build_checklist',
                    'inspect_part', 'inspect_blueprint', 'inspect_build', 'observe_environment', 'observe_cells', 'inspect_block',
                    'move_to', 'fly_to', 'land_at', 'delegate_task', 'reassign_task'
                ] },
                instructions: instructions.router(lead)
            },
            ...Object.fromEntries(workers.map(name => [name, {
                role: 'builder',
                permissions: { deny: ['design_blueprint', 'delegate_task', 'prepare_parallel_build', 'propose_task_share', 'respond_task_share', 'commit_task_share'] },
                instructions: instructions.member(router)
            }]))
        },
        edges: [
            { from: lead, to: router, label: '蓝图与路由委托', description: lead + ' 发布共享蓝图并把施工范围交给 ' + router + '；Router 根据执行者模型和任务要求选人、细分、派单，最后向 Lead 汇总。Builder 的让路请求由 Router 转达，收到确认后恢复原任务。' },
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
    const instructions = PRESET_INSTRUCTIONS.competitive;
    return {
        coordination: 'relationships',
        entryAgent: lead,
        agents: {
            [lead]: coordinator(instructions.entry(candidates)),
            ...Object.fromEntries(candidates.map(name => [name, {
                role: 'candidate',
                permissions: { deny: ['design_blueprint', 'delegate_task', 'prepare_parallel_build',
                    'propose_task_share', 'respond_task_share', 'commit_task_share'] },
                instructions: instructions.member(lead)
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
    const instructions = PRESET_INSTRUCTIONS.voting;
    return {
        coordination: 'relationships',
        entryAgent: lead,
        agents: {
            [lead]: coordinator(instructions.entry(voters)),
            ...Object.fromEntries(voters.map(name => [name, {
                role: 'voter',
                permissions: { deny: ['design_blueprint', 'delegate_task', 'prepare_parallel_build',
                    'propose_task_share', 'respond_task_share', 'commit_task_share'] },
                instructions: instructions.member(lead)
            }]))
        },
        edges: voters.map(voter => ({ from: lead, to: voter, label: '独立投票',
            description: lead + ' 发同一份 A/B 选项，' + voter + ' 独立回投一票。Lead 按多数票落实蓝图，再按施工需求派工。' }))
    };
}

export const TEAM_PRESETS = Object.freeze({
    pipeline: pipelinePreset,
    centralized: centralizedPreset,
    router: routerPreset,
    competitive: competitivePreset,
    parallel: parallelPreset,
    voting: votingPreset,
    peers: debatingPreset,
    handoff: handoffPreset,
    blackboard: blackboardPreset,
    swarm: swarmPreset
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
