# 团队运行时（第一阶段）

画布定义可委托、可通信和结果订阅关系；运行时任务记录本次工程的部件分工与依赖。两者分离，用户无需为每次建造重新绘制完整工作流。

## 运行链路

1. `console/team-supervisor.js` 校验全部节点 profile 和 LAN 端口，再启动独立 Node 子进程。每个进程有独立 IPC 会话，stdout/stderr 带成员名。
2. `src/building/team-client.js` 将 agent 工具调用转成 IPC 请求，定期发送心跳、领取就绪任务、处理并确认收件箱消息。API 检测结束前不领取任务。
3. `src/building/team-runtime.js` 是共享状态的唯一写入者。工程保存启动时的结构快照；蓝图发布、委托、认领、完成、依赖解锁和失效接管均由它校验。
4. `src/building/team-store.js` 使用 Node 22 内置 SQLite 的事务和 WAL 持久化。活动运行时有进程所有权锁，避免两个控制台同时管理同一目录。大蓝图和部件坐标缓存于运行时，读上下文、收件箱和逐格授权不会每次重写数据库。
5. `loop-agent.js` 保留观察、规划、行动、检查循环。成员持有完整共享蓝图，施工清单只包含当前自行施工范围；complete_task 验收原始任务范围（包括交给协作者的工作），finish 验收整个工程。

## 最小配置

```json
{
  "entryAgent": "lead",
  "agents": {
    "lead": { "role": "lead", "profile": "andy.json", "position": { "x": 200, "y": 120 } },
    "alpha": { "role": "builder", "profile": "andy.json", "position": { "x": 100, "y": 280 } },
    "beta": { "role": "builder", "profile": "andy.json", "position": { "x": 300, "y": 280 } }
  },
  "edges": [
    { "from": "lead", "to": "alpha", "type": "delegate" },
    { "from": "lead", "to": "beta", "type": "delegate" },
    { "from": "alpha", "to": "beta", "type": "message" },
    { "from": "beta", "to": "alpha", "type": "message" }
  ],
  "rules": { "assignment": "lead-assigns", "handoff": "on-part-verified", "finish": "lead-gates" }
}
```

Profile 仍使用现有 `course_responses` 适配器，可以为各节点设置不同模型、参数和职责说明。密钥仍从现有密钥配置读取，不放入画布定义。

## 委托与恢复

“载入中心化示例”默认由 leader 自主分工（rules.assignment=lead-assigns）。蓝图设计后不会自动切分或派单，旧 spatial-parallel 配置也不再触发自动分区。示例含两名 builder，成员可增减。leader 根据现场支撑、通行、工作量和进展决定分模块、同模块合作或先后施工，不预设左右分区。

`delegate_task` 可用 scope.region={min,max} 选择模块内的方块，或用 scope.positions 指定任意坐标。默认世界坐标，也支持 coordinateSpace=blueprint 相对设计原点。省略 scope 表示完整模块。多个任务可以共享 partId，但实际施工范围不能重叠；派单不会修改模块名称、蓝图几何和版本。施工建议、租约和逐格写权限均按任务范围检查，部分范围不能切开相连的床、门或双格植物。

builder 局部协作采用明确交接：

1. propose_task_share 提出自己施工范围内的方块、接收者、目标和验收标准。双方需有消息线，lead 对接收者需有委托权限。
2. 接收者用 respond_task_share 接受或拒绝。接受不授予施工权限；空闲回合结束后等待正式任务。
3. 发起者在动作之间调用 commit_task_share，在一个事务中缩小自己的 workScope、调整租约并派发协作任务。接收者需先完成现有任务，重复提交不会重复派单。

原任务的目标和 scope 保持不变，只缩小自行施工的 workScope。原执行者可以继续施工或 wait_for_team；必须等协作任务完成并验收完整原范围后才能 complete_task。原执行者或 lead 可重派阻塞的协作任务，但不能交给正在等待它的上级任务执行者。尚未交接的提案在原任务结束、租约失效或控制台重启时过期，需用新 key 协商；已交接的范围与任务持久保存。

