# ZCode MCP 任务桥接器

让 Codex 通过本地 MCP 服务查询已有的 ZCode 安装、委派指定范围的开发任务、查看任务状态和权限请求、继续同一会话，并分页读取本地沟通记录。适合 Codex 负责规划和独立验收、ZCode 负责执行的协作流程。

[下载发布包 ZIP](downloads/zcode-mcp.zip) · [完整中文说明](zcode-mcp/README.zh-CN.md) · [English documentation](zcode-mcp/README.md)

## 用途与设计

桥接器提供八个 MCP 工具，串起连接检查、异步任务、等待/报告、后续修正、取消、权限响应和记录读取。任务包含现有 workspace 的绝对路径、明确目标、上下文、唯一写者路径和验收要求，完成后保持未提交，供父代理审查与独立验收。

```text
Codex → 本地 stdio MCP → mcp-server.mjs
                          ├─ app-server-client.mjs → 已安装的 ZCode CLI app-server
                          └─ communication-journal.mjs → 本地 JSONL 沟通记录
```

Node.js 仅使用内置模块，无需安装 npm 依赖。MCP 初始化与工具列表查询不会启动 ZCode；查询或任务按需启动 app-server。发布包不包含 ZCode、provider 配置、凭证、日志或用户会话数据。模型任务使用你已有的 provider 配置，可能产生对应服务费用。

## 环境要求

- MCP 和 ZCode 子进程均要求 **Node.js 24.14.0+**；实际检查使用 **24.16.0**。
- 支持本地 stdio MCP 的 Codex 客户端，以及已安装、已配置 provider 的 ZCode。
- 当前固定使用 **`OpenCode Go (Chat) / deepseek-v4.1-flash / max`**，没有替代模型选项。
- 已验证 **Windows、ZCode desktop 3.14.3、其内置 CLI 0.16.9**；其他平台和 ZCode 版本未经验证。

## 下载、安装与快速使用

1. 打开 [downloads/zcode-mcp.zip](downloads/zcode-mcp.zip) 文件页，通过 GitHub 的下载按钮保存 ZIP，解压到固定目录。仓库中的 `zcode-mcp/` 是同一包的可读源码和文档。
2. 确认 Node 版本，以及本地 ZCode 安装中 `zcode.cjs` 的绝对路径。在解压目录执行只检查本地 MCP 协议的命令：

```powershell
node --version
node mcp-smoke.mjs --protocol-only
```

3. 替换以下占位路径，向 Codex 注册服务：

```powershell
codex mcp add zcode_bridge --env 'ZCODE_CLI=C:/path/to/zcode.cjs' -- node 'C:/path/to/zcode-mcp/mcp-server.mjs'
codex mcp list
```

若 Codex 的环境找不到 `node`，改用 Node 可执行文件绝对路径。注册后重启或重新加载 MCP 服务。也可手动配置 `config.toml`，或使用 Windows 安装器先预检、再加 `-Install`；完整步骤见 [中文安装说明](zcode-mcp/README.zh-CN.md)。

4. 向 Codex 提供现有 workspace 的绝对路径、精确目标、writerScope 和验收要求，例如：

> 使用 zcode_bridge 查询 `C:/work/my-project` 的连接。确认固定模型可用后，委派一个仅修改 `docs/example.md` 的文档任务；核对现有命令并运行 git diff --check。权限请求先展示给我，等待明确授权。完成后独立检查差异和验收，不提交。

连接查询会启动本地 ZCode；开始模型任务会调用真实 provider。用 `taskId` 等待和读取报告；需要修正时在仍存活会话内继续，沿用原范围。发生 `needs_attention` 时必须审查具体请求，服务不会自动批准。一个规范化 workspace 同时只允许一个尚未收尾的任务。

## 此次修复解决的问题

- 补正笼统的 Node 要求，明确 Node 24.14.0+、实际检查版本、ZCode 版本和平台边界。
- smoke 帮助不再引用仓库开发目录，解压包可直接按帮助执行命令。
- 说明旧 runtime 差异为何导致安装器停止，补齐手动备份、更新和失败恢复流程。
- 区分四项 provider-free 检查和真实 provider scratch 检查；提供中英文使用说明，并逐文件核对发布 ZIP 与包目录一致。

这些是公开文档、帮助与打包修复，没有改变任务 runtime 或安装器行为。

## 现阶段不足与使用边界

- **固定 provider、模型与 max 推理等级**；不可用时错误退出，不自动切换。
- **writerScope 不是 OS sandbox**，不提供操作系统级文件隔离。单次 `allow_once` 仅针对符合原范围检查的文件 Write/Edit 请求；桥接器不批准命令或永久权限，用户输入请求只能拒绝或取消。
- **活动任务状态保存在内存**。MCP 退出或重启后不能恢复继续执行；本地 JSONL 沟通记录仍可分页读取，读历史记录不等于恢复任务。
- **安装升级需要手动备份和替换流程**。安装器拒绝覆盖不一致 runtime 和不兼容注册。
- **日志脱敏不保证覆盖所有秘密**。不要在 brief 或消息中放密码、API key 或令牌，按需要保护和清理本地记录。
- **本次未运行真实 provider 端到端任务或真实安装/配置修改**。其他平台、ZCode 版本及 Node 24.14.0 的实际运行未复测；Windows 安装器和进程/EOF smoke 有平台限制。

## 实际验证

Windows / Node 24.16.0 下，执行者和父代理分别实际通过：四个 `.mjs` 的 `node --check`、Windows 安装器 PowerShell AST 语法检查、包内 `--help`、以下四项 provider-free smoke，以及差异检查。检查使用本地 helper/fake，没有真实 provider 请求。

```powershell
node mcp-smoke.mjs --protocol-only
node mcp-smoke.mjs --communication-log
node mcp-smoke.mjs --process-cleanup
node mcp-smoke.mjs --startup-eof
```

记录检查覆盖多轮消息、长回复分页还原、脱敏、路径边界、失败显式报告和重启读回；进程检查覆盖所拥有进程树的清理与启动 EOF。新增公开文档检查本地链接，ZIP 按八文件清单和逐文件 SHA256 核对。真实 provider 模式 `--scratch-task` 仅在有意调用该服务时运行。

采用 [MIT 许可证](zcode-mcp/LICENSE)。
