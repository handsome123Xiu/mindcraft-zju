# 中心化协作：阻塞恢复修复与联机验证

日期：2026-11-22。分支 `Collabration`。本轮从已有本地改动继续增量修复，没有覆盖此前黑板等功能。

## 原因与本轮范围

原用例 本地验证记录 的目标为“三层金字塔”，初始核验为 130/156 格，尚缺第三层 25 格与塔尖金块 1 格。

原问题包括：

1. Builder_1 的飞行被服务端纠正后，工具返回 `server_correction`，但 `flying=true` 和关闭物理的状态残留。后续放置寻路在悬停模式下跳过地面路径，重派同一机器人不能清除该状态。
2. 任务说明写了上下层先后顺序，正式 `dependsOn` 却全为空，导致上层和金块提前领取、反复查支撑。
3. 上层任务文案含金块，但 scope 仅覆盖第二、三层；Lead 又用聊天允许金块执行者去做第三层，消息没有转移正式施工权。
4. 上层已 blocked，而金块仍 running。Lead 的等待判断将 running 当作可推进工作，掩盖了必须先恢复的阻塞。

## 修改内容与系统边界

| 文件 | 本轮修改 |
| --- | --- |
| `src/building/flight-actions.js` | 非取消性的飞行失败后恢复先前物理状态并退出飞行，保留失败原因。成功飞行仍可悬停；用户暂停／取消信号触发时仍保持位置，避免直接掉落。 |
| `src/building/loop-agent.js` | 将入口自己派出的 blocked 任务作为恢复事项；它们未处理时不再因另一任务 running 就自动挂起。`wait_for_team` 返回具体待恢复 taskId；重复查询仍不恢复时，保留工程并报告待处理事项，而非取消整个工程。预算耗尽也保留待恢复任务。 |
| `src/building/decision-context.js` | 将上述恢复事项置于下一步提示前列；对具有实际 `finishGate`、全部子任务终结且现场清单完成的工程入口，提供“重新核验→完成有证据的计划步骤→finish”引导。提示不会自动更新计划或标记成功。 |
| `src/building/team-state.js` | 只更新中心化 Lead/Builder Profile：真实依赖须用返回的 taskId 登记；说明、success、partIds、scope 一致；正式重派改变权限，消息不能授权；按最新现场事实报告；认领与交付不循环等待。 |
| `scripts/test-flight-actions.mjs` | 新增服务端回正后释放悬停、恢复物理、能重新走地面的回归；保留暂停时悬停的检查。 |
| `scripts/test-coordinator-waiting.mjs` | 新增“一个 blocked、另一个 running”场景、Lead 正式重派的完整恢复、以及全部子任务完成后的三步收尾。 |

其中飞行状态、等待判定和共享决策上下文属于**系统改动**，影响使用这些能力的其他协作方式；中心化分工策略仍由 Profile 和模型决定。代码没有新增自动派工、自动换人、自动选择任务范围或自动验收。

与本轮修改前的文件快照对比：除中心化 Profile 外，其余九种预设及配置代码不变；`CORE` 常量、原 `design_blueprint` Skill 函数主体、原 `finish` 验收实现保持不变。权限、租约、范围、原始需求与现场检查仍正常执行。个人模型 API 配置没有改动。

## 当前工程的恢复操作

实际 LAN 端口为 `58733`。操作前已保存完整运行快照、三名成员任务记录、团队配置和控制台日志。

- 保留底层 81 格和第二层 49 格，没有重新生成蓝图。
- 上层原任务继续使用 本地验证记录，仍先保持 blocked，由真实 Lead 决定并调用 `reassign_task`。
- 把上层任务的范围说明和 success 修正为仅验收 part-2、part-3，不等待范围外金块；登记其对底层任务的依赖。
- 金块原任务 本地验证记录 改回 queued，登记对上层任务的依赖。没有伪造任何完成、审批或施工结果。
- 更新当前团队的 Profile，重载控制台和成员后，通过正常“继续建造”指令恢复原工程。

## 真实联机结果

Lead 先恢复原上层任务；原执行者仍有站位困难时，Lead 自主把同一个任务重派给空闲的 Builder_2。Builder_2 真实补完第三层 25 格并 `complete_task`；此后金块任务才解锁。金块执行也经历站位阻塞，Lead 再次正式更换执行者，最终由 Builder_1 完成 1 格金块。

这说明修复不保证每个站位都立即可达：服务端仍可能纠正飞行，但失败回执现在为 `flying=false`，不会把机器人永久留在旧悬停状态。当前这轮中，中心调度能够处理剩余阻塞、换人和继续施工。

补齐全部方块后，真实复测也发现原收尾提示仅覆盖黑板；本轮将它扩展到有真实最终验收权限的工程入口，并重新执行收尾测试。模型自行执行 `inspect_build`、更新验收计划证据、调用 `finish`。最终原工程及 Lead 均为 `completed`，156/156 格核验通过，remainingCells=0，三个正式任务均为 completed。

## 验证

- `node scripts/test-flight-actions.mjs`：通过。
- `node scripts/test-coordinator-waiting.mjs`：通过。
- `node scripts/test-decision-context.mjs`：通过。
- `npm run test:blackboard`：通过。
- `npm run test:team`：通过。
- 语法检查与 `git diff --check`：通过。
- 原工程真实恢复、依赖解锁、换人施工与最终 finish：通过。

本轮备份和精确增量快照位于 Codex 暂存目录 `centralized-repair-20261122`，包含 `base/`、`live-backup/`、`close-backup/` 和 `live-result.json`。运行状态恢复记录写入工程的 `recoveries`，原失败日志保留。本轮未提交或推送 Git。