prepare_parallel_build 保留为可选工具，只有 leader 主动调用才按 X/Z 切分模块并派单。该工具需要 2–8 名 builder、独立支撑、清理好的场地，以及没有未结束任务或租约。一般使用 scope 派单即可保持模块结构，无需切分。

中心化预设包含 lead 与 builder、builder 之间的消息线。空闲成员可以观察、让路、回复，以及查看和回应协作提案；该回合禁止直接施工、设计和结束工程。成员结束施工前应移出工作区域。最终建筑与预期空位仍由 lead 全局验收。画布下方显示模块与自行施工范围、任务依赖、协作来源和提案状态。

计划中的已有 `requirements`（包括 `goal`）由系统保留原文。模型重述旧需求时，返回保留提示并接受有效步骤更新，不再拒绝整份计划；进度应填写在步骤的 `status/evidence`。子任务的 `ORIGINAL_GOAL` 与背景 `TEAM_GOAL` 分开，施工清单总数、剩余数和下一部件只统计分配范围。新步骤省略 `depends_on` 表示无依赖，不再隐式依赖上一步。

`delegate_task` 参数为 key、recipient、partIds、description、success，可选 scope、coordinateSpace 和 dependsOn。同一工程和版本内，相同 key 与内容返回原任务，不同内容被拒绝。依赖只能引用已存在的同版本任务。

任务经历 `queued → running → completed`，失败进入 `blocked`，用户取消进入 `cancelled`。只有现场检查证明各部件无差异且成员计划完成，循环才允许 `complete_task`。语义验收仍由模型负责；程序负责方块与范围验证。

成员心跳分别上报状态和 `canAcceptTask`，在线不代表可接单；这些字段通过团队上下文提供给 leader。空闲交流回合自动停止后进入 blocked，可领取正式委托；显式暂停保持暂停。`reassign_task` 重派原任务，保留任务 ID 和施工范围，返回接收者就绪状态；重复派单错误会给出原任务 ID 和重派提示。

依赖满足且工程未暂停时，queued 任务超过默认 15 秒未领取会触发一次 `task_unclaimed` 事件，带原任务 ID、接收者状态及恢复提示，并标记 `claimStalled`。此事件唤醒正在等待的 leader，不会自动恢复被用户暂停的成员，也不修改现场。重派或重新领取会清除标记；同次派单不会重复通知。离线任务自动接管只选择明确可接单的成员。

领取任务时发放带执行令牌的部件租约。成员每两秒发送心跳，默认租约有效期 15 秒；启动等待不视为失联。跨进程消息投递采用持久收件箱与确认机制，循环记录近期事件 ID 避免重放；任务结果可重试。进程退出或租约失效后，任务重新入队并尝试交给连线允许的其他施工成员。接管者重新读取现场，已存在的正确方块不会重复放置。

控制台重启后，之前的执行令牌全部作废。任务队列和蓝图保留；协调者通过自己的 checkpoint 恢复，用户发送“继续”。成员重新领取任务，使用新令牌。运行中的蓝图不能直接改版，须先结束相关子任务并释放租约。工程取消后，后续物理操作授权被拒绝；已经发送到 Minecraft 的操作可能先完成。

## 本阶段边界

- 支持一个协调者分配整体任务，builder 在已有任务内协商局部交接；任意层级的自主工程规划、独立验收任务和可编程触发器尚未实现。
- 支持节点 profile、职责、位置与实时状态；保留原 SVG 画布，尚未迁移 React Flow，也没有缩放、撤销或子图模板。
- 成员身份仍使用 Minecraft 名称；稳定 UUID 与无 Minecraft 实体的纯规划节点留待下一阶段。
- 当前支持建造蓝图内的并行施工与显式清理；独立拆除工程仍建议使用单 agent 模式。
- 分工和施工顺序由 agent 决定，运行时保证范围排他、依赖等待和验收。空间切分工具可以选用，但不强制；语义要求仍需模型理解与最终核查。
- 已通过离线多进程测试；还需要在实际 Minecraft 世界中验证连通性、移动冲突、加载距离和服务器延迟。

运行环境需要 Node 22.13 或更高的 22.x 版本（使用内置 SQLite，无需额外安装数据库依赖）。验证命令：`npm run test:team`。完整回归：`npm test`。
