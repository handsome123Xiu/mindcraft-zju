// Editable team definitions. Legacy standalone lease helpers use SQLite too;
// managed teams keep scoped tasks and leases in team-runtime.sqlite.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openTeamStore } from './team-store.js';
import { TOOL_SCHEMAS } from './action-protocol.js';

export const ROLE_PERMISSIONS = Object.freeze({
    lead: {
        // 设计、派单、全局验收；也可以下场施工。
        allow: ['*'],
        deny: [],
        finishGate: true
    },
    builder: {
        allow: ['*'],
        deny: ['design_blueprint'],
        finishGate: false
    },
    inspector: {
        allow: ['get_tool_help', 'send_message', 'broadcast', 'list_peers', 'observe_environment', 'observe_cells',
            'inspect_block', 'look_at', 'inspect_build', 'get_build_checklist', 'inspect_part',
            'inspect_blueprint', 'list_materials', 'claim_part', 'release_part', 'query_claims',
            'move_to', 'fly_to', 'land_at'],
        deny: [],
        whitelistOnly: true,
        finishGate: false
    }
});

export function roleOf(spec, agentName) {
    const entry = spec?.agents?.[agentName];
    // 自定义角色：内联 permissions 优先于内置角色表。名字自由，权限锚定能力。
    if (entry?.permissions) {
        const permissions = { ...entry.permissions };
        delete permissions.blueprintAuthority; // 旧配置遗留位：蓝图能力以 design_blueprint 工具权限为准
        return { name: entry.role ?? 'custom', ...ROLE_PERMISSIONS.builder, ...permissions };
    }
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
        canDelegate: actionAllowed(spec, agentName, spec?.blueprintMode === 'independent' ? 'delegate_site' : 'delegate_task').allowed,
        finishGate: role.finishGate === true };
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
            else if (!Object.hasOwn(ROLE_PERMISSIONS, entry.role) && entry.permissions == null) errors.push(name + ' 使用自定义角色 ' + entry.role + '，必须提供 permissions（allow/deny/whitelistOnly/finishGate）');
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
                for (const key of ['finishGate']) if (p[key] != null && typeof p[key] !== 'boolean') errors.push(name + ' 的 permissions.' + key + ' 必须是布尔');
            }
        }
        if (entry?.profile != null && (typeof entry.profile !== 'string' || !entry.profile.endsWith('.json'))) errors.push(name + ' 的 profile 必须为 JSON 文件路径');
        if (entry?.position != null && (!Number.isFinite(entry.position.x) || !Number.isFinite(entry.position.y))) errors.push(name + ' 的画布坐标无效');
        if (entry?.taskReportTo != null && (!names.includes(entry.taskReportTo) ||
            !Array.isArray(spec.edges ?? []) || !edgeAllows(spec, name, entry.taskReportTo))) errors.push(name + ' 的 taskReportTo 必须指向有连线的其他成员');
        if (entry?.taskAfter != null && (!names.includes(entry.taskAfter) ||
            !Array.isArray(spec.edges ?? []) || !edgeAllows(spec, name, entry.taskAfter))) errors.push(name + ' 的 taskAfter 必须指向有连线的前序成员');
        const predecessors = new Set([name]);
        let previous = entry?.taskAfter;
        while (previous && names.includes(previous)) {
            if (predecessors.has(previous)) { errors.push(name + ' 的 taskAfter 存在依赖环'); break; }
            predecessors.add(previous);
            previous = spec.agents[previous]?.taskAfter;
        }
        if (entry?.instructions != null && (typeof entry.instructions !== 'string' || entry.instructions.length > 2000)) errors.push(name + ' 的职责说明无效');
    }
    if (spec?.blueprintMode != null && spec.blueprintMode !== 'independent') errors.push('未知 blueprintMode');
    if (spec?.blockLimit != null && (!Number.isInteger(spec.blockLimit) || spec.blockLimit < 1 || spec.blockLimit > 2000000)) errors.push('blockLimit 必须是 1–2000000 的整数');
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
        if (spec.blueprintMode === 'independent') {
            if (names.length < 2 || !actionAllowed(spec, entry, 'delegate_site').allowed) errors.push('独立蓝图模式需要派工入口和至少一名执行者');
            for (const name of names.filter(name => name !== entry)) {
                const caps = capabilities(spec, name);
                if (!edgeAllows(spec, entry, name) || !caps.canBuild || !actionAllowed(spec, name, 'design_blueprint').allowed) {
                    errors.push(name + ' 需要与入口直连且具有独立设计和施工权限');
                }
            }
        } else if (!actionAllowed(spec, entry, 'design_blueprint').allowed) {
            errors.push('本版团队入口需要蓝图设计权限');
        }
        if (!capabilities(spec, entry).finishGate) errors.push('本版团队入口需要全局验收权限');
    }
    return { ok: !errors.length, errors };
}

