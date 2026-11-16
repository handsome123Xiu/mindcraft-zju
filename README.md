# Mindcraft：改进版

基于 [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) 的本机研究改进版，用于 Minecraft Agent 实验。保留上游 MIT 许可证及作者声明。本仓库是整理后的源码快照，基于提交 `e1c1fc3ffa481506c2445fc639e16dba504b5920`，不是上游官方发行版。

## 已实现

- 默认启动建筑 Agent 循环。模型根据原始目标、整体计划和现场反馈持续选择观察、设计、施工、移动及验收，失败后可以调整计划再执行。
- 蓝图设计是独立的 `design_blueprint` skill；工具包括观察、移动/飞行、查看单格、发消息，以及单格/排/矩形/立方体的放置和拆除。放置支持蓝图相对坐标自动转换，纯拆除支持独立目标登记与验收。Agent 自行选择材料、原子动作和顺序，每次根据反馈决定下一步。
- 施工清单持续核验各部件，提供缺失坐标和原子动作建议，最后再总体验收。材料来自当前版本的方块物品目录，仅按材料策略禁用重力方块；精确朝向和特殊状态暂不支持指定。
- 蓝图用于描述目标、约束放置和独立验收，完成必须通过现场核验及模型对原始需求的逐项复核。
- 计划、蓝图和工具反馈持久化，支持暂停及跨进程恢复。每轮默认最多 30 次模型请求（含 skill）或 20 分钟，达到上限保存进度等待继续。
- Minecraft 1.21.6 创造模式取料与课程 Responses 用量日志沿用本项目适配。

多 Agent 通信与施工调度留待下一阶段。完整指令与动作参数见 [建筑版使用说明](BUILDING.md)。

## 环境

- Minecraft Java Edition **1.21.6**，测试世界开放局域网。游戏本体、启动器、账号和存档不包含在仓库内。
- Node.js **22.x**（本机验证版本 22.23.4）与 npm。
- 自然语言建造需要可调用的模型服务。`course_responses` 使用 `Base URL + /responses`，不是 Chat Completions 请求格式。

该游戏客户端路径不需要使用 Python 桥接器；本仓库不依赖原来的 `D:\MinecraftAgentLab` 目录结构。原生依赖如 canvas 在没有可用预编译包时可能需要 C/C++ 编译环境。其他系统及全新机器安装尚需单独验证。

## 安装与配置

在仓库根目录运行：

```powershell
npm ci
npm run setup
```

`npm ci` 使用随仓库提交的 `package-lock.json`，并通过 postinstall 应用 `patches/`。不要删除 lockfile，不要使用 `--omit=dev` 或跳过安装脚本，否则补丁工具可能不可用。

`setup` 只创建缺失的 `andy.json` 和 `keys.json`，不会覆盖已有配置。两者都已加入 `.gitignore`。

若使用自然语言建造，编辑 `andy.json`：

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

将模型名称和接口根地址替换成服务商给出的实际值；地址不要重复包含 `/responses`。当前本机测试使用课程网关的 `gpt-6.1-sol-medium`，这里只保留模板，不保证其他服务商存在同名模型。适配器目前保留课程网关要求的 `x-openai-actor-authorization: local-image-extension` 请求头；它不代表所有 Responses 服务都需要该头。

在 `keys.json` 中填写 `COURSE_API_KEY`，也可以通过同名环境变量提供。不要把真实密钥写进示例文件、源码、README 或 Git 提交。

游戏开放局域网后，双击 `Start-Mindcraft.cmd` 输入端口，或者运行：

```powershell
$env:MINECRAFT_PORT="替换为游戏显示的端口数字"
npm run check:setup
npm start
```

`check:setup` 检查依赖及游戏 TCP 连通性。端口随每次开放局域网可能变化。

默认 `settings.js` 使用本机 `offline` 机器人登录方式，适用于已允许这种连接的局域网测试。远程服务器的登录认证需按实际要求配置。机器人进服后，可在游戏聊天或私聊中直接问候、提问、描述任务，无需以“建造”开头。模型通过 `send_message` 私聊回复、询问细节和汇报进度；运行中发送的补充内容会进入后续决策。机器人名字以 `andy.json` 的 `name` 为准，修改代码后需重启启动脚本。

## 使用与实验记录

- Agent 状态、建筑蓝图与验收记录保存在 `bots/<机器人名>/builds/`。状态包含原始需求、整体计划、最近工具反馈及已放置坐标，结果记录区分程序核验和模型语义判断。
- API 用量保存在 `logs/api-usage.jsonl`，可通过 `run_id` 对应建筑记录。
- 此前五层金字塔约 8 分钟、30 万 Token 的结果来自旧版实验，可用来和建筑专用版重新对照。
- 后续约 1 分 48 秒、零模型调用的金字塔实验采用了预设几何，属于施工器测试。建筑专用版已删除该专用模板，应重新测量自然语言规划和施工的整体结果。

同一次连接可连续执行独立的新建任务，每次只运行一个，不自动排队。任务运行时可查询进度、暂停或取消。默认起建高度根据实际地面确定。Agent 可以逐个删除工地内已有方块，用于清理障碍或修复；工地范围是距本次任务原点 48 格以内。删除必须显式调用、核对目标材质并读取现场确认，放置和寻路均不会隐式拆除方块。支持步行和创造模式飞行、悬停、落地，高处放置会尝试飞行就位并检查碰撞、距离与相邻放置面。尚不支持方块交互或整栋已有建筑的自动改造。

当前使用方式见 [建筑版说明](BUILDING.md)。[旧版规划说明](docs/PLANNING.zh-CN.md) 仅作历史记录，不适用于当前默认入口。

## 验证

```powershell
npm test
npm run check:publish
```

`npm test` 使用模拟对象检查建筑蓝图、放置动作、基础方块动作、飞行与高处放置、Agent 循环的反馈重规划、预算、完成判定、跨进程恢复及此前的计划和创造模式物品协议，不调用收费模型，也不连接 Minecraft。`npm run test:building` 可单独运行建筑、动作和循环测试；其中飞行测试需要已安装的 Mineflayer 相关依赖。`check:publish` 扫描已跟踪文件，阻止常见私密文件、过大文件和明显密钥串进入提交；它不是完整的安全审计。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `src/` | 建筑 Agent、蓝图、施工、模型适配及控制台源码 |
| `profiles/` | 保留的上游模型配置 |
| `patches/` | 固定依赖版本对应的修复补丁 |
| `scripts/` | 配置生成、启动检查、回归测试和发布检查 |
| `andy.example.json`、`keys.example.json` | 无密钥配置模板 |
| `package.json`、`package-lock.json` | 依赖声明、锁定版本和命令 |
| `docs/` | 使用、发布及来源记录 |

许可证见 [LICENSE](LICENSE)，原作者声明保留。源码来源和整理边界见 [PROVENANCE.json](docs/PROVENANCE.json)。
