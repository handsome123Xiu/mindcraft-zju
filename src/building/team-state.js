// Editable team definitions. Legacy standalone lease helpers use SQLite too;
// managed teams keep scoped tasks and leases in team-runtime.sqlite.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openTeamStore } from './team-store.js';
import { TOOL_SCHEMAS } from './action-protocol.js';
import { BLACKBOARD_TOOLS, blackboardPermission } from './blackboard.js';

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
        allow: ['get_tool_help', 'send_message', 'broadcast', 'list_peers', 'list_tasks', 'observe_environment', 'observe_cells',
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
    if (BLACKBOARD_TOOLS.has(toolName)) return {allowed:!!blackboardPermission(spec,agentName,toolName),role:spec?.agents?.[agentName]?.role??'custom'};
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

// A final inspection handoff grants observation and finish, never construction.
export function isReadOnlyFinisher(spec, name) {
    return !!spec?.agents?.[name] && capabilities(spec, name).finishGate &&
        !['design_blueprint', 'blueprint_blackboard', ...Object.keys(TOOL_SCHEMAS).filter(tool => /^(place|dig)_/.test(tool))]
            .some(tool => actionAllowed(spec, name, tool).allowed);
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
        if (entry?.taskAcceptanceTo != null && (spec.blueprintMode === 'independent' ||
            !names.includes(entry.taskAcceptanceTo) || !edgeAllows(spec, name, entry.taskAcceptanceTo) ||
            !capabilities(spec, name).canBuild || !isReadOnlyFinisher(spec, entry.taskAcceptanceTo))) {
            errors.push(name + ' 的 taskAcceptanceTo 必须经连线指向持全局验收权且无设计施工权限的验收成员');
        }
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
    if (spec?.modules?.blackboard != null && (typeof spec.modules.blackboard !== 'object' || typeof spec.modules.blackboard.enabled !== 'boolean')) errors.push('modules.blackboard.enabled 必须是布尔');
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
        // Shared resource access is independent of peer-message edges. Declaration
        // remains editable when disabled; availability is checked at execution.
        if (spec?.modules?.blackboard) {
            const readers=names.filter(name=>spec.agents[name].permissions?.allow?.includes('read_blackboard'));
            for (const a of readers) for (const b of readers) if(a!==b) adjacency.get(a).add(b);
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
        } else if (!actionAllowed(spec, entry, 'design_blueprint').allowed && !(spec.modules?.blackboard && spec.agents[entry].permissions?.allow?.includes('blueprint_blackboard'))) {
            errors.push('本版团队入口需要蓝图设计权限');
        }
        // 验收权独立于入口：固定流水线里验收由专门的验收成员执行。
        // 只要求团队里至少一人持有全局验收权限，不要求是入口。
        if (!names.some(name => capabilities(spec, name).finishGate)) errors.push('团队需要至少一名持有全局验收权限（finishGate）的成员');
    }
    return { ok: !errors.length, errors };
}

