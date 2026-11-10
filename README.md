# Mindcraft：任务规划与按需代码执行改进版

基于 [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) 的本机研究改进版，用于 Minecraft Agent 实验。保留上游 MIT 许可证及作者声明。本仓库是整理后的源码快照，基于提交 `e1c1fc3ffa481506c2445fc639e16dba504b5920`，不是上游官方发行版。

## 已实现

- 明确任务计划：记录子任务、依赖、前提、完成条件和执行进度；支持暂停、恢复、取消。
- 默认调用已有技能；任务无法通过技能表达时，允许模型生成 JavaScript，由本机 Node.js 执行。
- 代码语法检查、已知技能检查、协作式执行预算及有限修正；代码不在独立操作系统沙箱中运行。
- 读取游戏状态核验背包数量、位置、玩家距离或指定坐标方块；复杂建筑整体完成仍可能标为 `model_reported`。
- Minecraft 1.21.6 创造模式物品适配、依赖固定及 `patch-package` 补丁。
- 课程 Responses 接口适配及真实 usage 日志；文本模式，不包含该课程接口的图像调用适配。

**尚未实现**：PatchouliAI 风格的通用蓝图解释器、共享施工任务池、完整建筑自动验收、多 Agent 施工分配。这些是后续方向，不应当作当前功能。

## 环境

- Minecraft Java Edition **1.21.6**，测试世界开放局域网。游戏本体、启动器、账号和存档不包含在仓库内。
- Node.js **22.x**（本机验证版本 22.23.4）与 npm。
- 可调用的模型服务。`course_responses` 使用 `Base URL + /responses`，不是 Chat Completions 请求格式。

该游戏客户端路径不需要使用 Python 桥接器；本仓库不依赖原来的 `D:\MinecraftAgentLab` 目录结构。原生依赖如 canvas 在没有可用预编译包时可能需要 C/C++ 编译环境。其他系统及全新机器安装尚需单独验证。

## 安装与配置

在仓库根目录运行：

```powershell
npm ci
npm run setup
```

`npm ci` 使用随仓库提交的 `package-lock.json`，并通过 postinstall 应用 `patches/`。不要删除 lockfile，不要使用 `--omit=dev` 或跳过安装脚本，否则补丁工具可能不可用。

`setup` 只创建缺失的 `andy.json` 和 `keys.json`，不会覆盖已有配置。两者都已加入 `.gitignore`。

编辑 `andy.json`：

```json
{
  "name": "andy",
  "model": {
    "api": "course_responses",
    "model": "YOUR_MODEL_ID",
    "url": "https://your-api.example/v1",
    "params": { "max_output_tokens": 4096 }
  },
  "embedding": false
}
```

将模型名称和接口根地址替换成服务商给出的实际值；地址不要重复包含 `/responses`。此前实验使用 `gpt-6-sol`，这里只保留模板，不保证其他服务商存在同名模型。适配器目前保留课程网关要求的 `x-openai-actor-authorization: local-image-extension` 请求头；它不代表所有 Responses 服务都需要该头。

在 `keys.json` 中填写 `COURSE_API_KEY`，也可以通过同名环境变量提供。不要把真实密钥写进示例文件、源码、README 或 Git 提交。

游戏开放局域网后，双击 `Start-Mindcraft.cmd` 输入端口，或者运行：

```powershell
$env:MINECRAFT_PORT="替换为游戏显示的端口数字"
npm run check:setup
npm start
```

`check:setup` 检查模型配置、依赖及游戏 TCP 连通性，不保证模型 API 可用。端口随每次开放局域网可能变化。

默认 `settings.js` 使用本机 `offline` 机器人登录方式，适用于已允许这种连接的局域网测试；远程服务器的登录认证需按实际要求配置。聊天中给 Andy 下达任务即可。

## 使用与实验记录

| 指令 | 功能 |
|---|---|
| `!plan` | 查看当前计划 |
| `!pausePlan` / 暂停 | 暂停计划 |
| `!resumePlan` / 继续任务 | 恢复计划 |
| `!cancelPlan` / 取消任务 | 取消计划 |

默认启用 `explicit_task_planning` 与 `allow_insecure_coding`。生成代码会执行游戏操作，应在测试世界使用；检查器和 SES 不等于独立系统级沙箱。通过 `settings.js` 可关闭代码执行，但会改变实验能力边界。

- 计划和代码记录：`bots/andy/`（不提交）。
- API 用量：`logs/api-usage.jsonl`（不提交），包含模型、请求时间、响应状态、耗时及服务商 usage。
- 不应把 `model_reported` 或脚本正常返回直接作为完整建筑验收。
- 此前五层金字塔人工实测约 8 分钟成功、平台截图约 30 万 token，是特定模型与环境下的一轮结果，不是普遍性能保证。

更多规划机制见 [规划说明](docs/PLANNING.zh-CN.md)。发布及上传步骤见 [GitHub 上传说明](docs/GitHub上传说明.md)。上游其他功能见 [原 README](README.upstream.md)；其 Docker、其他模型及其他 Minecraft 版本流程未在本次整理中重新验证。

## 验证

```powershell
npm test
npm run check:publish
```

`npm test` 使用模拟对象检查计划、代码执行约束和创造模式物品协议，不调用收费模型，也不连接 Minecraft。`check:publish` 扫描已跟踪文件，阻止常见私密文件、过大文件和明显密钥串进入提交；它不是完整的安全审计。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `src/` | Agent、技能、规划、代码执行、模型适配及服务源码 |
| `profiles/`、`tasks/` | 保留的上游配置与任务资源 |
| `patches/` | 固定依赖版本对应的修复补丁 |
| `scripts/` | 配置生成、启动检查、回归测试和发布检查 |
| `andy.example.json`、`keys.example.json` | 无密钥配置模板 |
| `package.json`、`package-lock.json` | 依赖声明、锁定版本和命令 |
| `docs/` | 使用、发布及来源记录 |

许可证见 [LICENSE](LICENSE)，原作者声明保留。源码来源和整理边界见 [PROVENANCE.json](docs/PROVENANCE.json)。
