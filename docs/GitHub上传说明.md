# GitHub 上传说明

## 上传哪一个目录

**只上传整理后的 `mindcraft-github` 仓库内容。**原实验目录 `mindcraft` 保持不变，不要上传整个 `MinecraftAgentLab`。

准备目录：`D:\MinecraftAgentLab\mindcraft-github`。

上传 `src/`、`profiles/`、`tasks/`、`patches/`、`scripts/`、`docs/`、源码入口、设置、无密钥配置模板、README、LICENSE、package.json 和 **package-lock.json**。以整理目录中的 Git 跟踪清单为准。

不要上传 `keys.json`、`andy.json`、`.env`、`node_modules/`、`bots/`、`logs/`、生成的行动脚本及聊天历史、Minecraft 本体、PCL2、游戏存档、Node/Java/Python 运行环境、其他框架以及下载的模组 ZIP/JAR。

## 使用 Git 上传（推荐）

整理目录已初始化为全新 Git 仓库并暂存公开文件，但没有创建提交或设置远程仓库。旧仓库历史没有复制，以免历史中曾提交的本机信息进入新仓库。

1. 登录 GitHub，创建一个空仓库，例如 `mindcraft-planning-lab`。公开或私有自行选择。不要让网页自动生成 README、LICENSE 或 .gitignore，因为本地已有。
2. 在 PowerShell 运行：

```powershell
cd D:\MinecraftAgentLab\mindcraft-github
git status --short
git diff --cached --stat
```

3. 检查暂存内容，不应出现真实密钥、本机配置、游戏数据。安装依赖后可再次运行 `npm run check:publish`。随后创建第一次提交：

```powershell
git commit -m "Prepare Mindcraft planning and code execution research baseline"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

将地址换成新仓库地址。Git 提示身份缺失时，配置自己希望展示的 Git 用户名和邮箱；邮箱可采用 GitHub 提供的 noreply 地址。认证按 Git Credential Manager / GitHub 登录提示完成，不要把令牌写进远程 URL。

## 不用命令行

也可在 GitHub Desktop 中添加这个现有本地仓库，审查文件、创建提交，再使用 Publish repository。不要把整个源码 ZIP 当成唯一一个文件提交；GitHub 应能直接浏览源码和修改记录。

## 首次发布后继续修改

后续开发应明确使用哪个目录。原 `mindcraft` 和这个发布副本不会自动同步。建议在发布副本完成独立配置验证后，以此作为后续开发仓库；原目录保留作实验基线。复制改动时不要带入密钥、历史记录或 node_modules。

每次提交前运行测试和发布检查。`.gitignore` 不会移除已经跟踪的文件；如果误暂存私密文件，应先从暂存区移除，再处理泄露风险，不能只补一条忽略规则。

## 实验结果表述

明确注明这是 Mindcraft 的本机研究改进版，保留上游作者和 MIT 许可。PatchouliAI 的蓝图与多 NPC 调度尚未移植，不能写成已实现。详细截图、账号页面、原始日志未包含在公开源码中。
