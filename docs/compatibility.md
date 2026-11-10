# v0.1 接入兼容性与验证记录

验证日期：2026-11-09。当前构建是开发版本；A01 三家真实交付、A02 完整真实协作尚未通过。此记录区分已运行的检查、模拟传输测试和仍需验证的能力。

## 当前实现范围

已实现安全的 CLI 安装/版本探测、能力状态模型、JSON-RPC 标准输入输出传输及 Codex 初始化助手。已处理消息分片、进度与最终响应分离、原生请求关联、重复/过期回答、超时/断线的不明投递语义。进程以可执行文件与参数数组启动，不拼接 Shell 命令，不打印凭据或原始 CLI 日志。

**生产执行适配器尚未完成，三家真实派单均保持禁用。** 安装 CLI、成功握手或勾选设置不能解除这个限制。后续需要实现并验证真实会话、审批、任务交付、目录限制、停止/恢复与各家的提问通道，再提交对应适配器实现和能力证据。不能把当前限制仅归因于缺少登录信息，也不能将测试夹具接入当成真实工具就绪。

## 本次实测

| 工具/平台 | 版本和启动方式 | 已确认 | 未确认或阻塞 |
| --- | --- | --- | --- |
| Codex / Linux | `codex-cli 0.167.0-alpha.4`；`codex app-server --stdio` | 版本命令；从安装的 CLI 生成 TypeScript 协议；在允许写入正常 Codex 数据目录的环境完成 `initialize → initialized` | 未创建线程或执行模型任务；审批、文件产出、停止、恢复、权限执行和用量均未验证 |
| Antigravity / Linux | `agy` 未安装；方案拟用 `agy acp` | 探测器准确报告本机未安装 | 尚未锁定兼容版本，ACP 真实能力与登录未验证 |
| DeepSeek Harness / Linux | `dsh` 未安装；方案拟用 `dsh --profile acp` | 探测器准确报告本机未安装 | 尚未锁定兼容版本，profile、ACP 扩展、提问与关闭后代行为未验证 |
| 三家 / Windows | 未运行 | 无 | Windows 安装、启动、权限、停止、中文和空格路径等均待实测 |

本次云端默认执行沙箱不能写入 Codex 正常数据目录的 SQLite 状态文件，故 app-server 初次启动退出。允许该正常写入后，初始化握手成功。这不是模型执行成功，也不能证明未来电脑上的登录与权限可用。没有通过更换账号目录、关闭 TLS 或改成全部允许来绕过问题。

`npm run doctor` 每次根据本机重新探测，只将安装和版本检查标为已验证；不会把本页历史记录自动应用到另一台机器。`npm run doctor -- --codex-handshake` 可选择额外初始化 Codex 协议，仍不会调用模型、创建线程、改变审批策略或访问已有会话。初始化会使用原生工具自己的正常配置及状态目录。

## 已核对的 Codex 协议

来源：当前安装的 CLI 执行 `codex app-server generate-ts --out <临时目录>` 生成的类型。命令在本次 Linux 环境执行成功。此版本为 alpha，不能据此宣布稳定 Windows 兼容。

| 原生操作 | 当前类型中确认的形状 | 使用边界 |
| --- | --- | --- |
| `initialize` | `clientInfo: { name, title, version }`；`capabilities: { experimentalApi, requestAttestation }` | 本项目传 `false`，随后发送 `initialized` 通知 |
| `thread/start` | 可选 `cwd`、`model`、权限等；结果含线程和生效配置 | 只创建工作台专用线程；不能放宽既有生效权限 |
| `turn/start` | `threadId`、`input`；文本项含 `type: "text"`、`text`、`text_elements: []` | 接受响应与最终结束通知分别处理 |
| `turn/interrupt` | `threadId`、`turnId`；返回空对象 | 返回仅表示收到中断请求；仍需结束证据 |
| `thread/read` / `thread/resume` | 关联明确的 `threadId` | 只查询工作台登记的线程；不扫描历史会话 |
| `turn/completed` | `threadId`、`turn`；状态可为 completed/interrupted/failed/inProgress | 必须校验绑定和轮次，不能把所有状态都当成功 |
| 命令/文件审批 | 不同的 `item/*/requestApproval` 请求 | 保留类型、请求编号和有效期，不统一自动批准 |
| `item/tool/requestUserInput` | 问题列表；回答为按 questionId 索引的 answers | 当前生成类型标有实验性质；需真实验证后启用 |

`item/permissions/requestApproval` 与普通命令审批结构不同；未知 server request 返回明确错误。JSON-RPC 请求 id 用于本连接关联，不能视作跨重启的幂等编号。

## Windows 本地核对步骤

代码目录按用户指定使用：`E:\gpt_project\agent-cowork-platform`。以下步骤用于补齐验证，不代表已在 Windows 执行：

1. 安装 README 锁定的 Node.js 版本，运行 `npm ci` 和 `npm run doctor`。各 agent 的登录沿用其官方流程；不要把密钥写入项目文件或上传公开 CI。
2. 分别确认官方 CLI 版本、启动方式和实际可用模型。当前安全探测器不通过 `cmd.exe` 执行 `.cmd/.bat` 启动脚本；如果 PATH 只找到 npm 脚本，它会如实提示。需要原生 `.exe` 或后续经审查的 Node 入口支持，不能改用拼接命令的 `shell: true`。
3. 对每家建立新的专用会话，在一个明确提交、可丢弃的测试 Git 项目中派发最小写文件任务。保存开始/接受证据、运行事件、原生终态、文件哈希和差异；没有这一步不能标记 submit/result 支持。
4. 分别验证命令审批、文件审批和普通提问。拒绝必须生效，过期问题不能再次回答。Harness 的最小 `ask_user` 桥接仍需完成。
5. 在原生执行层验证允许目录、目录外写入拒绝、只读复核拒绝写入，以及中文/空格路径。提示词中的限制不构成权限证明。
6. 验证取消过程中保持“停止中”；确认结束后才释放占用。Harness 若使用子执行，需要真实确认 `session/close` 及后代结束；无法确认则禁止该能力。
7. 在发送前、发送后但回执前、运行中分别断开服务并恢复。未知结果须保持待核实，不能换一个请求 id 重新执行。
8. 完成一名实现者与两名独立复核者检查固定成果、用户验收的真实流程，再更新本页和 A01/A02 记录。

每条能力证据至少记录：操作系统、工具版本、日期、启动参数（无凭据）、测试场景、期望/实际结果、原生事件或文件证据、限制。未知用量显示未知；成功握手不证明登录、计费和模型可用性。

## 本仓库自动检查

`tests/adapters/transport.test.ts` 使用本地测试进程，不调用付费模型。覆盖分片 Unicode/异步进度、乱序响应、显式审批、重复回答拒绝、超时与退出的未知状态、错误语义、畸形消息、缺失可执行文件和初始化助手。它验证传输实现，不验证厂商工具。

默认 doctor 返回诊断结果；`npm run doctor -- --require-ready` 在真实接入未完成时返回退出码 2。`--json` 输出结构化结果。诊断不导出密钥、登录文件或工具的完整原始配置。

官方参考链接沿用 [PROJECT_V0.1.md](PROJECT_V0.1.md) 第 5 节。Antigravity 和 Harness 的具体版本、扩展与 Windows 行为仍需对安装后的实际工具逐项确认。
