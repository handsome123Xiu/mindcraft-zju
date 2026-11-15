# 自定义协作范式（后端开放）+ Minecraft 像素风控制台改版

## Context

用户要在画布上自由发明角色与协作结构。当前被三层硬编码卡住：前端两个 3 项下拉框（index.html:161-172）、后端角色枚举校验（team-state.js:53）、边类型枚举（:65）。原则（前轮讨论已定）：**单一全能 agent + 权限数据 + 提示词分工**；不引入类继承；语义基底只有 delegate/report/message 三种（各绑运行时真实机制），自定义连线=语义基底+自由标签；系统只锚定两个能力位 blueprintAuthority/finishGate；租约/逐格授权等安全机制不看角色。预设保持现有 3 个不新增。

## 后端

### 1. `src/building/team-state.js` — 开放数据模型

- **自定义角色**：`roleOf()`（:33）优先读 `spec.agents[name].permissions`（内联），否则查 `ROLE_PERMISSIONS[role]`。结构：`{allow?, deny?, whitelistOnly?, blueprintAuthority?, finishGate?}`。内置三角色照旧。
- **新增 `capabilities(spec, name)` 辅助**：`{ canBuild, canDelegate, blueprintAuthority, finishGate }`，供 runtime/supervisor/前端共用。
- **validateTeamSpec 放宽**：
  - :53 角色名自由（`/^[a-z0-9_-]{1,20}$/`），不在内置表时必须带内联 permissions，并校验其结构（allow/deny 是数组成员为已知工具名或 `*`）
  - 边：`{from, to, kind, label?, note?}`，kind ∈ 三语义基底，label ≤20 字符自由文本；**兼容旧 `type` 字段**（kind ?? type）
  - :68-70 delegate 起点：从"role 是 lead/builder"改为 `canDelegate`（有 delegate_tool 权限）
  - :108-111 唯一性校验锚定能力：lead-gates ⇔ 恰 1 个 `finishGate:true`；lead-assigns/spatial-parallel ⇔ 恰 1 个 `blueprintAuthority:true`
- TEAM_PRESETS 保持现有 3 个不变

### 2. `src/building/team-runtime.js` — 语义兼容

- `edgeAllows`（:15）：`edge.kind ?? edge.type` 匹配
- 5 处 inspector/builder 角色名判断（:154 :303 :329-330 :366 :513）→ `capabilities().canBuild / canDelegate`
- 自定义边的 label/note 无需运行时改动（decision-context 已把完整 spec.edges 传入 lead 上下文，模型自动读到）

### 3. `console/team-supervisor.js`

- :29 入口校验：从"必须是 lead"改为"必须有 blueprintAuthority"（用 capabilities）

### 4. `console/server.js`

- 无新端点。`/api/catalog` 已返回全部工具名（前端权限矩阵数据源）。GET `/api/team` 返回的 validation 文案随新校验自动生效。

## 前端 `console/index.html` — 像素风改版 + 自由编辑

### CSS 系统重做（替换 :7-47 全部样式 + 抽出内联 style）

- **MC 暗色洞穴风设计 token**（CSS 变量）：底 `#131313` 黑曜石、面板 `#1e1b18` 泥土暗棕、边框 `#3f3a34` 3px 实线、文字 `#e8e2d5` 羊皮纸白、强调草地绿 `#6a9838` / 金 `#f8af2b` / 钻石 `#4aedd9` / 红石 `#ff5a5a`；全部 `border-radius:0` 方角
- **MC 按钮**：石质灰 `#6d6d6d`、双色 3px 边框（亮上左/暗下右）、inset 硬阴影、hover 绿字金边、active 位移 2px——经典 MC 按钮复刻
- 字体 `"Lucida Console","Courier New",monospace` + bold + 标题全大写 + `image-rendering:pixelated`
- 画布背景：16px 草方块网格（CSS repeating-gradient 两色交错淡纹理）
- toast 改 MC 成就弹窗样式（右上滑入、金边黑底）；信息块加 MC 物品栏 tooltip 样式（紫边黑底）

### 画布节点 — MC 像素头像

- 节点头像改 8×8 像素脸（SVG rect 网格，非 circle）：lead=Steve 脸（棕肤蓝眼黑发）、builder=村民脸（棕袍长鼻）、inspector=末影人脸（黑底紫眼）、自定义角色=默认紫水晶脸+可配色
- 名牌：节点下方半透明黑底白字（MC 玩家名牌样式）；运行时状态副标签沿用（runtimeAgents 覆盖）
- 边：像素化粗虚线 + 方块箭头 marker；颜色按语义基底（delegate 蓝/report 绿/message 灰），label 显示 `edge.label ?? 语义默认名`（去掉 :428 硬编码映射）
- 图例动态化：按当前画布实际使用的 kind/label 生成（去 :145-150 硬编码）
- EDGE_COLORS/roleColor/responsibility 三处硬编码（:365 :455 :480）改为「语义基底色 + 角色色板（内置角色固定色 + 自定义角色按名字 hash 取 8 色板）」；responsibility 从内联 permissions 摘要生成（如"观察·汇报"）

### 编辑面板（替换 :159-190）

- **角色编辑**：`#roleSelect` 改"combobox"（datalist：内置 3 + 已用自定义名 + 输入任意名）；输入非内置名时展开**权限矩阵面板**：按组折叠的 checkbox（观察/移动/施工/团队/查询，工具清单从 /api/catalog 拉取）+ 三个开关（blueprintAuthority 蓝图权威 / finishGate 全局验收 / whitelistOnly 仅白名单）+ 头像配色选择
- **连线编辑**：`#edgeTypeSelect` 改语义基底 3 选（带"决定实际功能"说明）+ label 自由输入 + note
- 预设区保持现有 2 按钮 + 中心化示例，不新增
- 操作流保持：预设起底 → 画布拖拽微调 → 点选编辑 → Ctrl+S/校验保存 → 启动；JSON 编辑器保留为高级出口（双向同步逻辑 :615-655 不动）

## 兼容性

- 旧 team.json `edges[].type` 继续可用（kind ?? type）；内置角色名照旧解析；`spatial-parallel` 前端迁移逻辑保留
- 现有 3 preset 键名不变（旧调用方不破）

## 测试与验证

- `scripts/test-team-actions.mjs` 新增：内联 permissions 合法/非法校验、自由角色名、能力锚定（无 finishGate 时 lead-gates 报错、有则过）
- `scripts/test-team-runtime.mjs`：kind 边 edgeAllows、自定义"军师"角色（canBuild=false）被 delegate 拒收、capabilities 驱动的接管候选过滤
- 手动验证清单：`npm run console` → 载入中心化示例 → 自定义角色"军师"（权限矩阵勾选）→ 自定义连线"师徒"（message 基底+标签）→ 保存后 GET /api/team 校验通过；offline 团队冒烟走现有 test:team
- 全量 `npm test`（team-runtime 已知 Windows flake 按既有归因处理）

## 文件清单

| 文件 | 改动量 |
|---|---|
| `src/building/team-state.js` | 中：permissions 内联、capabilities、校验放宽 |
| `src/building/team-runtime.js` | 小：edgeAllows kind 兼容、5 处角色判断改 capabilities |
| `console/team-supervisor.js` | 极小：入口校验一行 |
| `console/index.html` | 大：CSS 全换 + 权限矩阵/连线编辑 + 像素节点渲染（数据流与交互骨架保留） |
| `scripts/test-team-actions.mjs` / `test-team-runtime.mjs` | 追加用例 |
