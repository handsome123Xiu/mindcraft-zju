# 上下文瘦身：给模型看摘要，细节按需查

## 原则

压缩只发生在"发给模型的视图"（createDecisionRequest），**不改 job 持久状态**。完整数据仍在 state 里，模型用现有工具（list_tasks / inspect_part / get_build_checklist / nextOffset 分页）按需读取。

## 改动清单

### 1. 团队通知不进聊天记录（loop-agent.js receiveTeamEvent，~:543）

- `message`/`share_proposal`（真人对话）：仍进 messages，截断 1000→300 字符
- 其余生命周期事件（任务认领/完成/失败等）：不进 messages，写入新字段 `job.teamFeed`：`[{at, kind, from, text≤160}]`，保留最近 12 条
- 上下文 team section 加 `feed: job.teamFeed`
- `validateState` 给 teamFeed 加可选校验（默认 []，旧 state 兼容）

### 2. 任务列表紧凑视图（loop-agent.js :46）

`tasks` 字段改为 map 紧凑视图：保留 `id, key, to, partIds, status, attempt, dependsOn, claimStalled, parentId`；`description` 截 80 字、完成 `summary` 截 100 字、失败 `reason` 截 120 字；scope 用已有 `scopeSummary()`。自己的 `teamTask`（assignment 块）保持完整。**list_tasks 工具仍返回完整原始记录**（按需读取通道）。

### 3. recentEvents 压缩重复大块（decision-context.js recentModelEvents）

- `get_build_checklist` 事件特判压缩为 `{status, verifiedParts, totalParts, remainingCells, nextPartId, details}`（checklist 已是顶层 section）
- `inspect_build` 事件同理压成 `{status, differenceCount, differenceReasons, details}`
- `summarizeResult` latest 数组上限 8→4；suggestions actions 上限 3

### 4. JSON 模式说明书对齐 focus 机制（decision-context.js :70-71）

instructions 的 TOOLS 行：focus 工具（:43-54 现有集合）给完整 schema，非 focus 只列名 + `'For other available tools, get_tool_help first: ...'` 指针行（nativeInstructions :73 已有同样文案可复用）。预期 ~9.7K→~6-7K。

### 5. CORE 指令补一句（decision-context.js CORE）

`Team lifecycle state lives in team.tasks/feed; the chat window holds real conversation. Use list_tasks/inspect_part for full detail on demand.`

## 测试

- test-decision-context.mjs：checklist/inspect_build 事件压缩断言；instructions 含 focus schema + 非 focus 仅名字；合成最坏 job 断言 contextChars < 12K 阈值
- test-team-actions.mjs：N 个生命周期事件后 messages 不增长、teamFeed ≤12 条；message 类仍进且 ≤300
- test-building-recovery.mjs：无 teamFeed 的旧 state 恢复兼容
- list_tasks 返回完整 description 不缩水
- 全量 npm test（team-runtime 预存在 flake 除外）

## 文档

- AGENT-SYSTEM-LOGIC.zh-CN.md §7 上下文控制表更新新数字与 teamFeed
- agent-context.md 补视图层压缩 + 按需读取原则

## 预期（对照真实最坏样本 994b757f lead）

messages 20.1K→5-8K；recentEvents 5.6K→2-3K；team 2.8K→1.5K；instructions 9.7K→6-7K；最大请求 67KB→35-40KB。
