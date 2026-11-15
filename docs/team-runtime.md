# 团队运行时：自然语言关系

## 当前唯一配置格式

控制台和运行时仅接受 `coordination: "relationships"`：连线只有两个端点与 `description`，不选择派单、上报、通信类型。连线是双向协作通道；from/to 只是端点标识，主从、平等或先后顺序由用户的关系说明表达。关系说明原文进入双方的模型指令，不做关键词分类，也不自动增加工具权限。其他成员的关系仍可从团队上下文查看。

使用方法：运行 `npm run console`，打开“团队工坊”，载入示例或添加伙伴。拖动头像调整位置，按住 Shift 拖动连接成员；点击连线写关系说明，点击头像在右侧配置权限。内置角色和自定义角色均可编辑权限，改角色名不改变权限。“中心化 / 平等协商 / 层级协作”只填充关系和连线，不修改现有权限。保存后选择“保存并开始新工程”。

界面使用晴空/草地配色、方块景观与像素头像，桌面为地图＋侧栏，窄屏为上下布局。权限按能力折叠显示，支持触控拖动、键盘焦点和减少动态效果设置。

## 旧配置的一次性迁移

旧版 delegate / report / message 边和 rules 枚举已从运行时及画布编辑器移除。加载旧文件只显示转换提示，不渲染或执行旧语义连线。点击“转换旧配置”会调用独立导入模块 team-migration.js：同一对成员的旧边合并为一条关系说明，空边旧配置展开为显式互通关系，保留所有成员权限、职责和 profile。转换只是预览，检查后再保存；未知边类型直接报错。

POST /api/team/migrate 只返回转换后的配置和校验结果，不写文件。保存与启动入口只接受新版格式。旧版未结束工程不能按新版规则恢复：选择开始新工程后，其记录会被归档，历史配置、任务和现场建筑保留。已结束旧记录仍可读取。新版工程恢复仍要求成员、关系、职责和权限与快照一致。

## 配置示例

```json
{
  "coordination": "relationships",
  "entryAgent": "lead",
  "agents": {
    "lead": { "role": "lead", "profile": "andy.json" },
    "foreman": {
      "role": "organizer", "profile": "andy.json",
      "permissions": {
        "whitelistOnly": true,
        "allow": ["delegate_task", "reassign_task", "list_tasks", "send_message", "list_peers", "get_tool_help", "inspect_part", "inspect_build", "get_build_checklist", "inspect_blueprint", "observe_environment", "observe_cells", "move_to", "fly_to", "land_at"],
        "blueprintAuthority": false, "finishGate": false
      }
    },
    "builder": {
      "role": "builder", "profile": "andy.json",
      "permissions": { "deny": ["design_blueprint", "delegate_task", "propose_task_share", "commit_task_share"] }
    }
  },
  "edges": [
    { "from": "lead", "to": "foreman", "description": "lead 负责整体设计，给 foreman 分配目标和范围；foreman 自行拆分并组织施工，汇总结果后向 lead 汇报。" },
    { "from": "foreman", "to": "builder", "description": "foreman 安排施工，builder 按范围执行并报告进展；遇到阻碍提供具体坐标，由 foreman 协调。" }
  ]
}
```

有 `delegate_task` 权限的成员可以对自己的运行中任务继续委托。无施工权限的组织者也能接收范围任务，再分配给下级。子任务范围必须包含在父任务当前 `workScope` 内；事务创建子任务、缩小父任务自行施工范围并更新租约。父任务原始 scope 和验收义务保持不变。依赖不得形成循环等待，不能派回仍在等待的上级；父任务须等待子任务完成，再核验原始完整范围。`delegate_task` 的稳定 key 在新版按发起者和父任务隔离，超时重试不会重复转交范围。

任务结果自动通知工程入口、发起者和任务祖先；其他关系中的主动汇报由模型通过消息完成。子任务继续委托时，接收者不能正在执行另一任务，避免成员相互等待；相同派单的幂等重试不受此限制。故障接管按当前父任务执行者的连线选择成员，不再要求所有下级都直连入口。重启后保留任务树与范围划分，旧令牌失效。关系、职责与权限修改需开始新工程；恢复时会检查它们与工程快照一致。

运行时独立检查派单、交接、通信、设计等权限。自然语言不能绕过权限、租约或验收；空连线集合不会隐式开放全员互通。运行时不解析“审批”“投票”等文字为强制规则：模型可以协商，施工顺序可登记为 `dependsOn`，但独立审批门、投票协议、无蓝图的通用任务和公共抢单池尚未实现。本版仍由入口接收整体目标、发布唯一共享蓝图并完成工程最终验收；其他成员的设计/验收能力位不能把这些工程级职责转移走。

验证：`node scripts/test-relationship-teams.mjs` 覆盖关系配置、权限拒绝、三层委托、范围转交、循环依赖、IPC/checkpoint、恢复、重启和画布转换；已加入 `npm run test:team`。`npm test` 覆盖完整离线回归；`npm run test:console-ui` 使用隔离的无头 Edge/Chrome 和模拟 API 验证页面、拖动保存、关系编辑、权限和迁移，截图写入 `.tmp-codex-relations/`。可设置 `BROWSER_BIN` 指定浏览器路径。这些测试不会启动 Minecraft 或请求真实模型，关系说明的实际理解效果仍需联调。

## 执行与持久化

- console/team-supervisor.js 校验配置和 profile，为每个成员启动独立 Node 子进程。
- team-client.js 通过 IPC 请求共享运行时，每两秒心跳；成员只领取自己的就绪任务。
- team-runtime.js 是共享状态的唯一写入者。工程保存关系快照，任务保存具体范围、父子关系和依赖。
- team-store.js 使用 Node 22 内置 SQLite 的事务和 WAL，进程所有权锁防止两个控制台同时管理同一目录。
- loop-agent.js 保留观察、计划、行动和检查循环；关系说明影响决策，运行时独立验证权限和执行结果。

## 范围、交接和恢复

delegate_task 必填 key、recipient、partIds、description、success；可选 scope 和 dependsOn。scope 可用世界坐标 region/positions，也支持 coordinateSpace=blueprint。省略 scope 表示完整部件；部分范围不得切开床、门或双格植物。多个任务可以使用同一 partId，但自行施工范围必须互斥。

协商式交接依次调用 propose_task_share、respond_task_share、commit_task_share。双方需相连，且具有相应工具权限；接受提案本身不授予写权限。正式提交在事务中转交范围，接收者需先结束当前任务。过期租约、父任务结束或控制台重启会使尚未交接的提案失效；已提交范围持久保存。

任务依次经历 queued、running、completed；失败进入 blocked，取消进入 cancelled。领取时授予令牌与默认 15 秒租约，任务结果和收件箱支持重试/确认。任务超时未领取会通知分配者；在线不代表 canAcceptTask。用户主动暂停的成员不会被擅自恢复。

子任务以 complete_task 完成，程序检查其原始范围与现场证据；工程入口以 finish 验收全部蓝图与空位。蓝图存在未结束任务或租约时不能直接修订。工程取消或令牌失效后，后续物理写入被拒绝，已发送到 Minecraft 的操作可能先完成。

prepare_parallel_build 是入口的可选工具，需要 2–8 名有施工权限且相连的成员、独立支撑、已清理场地及没有未结束任务或租约。它不是自动调度器，通常直接按 scope 分工即可。

运行环境：Node 22.13 或更高的 22.x，使用内置 SQLite。
