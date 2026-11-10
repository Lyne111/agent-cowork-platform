# Agent Cowork Platform

本机运行的多 AI 协作工作台，面向单人代码与文档任务。项目方案见 [docs/PROJECT_V0.1.md](docs/PROJECT_V0.1.md)。

当前版本为 **v0.1 开发版**：提供本地任务管理、角色与规则、SQLite 持久化、可靠派单核心、独立工作区与成果版本，以及三种工具的安装和协议诊断。三家真实执行与 Windows 发布验收尚未完成，**当前发行入口不启用原生 agent 派单**。界面会显示实际限制，不将模拟适配器当成真实工具。完整状态见 [兼容性记录](docs/compatibility.md) 和 [测试记录](docs/testing.md)。

## 在 Windows 上启动

1. 安装 **Node.js 24.22.1**（Node 24 LTS，包含 npm）和 Git，并重新打开 PowerShell。
2. 克隆本仓库，或下载源码 ZIP 并解压到自行选择的目录。项目根目录中应包含 `package.json`。
3. 双击目录内的 **`install.cmd`**。它会检查 Node/Git、安装依赖、构建、运行工具诊断并启动服务；出错时保留窗口供查看。该脚本需要 Node 和 Git 已安装，不会替你安装或替换系统软件。

也可以在项目根目录打开 PowerShell，手动执行：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run doctor
npm.cmd start
```

服务监听 `127.0.0.1:3210`，浏览器访问服务启动时显示的本机地址。`doctor` 会报告当前机器的工具安装、版本和未验证能力；缺少工具不妨碍创建和管理项目、角色、规则与任务。不要把密钥粘贴到任务或诊断日志中，沿用各工具的正常登录方式。

也可在允许执行本地 PowerShell 脚本的电脑上运行 `./start.ps1`；它执行同样的检查、安装、构建、诊断与启动。双击 `install.cmd` 无需修改 PowerShell 执行策略。

## 文件放在哪里

- 源代码、项目文档、启动脚本：自行选择的项目安装目录。
- 默认运行数据：启动目录内的 `.local-data`，包含 SQLite、任务工作区、成果快照等；此目录已被 Git 忽略，源码包也不包含它。
- 你交给 AI 处理的 Git 项目：由界面选择路径。要求已有提交并且工作区干净；工具不会覆盖未提交文件。

运行数据不能位于被处理项目的目录内。可以通过环境变量将数据目录设置到 Windows 当前用户的应用数据目录，再启动：

```powershell
$env:AGENT_COWORK_DATA_DIR = Join-Path $env:LOCALAPPDATA 'AgentCowork'
npm.cmd start
```

不要在服务运行时仅复制 SQLite 主文件作备份。首版可先停止服务，再完整复制运行数据目录；任务工作区是 Git worktree，迁移它们还涉及原始 Git 仓库。保留原目录与仓库，在迁移后的机器上重新核对路径与执行状态。

## 开发与检查

```text
npm ci
npm run dev
npm run build
npm test
npm run doctor -- --json
```

`dev` 自动构建前端并监听文件变化，同时监听服务端代码；前端更新后刷新浏览器。所有请求使用同一个本机端口，不需要额外配置跨域。`npm test` 使用临时数据库、临时 Git 仓库和明确的协议夹具，不访问付费模型。

源码按 `apps/web`、`apps/server`、`packages/core`、`packages/protocol`、`packages/adapters` 和 `packages/workspace` 划分。故障恢复与状态限制由服务端验证，网页不直接控制原生工具。

## 当前功能与限制

- 可以添加本地 Git 项目、创建任务、保存角色与规则、查看待处理事项及事件，控制暂停派单。
- 核心支持稳定请求去重、流程和工作区占用、停止待核实、固定成果复核及指定版本验收；这些执行流程通过注入测试运行时验证。
- 真实 Codex、Antigravity、Harness 的目录限制、只读复核、审批、停止及恢复，必须在具体工具版本与系统上验证后才能接到派单入口。当前仅有协议诊断，不提供绕过验证的开关。
- 不自动合并、推送或部署，不接管原有桌面聊天，不宣称实现模型费用硬封顶。

许可证：Apache-2.0。贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