// ---- 预设模板：角色约定写进 agents[name].instructions，连线和权限单独配置 ----
const COMPETITION_BLOCK_LIMIT = 200; // 竞争择优：每位候选的方块数量上限（生成蓝图时硬校验）
const PRESET_INSTRUCTIONS = {
    pipeline: {
        entry: stages => [
            '你负责固定施工流水线：' + stages.join(' → ') + '。观察场地，用 design_blueprint 发布共享蓝图，将建筑按实际工序切成与成员数相同的连续阶段。各阶段范围互不重叠，前序留下的支撑或边界应能现场核验。派工前移到工地与通道外。',
            '发布蓝图后，先观察蓝图 bounds 外至少 3 格的安全待命点，为每名 Builder 指定互不占用的位置。用 send_message 各发送一次【工地待命】，写明完整建筑边界和本人的待命点；成员确认到位后再派工。准备期间用 wait_for_user，reason 以【等队友】开头，收到到位确认后继续。待命成员停留在工地外。',
            '按流水线顺序一次性为所有阶段调用 delegate_task，整部件用 partIds，切分连续区域用 scope.region。运行时会依据每名成员的 taskAfter 自动添加上一段任务依赖；若显式填写 dependsOn，用实际返回的 taskId。登记后核对整条链。描述写清本段范围、前序支撑及验收条件。前序 complete_task 结算后，下一段自动领取并施工。',
            '恢复已有工程时，先查看已登记任务和现场进度，沿用现版蓝图和原任务。全部登记后 wait_for_team。阶段交接由 Builder 的 complete_task 自动送给其 taskReportTo，接收方自动领取已登记的下一段。中间阶段正常交付无需你放行；收到具体阻塞求助时核对原因，只对 blocked 原任务用 reassign_task 恢复，不能重派已 completed 的阶段。',
            '收到末段完成交付后，单独 inspect_build 复检全场。若零差异且全部子任务 completed，单独 update_plan 把剩余步骤标 done 并写现场证据；下一动作单独 finish，requirementReview 按原始要求填写 requirementId、satisfied=true 和 evidence。finish 会再次现场核验。已有零差异证据且全部计划 done 时直接 finish，不重复 inspect_build 或改写同一份 done 计划。'
        ].join('\n'),
        stage: (index, previous, next, lead) => {
            const recipient = next ?? lead;
            const predecessor = previous ? '上游是 ' + previous + '。' : '你是首段，没有上游依赖。';
            return [
                '你负责流水线第 ' + (index + 1) + ' 段。' + predecessor + '本段交付对象是 ' + recipient + '。在正式施工任务中，team.assignment.id 表示你已领取任务，依赖已经满足；用 update_plan 制定本段步骤（每步含 id、title、success），核对现场后直接施工。',
                '收到【工地待命】时，观察指定位置的安全空间，用 fly_to 或 move_to 移到建筑边界外的本人待命点；向发送者确认一次到位后直接 end_turn。后续待命期间保持原位。工序以运行时的 dependsOn 和任务领取为准。前序 complete_task 会自动结算并交付。协调回合尚未领取施工任务时，收到阶段消息就直接 end_turn，让客户端自动领取可开工任务；聊天中的“等待放行”不增加开工条件。已领取任务后按本段 workScope 连续施工。',
                '若上游交付状态是 blocked，这不是完成交付。把上游任务 ID 和具体阻塞原因向 ' + lead + ' 转达一次，然后 end_turn；由入口恢复原任务，自己继续等依赖，不轮询、不提前施工。',
                '用 inspect_part 查看自己 workScope 的实际差异、材料和坐标，以已发布蓝图为准。有 suggestions.actions 就直接执行，保留原样 block、坐标、partId、assignmentVersion；否则按 differences 的缺失格和精确材料放置，先建有支撑的格。施工后复查，工具报错按具体错误调整。',
                '遇到 entity_in_way 时读取工具给出的 blockers 名称和坐标，向实际挡路者请求一次移动到其工地外待命点；跨连线由相邻成员转达。对同一障碍只发一次请求，收到移动结果或观察到位置改变再重试。有 missing_reference 时核对相邻支撑；真正受阻时用 blocked 提交具体障碍。已有 inspect_part 建议且现场条件满足时，下一步直接执行建议。',
                '本段完工后，先移到蓝图完整 bounds 外至少 3 格的安全待命点，再现场核验并 complete_task，让出后续施工区域。',
                '现场自检全部通过后，用 update_plan 标记本段步骤 done 并附证据，然后 complete_task。summary 写清蓝图版本、完成部件、现场 remaining=0、支撑与边界及下一步注意事项。运行时会把这份结果直接交给 ' + recipient + '。' +
                    (next ? '你在此结束本段，下游依赖自动解除，由 ' + next + ' 接续施工。' : '这是整条流水线的最后交付，由 ' + lead + ' 对全场进行最终检查。')
            ].join('\n');
        }
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
            '你负责划分工地、派工和整体验收。先按原始任务做派工与验收计划，观察能支撑建筑的场地，为 ' + workers.join('、') + ' 分别划出可独立完成完整任务的工地。每块工地的水平投影互不重叠，并给支撑、开口和通行留下空间。若用户限制的位置容不下全部建筑，向用户确认。',
            '用 delegate_site 给每名 Builder 登记一次绝对世界坐标 region 和施工 origin。origin 的 Y 是建筑第一层的位置。工地大小按用户要求估算。不要指定建筑形状、材质或内部做法，原始任务由工具原样交给每位 Builder。三项委托都登记后 wait_for_team。',
            '一个工地受阻时让其他分支继续。用 list_tasks 检查并按需向原执行者 reassign_task。三份建筑完工后会收到汇总验收清单。调用 inspect_build 核对全部现场方块，逐座对照原始要求，检查工地位置与完成情况，再更新计划和验收记录并执行 finish。'
        ].join('\n'),
        member: lead => [
            '你的委托包含完整原始建筑任务及独立工地。读取 team.assignment.site 的世界坐标 region 和 origin，核对自己的地面支撑与空间，用 update_plan 制定本建筑的计划。你可以自行选择原始要求允许的造型、结构和材料，无需等 Lead 决定设计。',
            '调用 design_blueprint 发布自己的蓝图。设计原点是委托的 origin，所有建筑方块与有意保留的空位都要落在本工地。发布后通过 inspect_part 和施工工具完成本建筑。与别的工地没有工序依赖。',
            '验收自己整座建筑，标记计划完成，再用 complete_task 向 ' + lead + ' 提交建筑特征和现场证据。若发现边界或支撑条件无法满足原始要求，报告具体坐标和原因。'
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
        entry: [
            '你负责模型路由和整体验收。收到用户目标后，先观察场地（observe_environment 指定世界坐标 region）并评估需要的能力：材料风格、结构类型、尺寸，以及是否涉及装饰或景观。',
            '每条「模型路由」关系的说明写明对应 Builder 的专长（提示词 profile）。对照用户要求选出能力最匹配的一位 Builder，只把整项任务交给这一位；其余 Builder 不施工。若要求同时涉及多种能力，优先选覆盖核心要求最多的一位，不要拆分给多人。',
            '用 delegate_site 给选中的 Builder 登记一次绝对世界坐标 region 和施工 origin。origin 的 Y 是建筑第一层的位置。工地大小按用户要求估算，不要指定建筑形状、材质或内部做法，原始任务由工具原样交给该 Builder。',
            '派工前核对站位，若占用工地或通路，先移到范围外再派工。派工后用 wait_for_team 等事件；该 Builder 会自行设计蓝图并施工，蓝图与建造完全由它负责。',
            '完工后调用 inspect_build 核对现场，对照原始要求验收整项结果，再更新计划并执行 finish。若现场条件无法满足，报告具体坐标和原因。'
        ].join('\n'),
        builder: (router, specialty) => [
            '你的委托包含完整原始建筑任务及独立工地。读取 team.assignment.site 的世界坐标 region 和 origin，核对自己的地面支撑与空间，用 update_plan 制定本建筑的计划。',
            specialty,
            '调用 design_blueprint 发布自己的蓝图。设计原点是委托的 origin，所有建筑方块与有意保留的空位都要落在本工地。发布后通过 inspect_part 和施工工具完成本建筑。',
            '验收自己整座建筑，标记计划完成，再用 complete_task 向 ' + router + ' 提交建筑特征和现场证据。若发现边界或支撑条件无法满足原始要求，报告具体坐标和原因。'
        ].join('\n')
    },
    competitive: {
        entry: (candidates) => [
            '你是竞争择优的 Lead。更新整体计划并观察场地。用 delegate_site 给 ' + candidates.join(' 和 ') + ' 各划一块独立工地：两块工地水平并列、面积相近，origin 分别落在各自工地内，工地大小按用户要求估算。把同一份用户原始要求原样交给两位候选，不指定建筑形状、材质或内部做法。',
            '派工前核对站位，若占用工地或通路，先移到范围外再派工。派工后用 wait_for_team 等事件；两位候选会各自独立设计蓝图并在本工地施工。你全程不设计、不发布蓝图，也不生成共享蓝图或追加施工委托。',
            '两位候选都完成施工后，用 inspect_build 分别核对两处现场，再按同一套标准逐项评分：统一 4 项各 5 分（满分 20）——①硬性要求符合度（结构/尺寸/功能是否满足用户原始要求）②美观与比例 ③材料搭配与层次 ④支撑稳固与方量效率。先给两位候选逐项打分并算出各自总分，把每项分数和总分都记录到计划证据，作为下面比较结论的依据。',
            '比较必须给出明确胜负。胜出者即总分高者，用 send_message 向玩家真正发出结论（recipient 留空即默认发给玩家；不能只把结论写进计划证据或 finish 就跳过发送）。text 只用一行，且必须以「胜出者：」开头：先写胜出者与双方总分对比，再写一句比较理由和一处现场证据。例：胜出者 candidate_a（17 分 > 15 分），理由：比例更经典、三色层次分明；证据：两处 inspect_build 均 0 差异。不要用换行或制表符；若工具报「控制字符」，删掉换行和制表符后用更短一行重发。只有 send_message 反复失败时，才退而把同一句「胜出者：…」结论写进 finish 的 summary，且 summary 仍须以胜负结论开头，不能只罗列双方做了什么。',
            '若一处未完成或明显不符要求，说明具体差异后仍须按可比较的评分给出结论，或向用户报告缺口。最后按用户原始要求整体验收，再调用 finish 汇报（summary 同样只用一行、以胜负结论开头）。'
        ].join('\n'),
        member: (lead) => [
            '你是在独立工地参赛的候选。收到 ' + lead + ' 的工地委托后，读取 team.assignment.site 的世界坐标 region 和 origin，核对自己的地面支撑与空间，用 update_plan 制定本建筑的方案。',
            '本次竞争限制：本建筑最多使用 ' + COMPETITION_BLOCK_LIMIT + ' 个方块。调用 design_blueprint 发布蓝图时必须把方块数控制在该上限内，超出会直接报错，请缩小设计后再发。',
            '设计原点是委托的 origin，所有建筑方块与有意保留的空位都要落在本工地。发布蓝图后通过 inspect_part 和施工工具完成本建筑。',
            '核验自己整座建筑，标记计划完成，再用 complete_task 向 ' + lead + ' 提交建筑特征和现场证据。若发现边界或支撑条件无法满足原始要求，报告具体坐标和原因。'
        ].join('\n')
    },
    voting: {
        entry: (voters) => [
            '你主持 A/B 多数投票，自己不投票。更新整体计划并观察场地。选一个确实影响建筑、且用户尚未确定的决策，给出两个可行且符合用户硬性要求的备选。通过 send_message 向 ' + voters.join('、') +
            ' 分别发送同一份【征集投票#1】，写清 A、B 各代表什么、场地证据和相关用户约束；把关键内容放在前 160 字。不得在同一轮改变选项或转发其他人的票。确定结果前不发布蓝图或派工。',
            '只按团队消息的真实发送者计票。同一轮每位指定成员只计第一张有效 A/B 票，重复票、上一轮选票、弃权和无效回复不计。比较两案各自的有效票数，票数多的一侧胜出并优先采用；不得用自己的偏好改票或决定胜负。',
            '尚有成员未回复时，先用 send_message 向玩家发一句单行进度，再单独调用 wait_for_user，reason 以【等队友】开头，例：「【等队友】正在等 7 名成员回投 A/B」。征集投票期间尚无施工任务，wait_for_team 无法等到选票；新票会自动唤醒本轮。若 wait_for_user 报「请先用 send_message 回复」，说明刚有新票到账：先读票计票，再发一句最新进度并重发 wait_for_user。全员已回复就立即计票并公布结果，不要继续空等；若两案票数持平（平票），先说明原因，必要时用新轮次征集。',
            '把票数、胜出选项和设计依据记录在计划证据。发布蓝图前用 send_message 向玩家公布单行结果，含两边票数和采用的设计。例如【投票#1结果】A 得 5 票，B 得 2 票。采用 A，建砂岩三层金字塔并加金块塔尖。',
            '发给玩家的 text 只用一行；用句号或空格分隔要点。若工具报控制字符，先移除换行和制表符，再用一行简短结果重发。公布结果后，下一个动作必须单独调用 design_blueprint（skill）落实胜出选项，不要再反复 update_plan 复述已公布的结果。args.brief 写清胜出设计的尺寸、材质与层级，args.origin 用已观察到的施工原点。几何格式错误时修正几何并保留投票选择；现场证实该选项不可实施时说明原因并重新表决。',
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
    whitelistOnly: true, finishGate: true, allow: [
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
            ? { allow: ['*'], deny: [], finishGate: true }
            : { deny: [] },
        instructions: name === entry ? instructions.entry : instructions.member
    }]));
    return teamSpec(entry, agents, fullMesh(names, (from, to) =>
        relation(from, to, '协商互助', `${from} 与 ${to} 平等协商，根据能力分担工作。需要帮助时说明范围，达成一致后登记任务或交接；避免重复施工。`)));
}
function pipelinePreset(names = ['lead', 'builder1', 'builder2', 'builder3']) {
    if (!Array.isArray(names) || names.length < 3 || new Set(names).size !== names.length ||
        names.some(name => typeof name !== 'string' || !name)) {
        throw new Error('流水线预设需要至少一位 lead 和两位 builder（共 ≥3 位不同成员）');
    }
    const [lead, ...stages] = names;
    const instructions = PRESET_INSTRUCTIONS.pipeline;
    return teamSpec(lead, {
        [lead]: coordinator(instructions.entry(stages)),
        ...Object.fromEntries(stages.map((name, i) => [name,
            { ...scopedBuilder(instructions.stage(i, stages[i - 1], stages[i + 1], lead), 'stage_builder'),
                taskReportTo: stages[i + 1] ?? lead, ...(stages[i - 1] ? { taskAfter: stages[i - 1] } : {}) }]))
    }, [
        ...stages.map((name, i) => relation(lead, name, '第 ' + (i + 1) + ' 段委托',
            lead + ' 在开工前一次性登记本段范围与依赖。' + name + ' 领取任务即按前序成果施工，完成后通过 complete_task 交给 ' + (stages[i + 1] ?? lead) + '。')),
        ...stages.slice(1).map((name, i) => relation(stages[i], name, '阶段交接',
            stages[i] + ' 用 complete_task 交付现场验收结果与续接条件，运行时直接通知 ' + name + ' 并解除下一段依赖；' + name + ' 自动领取任务，核对现场后开工。'))
    ]);
}
function parallelPreset(names = ['lead', 'builder1', 'builder2', 'builder3']) {
    requireMembers(names, 4, '并行');
    const [lead, ...workers] = names;
    const instructions = PRESET_INSTRUCTIONS.parallel;
    const entry = coordinator(instructions.entry(workers));
    entry.permissions.allow = entry.permissions.allow.filter(name => !['design_blueprint', 'delegate_task'].includes(name));
    entry.permissions.allow.push('delegate_site');
    return {
        ...teamSpec(lead, {
            [lead]: entry,
            ...Object.fromEntries(workers.map(name => [name, {
                role: 'module_builder',
                permissions: { deny: [
                    'delegate_site', 'delegate_task', 'prepare_parallel_build', 'reassign_task', ...NO_SHARE
                ] },
                instructions: instructions.member(lead)
            }]))
        }, workers.map(name => relation(lead, name, '工地委托与验收',
            lead + ' 划定工地和基准点。' + name + ' 独立设计、施工并提交整座建筑，' + lead + ' 统一验收。'))),
        blueprintMode: 'independent'
    };
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


const ROUTER_BUILDERS = [
    { specialty: '你的专长是石材与砖类建筑：圆石、石砖、红砖、砂岩等砌体材料，擅长城墙、塔楼、石砌房屋等稳固的砖石结构。',
      summary: '石材与砖类（圆石、石砖、红砖、砂岩）砌体结构，如城墙、塔楼、石屋' },
    { specialty: '你的专长是木质建筑：橡木、云杉、白桦等原木与木板材料，擅长木屋、农舍、木桥等木质结构。',
      summary: '木质（橡木、云杉、白桦）结构，如木屋、农舍、木桥' },
    { specialty: '你的专长是现代材料与装饰：玻璃、混凝土、石英、羊毛与照明，擅长现代建筑、室内装饰和灯光布置。',
      summary: '现代材料与装饰（玻璃、混凝土、石英、羊毛、照明），如现代建筑、室内装潢' },
    { specialty: '你的专长是景观与综合：路径、庭院、园林与混合材料，擅长庭院铺装、绿化和小品等室外环境。',
      summary: '景观与综合（路径、庭院、园林、混合材料），如庭园、铺装、绿化' }
];

function routerPreset(names = ['router', 'builder_1', 'builder_2', 'builder_3', 'builder_4']) {
    requireMembers(names, 5, '模型路由');
    const [router, ...builders] = names;
    const instructions = PRESET_INSTRUCTIONS.router;
    return {
        ...teamSpec(router, {
            [router]: {
                role: 'router',
                permissions: { whitelistOnly: true, finishGate: true, allow: [
                    'get_tool_help', 'send_message', 'list_peers', 'list_tasks', 'reassign_task',
                    'observe_environment', 'observe_cells', 'inspect_block', 'look_at', 'move_to', 'fly_to', 'land_at',
                    'list_materials', 'inspect_blueprint', 'get_build_checklist', 'inspect_part', 'inspect_build',
                    'delegate_site'
                ] },
                instructions: instructions.entry
            },
            ...Object.fromEntries(builders.map((name, i) => [name, {
                role: 'builder',
                permissions: { deny: ['delegate_site', 'delegate_task', 'prepare_parallel_build', 'reassign_task', ...NO_SHARE] },
                instructions: instructions.builder(router, ROUTER_BUILDERS[i].specialty)
            }]))
        }, builders.map((name, i) => relation(router, name, '模型路由',
            router + ' 根据用户要求匹配 ' + name + ' 的专长，选中后把整项任务交给它独立设计并施工；未选中者不施工。' + name + ' 的专长：' + ROUTER_BUILDERS[i].summary))),
        blueprintMode: 'independent'
    };
}

function competitivePreset(names = ['lead', 'candidate_a', 'candidate_b']) {
    requireMembers(names, 3, '竞争择优');
    const [lead, ...candidates] = names;
    const instructions = PRESET_INSTRUCTIONS.competitive;
    const entry = coordinator(instructions.entry(candidates));
    entry.permissions.allow = entry.permissions.allow.filter(name => !['design_blueprint', 'delegate_task'].includes(name));
    entry.permissions.allow.push('delegate_site');
    return {
        ...teamSpec(lead, {
            [lead]: entry,
            ...Object.fromEntries(candidates.map(name => [name, {
                role: 'candidate',
                permissions: { deny: [
                    'delegate_site', 'delegate_task', 'prepare_parallel_build', 'reassign_task', ...NO_SHARE
                ] },
                instructions: instructions.member(lead)
            }]))
        }, candidates.map(candidate => relation(lead, candidate, '竞争工地与择优',
            lead + ' 划出独立工地并给出统一方量限制。' + candidate + ' 在本工地独立设计并施工，完成后 ' + lead + ' 现场检查并评选更优者。'))),
        blueprintMode: 'independent',
        blockLimit: COMPETITION_BLOCK_LIMIT
    };
}

function votingPreset(names = ['lead', 'voter_1', 'voter_2', 'voter_3', 'voter_4', 'voter_5', 'voter_6', 'voter_7']) {
    if (!Array.isArray(names) || names.length !== 8 || new Set(names).size !== 8 ||
        names.some(name => typeof name !== 'string' || !name)) {
        throw new Error('多数投票预设需要一位 Lead 和七位不同的投票者');
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