// ---- 预设模板：角色约定写进 agents[name].instructions，连线和权限单独配置 ----
const COMPETITION_BLOCK_LIMIT = 200; // 竞争择优：每位候选的方块数量上限（生成蓝图时硬校验）
const PRESET_INSTRUCTIONS = {
    pipeline: {
        entry: (stages, acceptor) => {
            const builders = stages.join(' → ');
            return [
                '你是流水线的蓝图设计者，不施工、不验收、不执行 finish。流程：' + builders + ' → ' + acceptor + '（验收）。观察场地，用 update_plan 制定设计与派工计划，再用 design_blueprint 发布共享蓝图。',
                '蓝图发布后，按流水线顺序 delegate_task 登记各施工段：每位施工成员一段（整部件用 partIds，切分连续区域用 scope.region）。运行时依据 taskAfter 自动接续施工依赖，无需手动填 dependsOn。你不向 ' + acceptor + ' 派工或发消息；末段 ' + stages.at(-1) + ' 的 complete_task 成功后，运行时依据 taskAcceptanceTo 正式创建覆盖全场的验收任务。派工描述写清本段范围、前序支撑及验收条件，核对各段合计覆盖全部施工目标。',
                '登记完成后 wait_for_team，不给后续阶段放行。施工段 complete_task 自动接续，末段把工程交给验收成员。验收问题由末段施工成员转达；只对与你直连的 blocked/queued 施工任务使用 reassign_task，已完成范围需要返工则登记新的明确施工任务，不能重派 completed。验收任务由末段成员负责恢复，不跨连线派工或通信。工程由验收成员 finish 结束。',
                '恢复已有工程时，先查看已登记任务和现场进度，沿用现版蓝图和原任务，不要重复设计或重复派单。'
            ].join('\n');
        },
        stage: (index, previous, next, acceptor) => {
            const recipient = next ?? acceptor;
            const predecessor = previous ? '上游是 ' + previous + '。' : '你是首段，没有上游依赖。';
            return [
                '你负责流水线第 ' + (index + 1) + ' 段施工。' + predecessor + '本段交付对象是 ' + recipient + '。在正式施工任务中，team.assignment.id 表示你已领取任务，依赖已经满足；用 update_plan 制定本段步骤（每步含 id、title、success），核对现场后直接施工。',
                '工序以运行时的 dependsOn 和任务领取为准。前序 complete_task 会自动结算并交付。协调回合尚未领取施工任务时，收到阶段消息就直接 end_turn，让客户端自动领取可开工任务；聊天中的"等待放行"不增加开工条件。已领取任务后按本段 workScope 连续施工。',
                '若上游交付状态是 blocked，这不是完成交付。把上游任务 ID 和具体阻塞原因向设计者转达一次，然后 end_turn；由设计者恢复原任务，自己继续等依赖，不轮询、不提前施工。',
                '用 inspect_part 查看自己 workScope 的实际差异、材料和坐标，以已发布蓝图为准。有 suggestions.actions 就直接执行，保留原样 block、坐标、partId、assignmentVersion；否则按 differences 的缺失格和精确材料放置，先建有支撑的格。施工后复查，工具报错按具体错误调整。',
                '遇到 entity_in_way 时读取工具给出的 blockers 名称和坐标，向实际挡路者请求一次移动到其工地外待命点；跨连线由相邻成员转达。对同一障碍只发一次请求，收到移动结果或观察到位置改变再重试。有 missing_reference 时核对相邻支撑；真正受阻时用 blocked 提交具体障碍。已有 inspect_part 建议且现场条件满足时，下一步直接执行建议。',
                '本段完工后，先移到蓝图完整 bounds 外至少 3 格的安全待命点，再现场核验并 complete_task，让出后续施工区域。',
                '现场自检全部通过后，用 update_plan 标记本段步骤 done 并附证据，然后 complete_task。summary 写清蓝图版本、完成部件、现场 remaining=0、支撑与边界及下一步注意事项。运行时会把这份结果直接交给 ' + recipient + '。' +
                    (next ? '你在此结束本段，下游依赖自动解除，由 ' + next + ' 接续施工。' : '这是最后一段施工：complete_task 成功时自动创建全场验收任务，正式交给 ' + acceptor + '，不必额外 delegate_task 或请设计者放行。若之后收到验收差异，把具体坐标与原因转达给设计者安排返工；list_tasks 确认返工任务完成且现场问题已解决后，使用 reassign_task 恢复自己派给验收成员的原验收任务，不重复创建验收任务。')
            ].join('\n');
        },
        acceptor: previous => [
            '你是流水线的只读验收成员，持有全局验收权限（finishGate）。你不施工、不派工。末段 ' + previous + ' complete_task 成功后，运行时为你创建覆盖全部部件且依赖所有施工任务完成的正式验收任务。领取后立即验收，不等待设计者放行，也不与设计者直接通信。',
            '领取验收任务后，用 update_plan 建立验收计划（每步含 id、title、success），然后 inspect_build 对全场逐格核验（差异多时用 inspect_part / get_build_checklist 分页查看）。',
            '发现差异时不要自行修复：用 send_message 向 ' + previous + ' 报告具体差异坐标、期望与实际方块，再用 blocked 提交验收任务并写明原因。由末段成员转达设计者安排返工，返工完成后由末段成员正式重派原验收任务。你只与相连成员直接通信。',
            '零差异时：update_plan 把验收步骤标 done 并附现场证据，然后直接执行 finish。finish 的 requirementReview 按原始要求逐条填写 requirementId、satisfied=true 和 evidence；summary 写清蓝图版本、全场 remaining=0 与验收结论。finish 会现场再次核验并自动结算你的验收任务、结束整个工程。不要用 complete_task 代替 finish——那只是提交任务，工程仍会停留在待验收状态。'
        ].join('\n')
    },
    centralized: {
        entry: [
            '你是团队派工中心，负责共享蓝图、整体调度和最终验收。先观察场地并制定整体计划，再设计共享蓝图。结合实际支撑、动线、工作量和成员状态分工；独立范围可并行，有真实支撑依赖的任务不能仅凭文字提前开工。小型分层建筑可把同一人的连续上层与装饰合成一项任务，减少无效交接。',
            '每项委托的 description、success、partIds 与 scope 必须一致，success 只验收本任务实际拥有的范围。按完整部件分工时可只传准确的 partIds；若指定 region，必须核对它包含所有要交付的格子，不能让描述包含 scope 外的金块或后续层。不得用“先到者为准”解决重叠，也不能通过聊天授权范围外施工。',
            '真实依赖必须登记 dependsOn：先单独调用 delegate_task 取得前置 taskId，再用该 ID 派发后续任务；不能在同批尚未取得 ID 时凭任务 key 或一句“等对方完成”替代。只有独立任务才合批。下层完成提供支撑后，运行时才应让上层任务被领取。',
            '发现自己派出的任务 blocked，优先看最新 inspect/任务结果与成员状态，明确故障是缺支撑、实体挡路还是 unreachable/server_correction。先改变站位、移动恢复条件或选择 online=true 且 canAcceptTask=true 的替代成员，再 reassign_task 重派原 taskId。相同位置和做法已重复失败时，不盲目重派给原人。只重派 blocked/queued 任务，不重复新建相同范围；有正在执行且能推进的独立任务时让它继续。',
            '同伴消息是线索，不覆盖较新的现场事实。对矛盾报告核对具体坐标、方块和 observedAt；执行者自己的 checklist 看不到别人负责的部件，不代表那部分不存在。聊天允许商量让路，正式施工权仍来自任务与租约。存在未处理的 blocked 时不要因为另一个任务标 running 就 wait_for_team，它可能在等阻塞任务提供支撑。只有确有可推进任务且无需你先恢复时才等事件；用户主动暂停的成员需用户恢复。',
            '全部正式任务完成后，按原始要求 inspect_build 核验全场。零差异后将已由证据证明的验收步骤标 done，再单独 finish 并填写 requirementReview；finish 是最终提交动作，不是验收步骤 done 的前置条件。'
        ].join('\n'),
        member: [
            '你承接中心正式分配的施工。收到委托先读取 workScope 与当前蓝图，计划和验收仅覆盖你的正式范围。自己的 checklist 只列本范围；其他部件没列出不代表蓝图缺失，也不是你需要等待的额外任务。描述若包含范围外要求，向 Lead 说明并以正式范围为准，不把别人的金块或后续层纳入自己的完成条件。',
            '先 inspect_part 获取缺失格与合法建议，再按支撑顺序施工。正式委托已持有并自动续约租约，不反复 claim_part。真实前置任务应由 Lead 登记 dependsOn；缺少支撑时观察具体坐标并报告依赖，不能靠不断读取自己的 checklist 等别人的部件出现。',
            '放置 unreachable 或飞行 server_correction 时，先核对实际位置和清晰、有支撑的站位，换接近方向、尝试 land_at/move_to 后再重试；不是重复相同矩形或只改计划标题。两次改变方法仍失败就用 blocked 报告坐标、实际方块、实际位置、动作与原因，让 Lead 正式恢复或重派。报告必须与最新观测一致，不把“第三层未建”写成“第二层未建”。',
            '需要同伴让路时，用 send_message 说明你实际受阻的坐标和所需动作。收到请求必须真正执行移动并核对位置后再报告已让开，不能只发承诺。局部分担用 propose_task_share，经对方 respond_task_share 接受后再 commit_task_share；只有正式登记转移后的范围才可施工。空闲协调接受后 end_turn 等正式任务。',
            '本范围与协作者范围完工后，现场核验原委托范围，所有已满足的计划步骤标 done，再单独 complete_task 向派工人交付，附范围、版本和零差异证据。complete_task 是之后的提交动作，不是计划验收步骤 done 的前置条件；不等范围外任务完成。最后移出施工区待命。'
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
            '你是平等协作组成员之一，也是对外接单入口。先公开原始目标、场地证据和必要约束，与全组协商设计者、施工范围和先后关系。设计者由协商推选，你可以参与设计和施工；最终总体验收是 entry 的职责，不代表你有单方面决定分工的指挥权。设计应符合用户要求，未要求规模时优先提出便于验证的合理规模，避免自行扩大工程。',
            '协商要收敛：只在提出新方案、反对意见、确认尚未确定的分工或提供新现场事实时发消息。已有一致意见就登记任务并执行。对“收到、已确认、无需回复、保持待命”等无新增信息的消息不回确认，不重复宣布“最后一条”。没有新问题就不要发消息。',
            '把共同确认的分工登记成正式任务。整部件用 partIds 并省略 scope；局部区域用 scope.region，coordinateSpace 放在 scope 外。先登记支撑或前序任务，再把返回的实际 taskId 填到后续任务 dependsOn。不能只在 description 或聊天里说“等底层完成”；相同成员连续完成多个有依赖的工序也要登记依赖。独立工作无需增加依赖。',
            '任务 blocked 后先读具体原因，再协商一次可执行的恢复办法。移动失败要核对当前脚部和头部净空、路径与服务端纠正，换有现场依据的站位或执行者；支撑未建好则先恢复前序。由原委托者用 reassign_task 恢复原任务，聊天承诺不会重派任务，也不能解除租约。running 任务不能直接重派，先读其真实状态；你承担总体工程时不要把子任务重派给自己，除非运行时明确允许领取。不能解除时向用户说明事实，保留现场。',
            '每次发言不必等待所有人再确认。尚未派工而需等待实质提案时，向玩家说明一次进度，再单独 wait_for_user，reason 以【等队友】开头；派工后使用 wait_for_team 等任务事件。若同伴只能协调，由其交方案给你发布。所有正式任务完成后现场验收，补全计划证据并 finish，不重开协商。',
            '工具按当前提供的名称和字段调用；未提供时先用 get_tool_help 确认和加载，不猜 broadcast、claim_part 或 list_peers 是否可用。send_message 的 recipient 必须是实际队友或玩家名。send_message 成功后先读取结果，下一轮再单独调用 wait_for_user、wait_for_team 或 finish，绝不能与这些结束动作放在同一响应。'
        ].join('\n'),
        member: [
            '你是平等协作组成员。对照原始目标与现场证据，独立提出方案、推选设计者并协商分工；不同意时说明具体理由与替代方案。由协商选定的成员设计共享蓝图；若本回合没有设计工具，提交方案给入口发布。发布者不是施工指挥者，你可与相连同伴直接讨论，并正式委托自己持有范围内的工作。',
            '只在有新方案、未解决的分歧、范围变更、实际交付或新的阻塞证据时发一条简短消息。收到“确认、收到、无需回复、等待中”且没有新问题时直接 end_turn；不要回复确认，不重复宣布静默或询问相同进度。已达共识就执行正式任务，不继续征求批准。',
            '协调回合尚无施工任务时不建施工计划、不施工。需要贡献时先单独 send_message，读取发送成功结果后，下一轮只调用 end_turn；没有新信息时直接单独 end_turn。绝不能在同一响应中同时调用 send_message 和 end_turn，也不能调用当前未提供的 wait_for_team 等动作。',
            '领到正式任务后按 workScope 连续施工，后续工序的 dependsOn 由运行时控制领取。支撑缺失或前序 blocked 时，向原委托者一次说明前序任务 ID、缺失坐标和可行建议；不要越界补队友范围，不用聊天代替正式依赖，不反复查同一空气格。已领取任务若确实无法推进，报告具体阻塞并保留现场。',
            '需要让路时说明实际受阻位置与需要腾出的区域；收到请求后实际移动并核对位置，再报告结果。移动被 server_correction 拒绝后，不重复同一路线或移动进已有方块，选择已观察的净空与替代路径；若另一个成员有可行站位，提出正式重派建议。只说“我马上施工”不算进展。',
            '自己范围完成后以 inspect_part 或 inspect_build 的实际结果补全计划，再单独 complete_task；未完成前不要报完成。后续实际交付或阻塞变化发生时再通知相关成员，没有新事实就结束协调回合等待事件。'
        ].join('\n')
    },
    handoff: {
        entry: members => [
            '你是接力协作的入口，也是全队平等的一员。收到用户目标后，用 update_plan 制定计划，用 design_blueprint 发布共享蓝图。之后用 list_peers 查看同伴的状态与专长，自主选择第一位接棒成员并向他说明选择理由（也可亲自施工，但入口建议保持空闲以便最终验收）。',
            '用 delegate_task 把整体任务正式交给选定的成员，描述写清目标、蓝图版本与验收条件，然后 wait_for_team。后续每一步交接都由持任务的成员自主决定下一棒，不由你指挥；只有 blocked 或超时未领取时才核对原因，用 reassign_task 恢复原任务。',
            '接力链上的验收任务若由末棒直接 finish，工程即告完成。否则等全部任务 terminal 后，你做最终验收：inspect_build 全场核验，零差异且计划全部 done 后 finish，requirementReview 按原始要求逐条填写 satisfied 和 evidence。'
        ].join('\n'),
        member: (peers, entryName) => [
            '你是接力成员，拥有完整的设计、施工、派发与验收权限。领到任务后用 update_plan 拆分本范围步骤。先判断剩余工作是否值得接力：工作量小就亲自完成；需要接力时，用 list_peers 查看同伴状态，用 send_message 简短协商后自主选择下一棒——不能选 ' + entryName + '（入口保持空闲）、不能选你的上游派发者或正在执行任务的成员，也不能选已完成过本范围任务的成员（避免成环）。',
            '用 delegate_task 把下一棒的 scope 正式交出：范围必须在你的 workScope 内、与其他在途任务不重叠，描述写清本段目标、蓝图版本与验收条件。交出后 wait_for_team 等待结果，子任务 blocked 时核对原因，用 reassign_task 重派原任务。',
            '子任务完成后抽查交付质量（inspect_part 对照蓝图）。你的自留部分与全部子任务都 terminal 后，用 update_plan 标记 done 并附证据，再 complete_task 向上游交付：summary 写清蓝图版本、完成范围、现场 remaining=0 与交接注意事项。',
            '你可能是末棒（无人可接或工作已近完成）：自留部分施工后用 inspect_build 全场核验。有差异就地修复（你有全部施工权限）或用 blocked 上报具体坐标；零差异时用 update_plan 标 done 附证据，然后直接 finish——你有全局验收权，finish 会自动结算你的任务并结束整个工程，不需要回到上游或入口。'
        ].join('\n')
    },
    blackboard: {
        designer: (name, first, focus) => [
            '你是共享蓝图设计师 '+name+'，重点关注'+focus+'，同时有权修改整份草稿。与同伴没有私信连线，业务信息只读写黑板。先 read_blackboard；需要具体几何时指定 currentDraft.id，按 draft.nextOffset 分页读完 shapes，不能仅凭摘要通过审查。条目有 nextOffset 时继续翻页，审查记录可用 prefix 精确查询。',
            name===first ? '你本人负责首版草稿。currentDraft=null 时，在读取目标及必要场地依据后，立即单独调用 blueprint_blackboard(operation=draft,brief=设计要求与现场依据)。不等派工，不等其他人起草，不重复读取空黑板。' : '你不负责首稿。currentDraft=null 时，有新现场依据才写一次黑板；否则立即 wait_for_blackboard，不能反复读取空板。首稿出现后主动按自己的职责审查或修订。',
            '你的审查是独立判断，不需要等其他设计师先批准。读完本版 shapes 后，下一步提交自己的审查或发起具体修订；不要反复查看别人的审查代替自己的工作。审查用简短 JSON 字符串，包含 draftId、approve、evidence 或 issues，通常 100–300 字即可。若本版已有你自己有效的审查且无新问题，直接 wait_for_blackboard。',
            '黑板还没有草稿时，仅 '+first+' 用 blueprint_blackboard(operation=draft,brief=原始需求与场地依据) 生成初稿，其他人发布必要观察后 wait_for_blackboard。已有草稿时逐项检查原始目标、支撑、范围和材质；需要修改就用 revise(baseDraftId,brief) 生成修订版，版本冲突先读最新版再决定，不盲目重试。',
            '审查意见写在 review/草稿ID/'+name+'，content 写清 draftId、approve=true 或具体未解决问题及证据。更新自己的同版审查时 expectedRevision 填该条目当前版本；不是全局版本。每次改稿旧审查不再用于新稿。确认为本版无未解决问题才批准；所有设计师都确认同版由 Builder 自主接续，系统不会替你计票、定稿或派工。重复同样意见不算进展。',
            '看到 publishedDraftId 与当前草稿相同且无 revisionRequest 时直接 end_turn，后续黑板变化会唤醒你。Builder 提交 revisionRequest 后，读取问题和 protected 保留约束，按 protected.nextOffset 分页查阅；基于已发布草稿修订，保留所有已建坐标与方块。无法同时满足保留约束和原始要求时写明冲突并等用户，不擅自拆改。',
            '设计回合只调用观察、黑板与草稿工具，不施工、不 publish、不 finish。完成本轮贡献后 wait_for_blackboard 或 end_turn；没有新事实不反复改写条目。'
        ].join('\n'),
        builder: designers => [
            '你是工程接单与唯一施工成员。收到目标先 update_plan 记录用户原始要求和施工验收步骤，观察必要场地，read_blackboard 查看共享设计。你不生成或修改草稿，不私聊设计师。需要补充现场依据或用户追加要求就 write_blackboard，随后 wait_for_blackboard 等设计。',
            '设计成员为 '+designers.join('、')+'。指定 currentDraft.id，按 draft.nextOffset 分页读完具体 shapes，再用 prefix=review/当前草稿ID/ 查询本版审查，条目 nextOffset 不为空就继续翻页。每位成员的审查必须真实 author 对应本人、content.draftId 对应同一 currentDraft.id、明确批准且无未解决问题，才 blueprint_blackboard(operation=publish,draftId)。设计共识由你按 Profile 检查，工具不强制人数。发布指定草稿，不调用原 design_blueprint 重新生成。',
            '发布成功后按原有 inspect_part 建议、施工工具与计划独立建造，必要时认领部件租约，施工顺序和移动问题自行处理。若必须改设计，用 blueprint_blackboard(operation=request_revision,brief=具体坐标/预期/现状/失败原因) 保存已建部分并暂停施工；然后 wait_for_blackboard。所有设计师确认新版后 publish 该草稿继续原工程，不重建世界，不拆除已锁定部分。',
            '施工顺序：inspect_part 得到实际缺失坐标与建议后，claim_part 认领该部件；返回 claimed 后下一步直接执行对应放置建议，不等待别人的开工信号，不重复认领同一部件、不反复取同一份清单。若放置提示缺少租约，认领一次后立即重试刚才的放置。租约由心跳自动续期，重复 claim 不是施工进展。',
            '收尾顺序：remainingCells=0 后用 inspect_build 全场核验一次；返回 completed、verified=total 且零差异后，把已由现场证据证明的步骤（包括最后的验收步骤）用 update_plan(patch=true) 标 done。finish 是之后单独提交的动作，不应成为验收步骤尚未 done 的前置条件。全部步骤 done 后，下一步立即单独调用 finish，summary 说明成果，requirementReview 按原始要求逐条填写 satisfied 与 evidence；不要再反复 inspect_build、认领或等设计师。实际仍有未满足要求就先处理，不凭蓝图一致宣称全部完成。存在 revisionRequest 时不得结束或继续放置。模块关闭时明确报告需要启用或调整配置。'
        ].join('\n')
    },
    swarm: {
        entry: members => [
            '你是群体并行协作的传令成员：收到用户目标后，不设计、不发布共享蓝图、不自己施工。先用单独一轮 update_plan 登记原始要求。然后逐个调用 delegate_site：每次决策只发一个动作，为 ' + members.join('、') + ' 依次划独立工地（水平投影互不重叠，origin 落在各自工地内，工地大小按任务估算并给支撑和通行留空间），一次 delegate_site 一轮，不要把多个 delegate_site 合进 batch——长嵌套批量输出容易括号出错。原始任务由工具原样交给每位成员——不要在委托里指定建筑形状、位置或材料，选址和设计完全由成员自己决定。',
            '分地后 wait_for_team。各成员会自行设计蓝图、自行搭建、自行验收；边界与让路由成员之间直接协商，你不指挥。所有工地完工后运行时会汇总各处蓝图，你收到汇总后 inspect_build 对照原始要求逐座核验。',
            '核验零差异且计划全部 done 后 finish，requirementReview 按原始要求逐条填写 satisfied 和 evidence。若有成员 blocked，核对原因后用 reassign_task 恢复原任务。'
        ].join('\n'),
        member: () => [
            '你是群体并行协作的成员，拥有完整的设计、施工与验收权限。领到工地委托后立即独立开工，无需等待他人——各工地之间没有依赖。读取 team.assignment.site 的世界坐标 region 和 origin，自己观察场地、自己决定在本工地内搭什么、搭在哪里、用什么材料。',
            '用 update_plan 制定本建筑计划，然后调用 design_blueprint 发布你自己的独立蓝图：设计原点必须是工地 origin，蓝图相对坐标基于该原点，所有方块与预留空位都必须落在本工地范围内。',
            '发布后用 inspect_part 对照自己的蓝图施工到 remaining=0。需要同伴让路或配合时用 send_message 直接协商；你只在本工地内施工。',
            '你独立决定自己何时停止：本建筑现场验收完毕即停，先移出施工区，再 complete_task 提交附证据的结果；summary 写清自己的设计要点、完成范围与 remaining=0。停止时机由你自己判断，不需要请示任何人。若发现场地条件无法满足原始要求，用 blocked 报告具体坐标和原因。'
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
// 无 lead 流水线：设计 → 施工（可多段）→ 验收。入口只负责设计与派单，
// 全局验收权（finishGate）由末位的验收成员持有，验收通过后由它执行 finish。
const DESIGNER_PERMISSIONS = {
    whitelistOnly: true, finishGate: false, allow: [
        'get_tool_help', 'send_message', 'broadcast', 'list_peers', 'observe_environment', 'observe_cells',
        'inspect_block', 'look_at', 'move_to', 'fly_to', 'land_at', 'list_materials',
        'design_blueprint', 'inspect_blueprint', 'delegate_task', 'reassign_task', 'list_tasks'
    ]
};
const ACCEPTOR_PERMISSIONS = {
    whitelistOnly: true, finishGate: true, allow: [
        'get_tool_help', 'send_message', 'broadcast', 'list_peers', 'list_tasks', 'observe_environment', 'observe_cells',
        'inspect_block', 'look_at', 'move_to', 'fly_to', 'land_at', 'list_materials',
        'inspect_blueprint', 'get_build_checklist', 'inspect_part', 'inspect_build',
    ]
};
function pipelinePreset(names = ['designer', 'builder', 'acceptor']) {
    if (!Array.isArray(names) || names.length < 3 || new Set(names).size !== names.length ||
        names.some(name => typeof name !== 'string' || !name)) {
        throw new Error('流水线预设需要设计者、至少一位施工成员和验收成员（共 ≥3 位不同成员）');
    }
    const [designer, ...stages] = names;
    const acceptor = stages.pop();
    const instructions = PRESET_INSTRUCTIONS.pipeline;
    return teamSpec(designer, {
        [designer]: { role: 'designer',
            permissions: { ...DESIGNER_PERMISSIONS, allow: [...DESIGNER_PERMISSIONS.allow] },
            instructions: instructions.entry(stages, acceptor) },
        ...Object.fromEntries(stages.map((name, i) => {
            const node = scopedBuilder(instructions.stage(i, stages[i - 1], stages[i + 1], acceptor), 'builder');
            if (i === stages.length - 1) node.permissions.deny = node.permissions.deny.filter(tool => tool !== 'reassign_task');
            return [name, { ...node, taskReportTo: stages[i + 1] ?? acceptor,
                ...(i === stages.length - 1 ? { taskAcceptanceTo: acceptor } : {}),
                ...(stages[i - 1] ? { taskAfter: stages[i - 1] } : {}) }];
        })),
        [acceptor]: { role: 'acceptor',
            permissions: { ...ACCEPTOR_PERMISSIONS, allow: [...ACCEPTOR_PERMISSIONS.allow] },
            instructions: instructions.acceptor(stages.at(-1)),
            taskAfter: stages.at(-1) }
    }, [
        ...stages.map((name, i) => relation(designer, name, '设计交底与派单',
            designer + ' 发布共享蓝图并为 ' + name + ' 登记本段施工范围与依赖；' + name + ' 领取任务即按蓝图施工，完成后通过 complete_task 交给 ' + (stages[i + 1] ?? acceptor) + '。')),
        ...stages.slice(1).map((name, i) => relation(stages[i], name, '阶段交接',
            stages[i] + ' 用 complete_task 交付现场验收结果与续接条件，运行时直接通知 ' + name + ' 并解除下一段依赖；' + name + ' 自动领取任务，核对现场后开工。')),
        relation(stages.at(-1), acceptor, '完工送验',
            stages.at(-1) + ' 完成最后一段施工后 complete_task，运行时正式创建覆盖全场的验收任务并交给 ' + acceptor + '；' + acceptor + ' 自动领取验收任务。'),

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
// 接力协作：全员全权限、全连接，无预设顺序。每一步交接由持任务的成员
// 自主选择下一棒；末棒直接 finish（全员 finishGate），入口保持空闲兜底验收。
const RELAY_PERMISSIONS = { allow: ['*'], deny: [], finishGate: true };
function handoffPreset(names = ['entry', 'relay_1', 'relay_2', 'relay_3']) {
    if (!Array.isArray(names) || names.length < 3 || names.length > 5 || new Set(names).size !== names.length ||
        names.some(name => typeof name !== 'string' || !name)) {
        throw new Error('接力协作预设需要 3–5 位不同成员（入口加至少两位接力成员）');
    }
    const [entry, ...members] = names;
    const instructions = PRESET_INSTRUCTIONS.handoff;
    return teamSpec(entry, {
        [entry]: { role: 'relay', permissions: { ...RELAY_PERMISSIONS }, instructions: instructions.entry(members) },
        ...Object.fromEntries(members.map(name => [name,
            { role: 'relay', permissions: { ...RELAY_PERMISSIONS },
                instructions: instructions.member(members.filter(peer => peer !== name), entry) }]))
    }, fullMesh(names, (from, to) => relation(from, to, '平等接力',
        from + ' 与 ' + to + ' 平等接力：任意一方完成当前步骤后，可自主决定把剩余范围的下一步交给对方或其他成员；交接必须用 delegate_task 正式登记，消息不转移施工权。')));
}
function blackboardPreset(names = ['designer1','designer2','designer3','designer4','designer5','builder']) {
    if (!Array.isArray(names) || names.length < 3 || new Set(names).size !== names.length || names.some(name=>typeof name!=='string'||!name)) {
        throw new Error('共享黑板需要至少两位设计成员和一位施工入口');
    }
    const designers=names.slice(0,-1), builder=names.at(-1);
    const instructions=PRESET_INSTRUCTIONS.blackboard;
    const shared=['get_tool_help','read_blackboard','write_blackboard','wait_for_blackboard','blueprint_blackboard',
        'observe_environment','observe_cells','inspect_block','list_materials','move_to','fly_to','land_at'];
    const focuses=['整体布局与比例','结构与可施工性','材料与层次','功能和细节点缀','原始要求与边界核验'];
    const spec=teamSpec(builder,{
        ...Object.fromEntries(designers.map((name,i)=>[name,{role:'board_designer',
            permissions:{whitelistOnly:true,allow:[...shared],finishGate:false},
            instructions:instructions.designer(name,designers[0],focuses[i%focuses.length])}])),
        [builder]:{role:'board_builder',permissions:{allow:['*',...shared],deny:['design_blueprint','delegate_task','delegate_site','broadcast'],finishGate:true},
            instructions:instructions.builder(designers)}
    },[]);
    return {...spec,modules:{blackboard:{enabled:true}}};
}
// 群体并行：独立蓝图模式。传令成员只划工地和汇总验收，不设计不施工；
// 每位成员在自己的工地内自主选址、自主设计、自主搭建、自主决定停止。
const SWARM_PERMISSIONS = { allow: ['*'], deny: [], finishGate: true };
function swarmPreset(names = ['entry', 'builder_1', 'builder_2', 'builder_3']) {
    if (!Array.isArray(names) || names.length < 3 || names.length > 5 || new Set(names).size !== names.length ||
        names.some(name => typeof name !== 'string' || !name)) {
        throw new Error('群体协作预设需要 3–5 位不同成员（传令成员加至少两位独立施工成员）');
    }
    const [entry, ...workers] = names;
    const instructions = PRESET_INSTRUCTIONS.swarm;
    // 传令成员不需要自己设计施工；只保留派地、观察、恢复与验收能力。
    const dispatcher = { role: 'swarm',
        permissions: { whitelistOnly: true, finishGate: true, allow: [
            'get_tool_help', 'send_message', 'broadcast', 'list_peers', 'list_tasks', 'reassign_task',
            'observe_environment', 'observe_cells', 'inspect_block', 'look_at', 'move_to', 'fly_to', 'land_at',
            'list_materials', 'inspect_blueprint', 'get_build_checklist', 'inspect_part', 'inspect_build',
            'delegate_site'
        ] },
        instructions: instructions.entry(workers) };
    return {
        ...teamSpec(entry, {
            [entry]: dispatcher,
            ...Object.fromEntries(workers.map(name => [name,
                { role: 'swarm', permissions: { ...SWARM_PERMISSIONS }, instructions: instructions.member() }]))
        }, fullMesh(names, (from, to) => relation(from, to, '平等并行',
            from + ' 与 ' + to + ' 平行独立施工，直接协调边界与让路；各自独立决定设计与完工时机，协作一律用正式委托登记。'))),
        blueprintMode: 'independent'
    };
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
