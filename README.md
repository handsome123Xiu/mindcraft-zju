# Mindcraft：改进版

基于 [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) 的本机研究改进版，用于 Minecraft Agent 实验。保留上游 MIT 许可证及作者声明。本仓库是整理后的源码快照，基于提交 `e1c1fc3ffa481506c2445fc639e16dba504b5920`，不是上游官方发行版。

## 已实现

- 默认启动建筑专用 Agent。自然语言请求由模型一次生成蓝图，随后由程序施工与核验。
- 所有新建筑描述统一经过模型设计，程序负责展开通用几何元素并执行逐块施工。
- 规划器和施工器可以独立调用，施工 Agent 可接收含蓝图和区域的 JSON 分工。
- Minecraft 1.21.6 创造模式取料与课程 Responses 用量日志沿用本项目适配。

多 Agent 通信与施工调度留待下一阶段。完整指令与分工格式见 [建筑版使用说明](BUILDING.md)。

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

默认 `settings.js` 使用本机 `offline` 机器人登录方式，适用于已允许这种连接的局域网测试。远程服务器的登录认证需按实际要求配置。Andy 进服提示“请输入指令”，在游戏聊天直接描述想建的建筑即可。

## 使用与实验记录

- 建筑蓝图与验收记录保存在 `bots/<机器人名>/builds/`。验收记录包含已核验格数、耗时、请求次数及差异。
- API 用量保存在 `logs/api-usage.jsonl`，可通过 `run_id` 对应建筑记录。
- 此前五层金字塔约 8 分钟、30 万 Token 的结果来自旧版实验，可用来和建筑专用版重新对照。
- 后续约 1 分 48 秒、零模型调用的金字塔实验采用了预设几何，属于施工器测试。建筑专用版已删除该专用模板，应重新测量自然语言规划和施工的整体结果。

同一次连接可连续执行独立的新建任务，每次只运行一个，不自动排队。任务运行时可查询进度、暂停或取消。默认起建高度根据实际地面确定；新任务请选择另一块空地，避免重叠。当前不支持基于上一栋建筑进行拆改、加门窗或扩建，常见改造指令会返回能力说明。

当前使用方式见 [建筑版说明](BUILDING.md)。[旧版规划说明](docs/PLANNING.zh-CN.md) 仅作历史记录，不适用于当前默认入口。

## 验证

```powershell
npm test
npm run check:publish
```

`npm test` 使用模拟对象检查建筑蓝图、施工分工、核验、暂停恢复及此前的计划和创造模式物品协议，不调用收费模型，也不连接 Minecraft。`check:publish` 扫描已跟踪文件，阻止常见私密文件、过大文件和明显密钥串进入提交；它不是完整的安全审计。

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
