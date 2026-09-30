# ZCode MCP 任务桥接器

[English README](README.md)

这是一个本地、无 npm 依赖的 Node.js stdio MCP 服务，让 Codex 使用已有的 ZCode 安装查询连接、委派限定范围的开发任务、查看状态与权限请求、继续同一会话、取消任务，并分页读取本地沟通记录。它适合由 Codex 规划和验收、由 ZCode 执行任务的工作流。

## 用途与工作方式

桥接器把任务目标、上下文、唯一写者路径和验收要求交给 ZCode，返回 `taskId` 供 Codex 等待或查询。任务完成后，父代理仍需检查实际改动并独立执行验收；桥接器不会替代项目自己的协作规则，也不会自动提交或合并代码。

```text
Codex MCP 客户端
  └─ stdio → mcp-server.mjs：工具、任务状态和权限响应
               ├─ app-server-client.mjs → 本地 ZCode CLI app-server
               └─ communication-journal.mjs → 本地 JSONL 沟通记录
```

ZCode app-server 按需启动，MCP 初始化和工具列表查询不会启动 ZCode。桥接器调用本地 `zcode.cjs`，沿用已有的 provider 配置；模型任务会使用该 provider，可能产生其服务费用。发布包不包含 ZCode、provider 配置、凭证、用户日志或会话数据。

## 环境要求与已验证范围

- MCP 服务和 ZCode 子进程均要求 **Node.js 24.14.0 或更高版本**，包括通过 `ZCODE_NODE` 指定的运行时。本次实际运行版本为 **24.16.0**，未用 24.14.0 单独复测。
- Codex CLI 或支持本地 stdio MCP 的 Codex 客户端。
- 已安装并配置 provider 的本地 ZCode；`ZCODE_CLI` 指向该安装中的 `zcode.cjs` 文件。
- 当前固定选择 **`OpenCode Go (Chat) / deepseek-v4.1-flash / max`**；不可用时报告错误，不自动切换 provider、模型或推理等级。

已验证环境为 **Windows、ZCode desktop 3.14.3、其内置 CLI 0.16.9**。macOS/Linux、其他 ZCode 版本未经验证。安装脚本、`--process-cleanup` 和 `--startup-eof` 检查是 Windows 专用；运行代码包含跨平台分支不代表已验证跨平台兼容性。

## 包内文件

| 文件 | 用途 |
| --- | --- |
| `mcp-server.mjs` | stdio MCP 服务与任务工具 |
| `app-server-client.mjs` | ZCode app-server 进程与协议客户端 |
| `communication-journal.mjs` | 本地记录、分页和脱敏 |
| `mcp-smoke.mjs` | 协议与本地 fake/helper 检查；另有真实 provider scratch 模式 |
| `install-global.ps1` | 可选 Windows 安装器 |
| `README.md`、`README.zh-CN.md` | 英文和中文使用说明 |
| `LICENSE` | MIT 许可证 |

## 安装与快速开始

解压包到固定目录，确认 Node 和 ZCode CLI 的绝对路径。无需 `npm install`。先在包目录运行只检查本地 MCP 协议的命令：

```powershell
node --version
node mcp-smoke.mjs --protocol-only
```

此检查不会启动 ZCode、读取 provider 配置或调用模型。下面注册方法任选一种，替换所有示例路径，不要原样使用占位路径。

### 使用 Codex CLI 注册

```powershell
codex mcp add zcode_bridge --env 'ZCODE_CLI=C:/path/to/zcode.cjs' -- node 'C:/path/to/zcode-mcp/mcp-server.mjs'
codex mcp list
```

若 Codex 的环境找不到 `node`，将命令中的 `node` 换成 Node 可执行文件的绝对路径。注册后重启或重新加载 Codex MCP 服务。

### 手动配置 `config.toml`

在所选 Codex home 的 `config.toml` 中添加或审查此项。同一主机上使用相同 Codex home 的客户端共享该配置。

```toml
[mcp_servers.zcode_bridge]
command = "node"
args = ["C:/path/to/zcode-mcp/mcp-server.mjs"]
env = { ZCODE_CLI = "C:/path/to/zcode.cjs" }
```

Windows 路径可以使用正斜杠；若使用反斜杠，须按 TOML 规则转义。安装目录应保持稳定，移动包后需更新配置。

### 可选 Windows 安装器

安装器把三个 runtime 模块复制到所选 Codex home 的 `tools/zcode-bridge`，并用显式 `ZCODE_CLI` 注册服务。Codex home 必须已存在。先只读预检，再按需安装：

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -File .\install-global.ps1 -ZCodeCliPath 'C:\path\to\zcode.cjs'
powershell -ExecutionPolicy Bypass -NoProfile -File .\install-global.ps1 -ZCodeCliPath 'C:\path\to\zcode.cjs' -Install
```

执行策略只对此 PowerShell 进程放行。可选参数为 `-CodexHome`、`-NodePath`、`-CodexCliPath`。无 `-Install` 时不会复制 runtime 或修改注册。已有注册的启动命令或 `ZCODE_CLI` 不兼容时停止，已有 runtime 文件与来源不一致时也停止。

### 更新安装器管理的 runtime

安装器接受空 runtime 目录或与来源完全一致的三个模块；它不会覆盖旧版或被修改过的 runtime。更新按以下手动流程进行：

1. 停止活动任务，卸载 MCP 服务或关闭使用它的 Codex 客户端。重启不能恢复活动任务。
2. 审查新包，备份所选 Codex home 的 `config.toml` 和 `tools/zcode-bridge` 到 runtime 目录之外。若要保留历史沟通记录，保留 `state/zcode-bridge/records`。
3. 核对绝对路径确实为目标 Codex home 的 `tools/zcode-bridge`，再将旧 runtime 目录移动至备份位置。不要把备份放进新的 runtime 目录。
4. 使用之前相同的 Codex home、Node、Codex CLI 和 ZCode CLI 路径执行新包预检，通过后加 `-Install` 安装，再重新加载 MCP。未变化且兼容的注册可复用。

若启动命令或 ZCode CLI 路径同时改变，先人工审查并通过上面的配置方式更新注册，再重试。安装失败时先停用客户端，再还原备份的 runtime 与配置后重新加载。

## 委派任务与权限工作流

安装后可以向 Codex 发出这样的指令：

> 使用 zcode_bridge 查询 `C:/work/my-project` 的连接。确认固定模型可用后，委派一个仅修改 `docs/example.md` 的文档任务；提供目标、上下文和验收要求。遇到权限请求先展示请求等待我明确授权，完成后检查差异并独立验收，不提交。

连接查询会按需启动本地 ZCode。开始任务后会发出真实 provider 请求；请先确认你有意使用该服务。`zcode_start_task` 的输入示例为：

```json
{
  "workspace": "C:/work/my-project",
  "target": "完善 docs/example.md 的项目使用步骤。",
  "brief": "只修改指定文档，核对现有命令，不改变代码，保持未提交。",
  "writerScope": ["docs/example.md"],
  "acceptance": ["人工核对命令与现有实现一致。", "git diff --check"],
  "mode": "edit",
  "timeoutSeconds": 1800
}
```

workspace 必须是现有绝对目录，writerScope 是相对此 workspace 的路径。一个规范化 workspace 同时只允许一个尚未收尾的任务。验收字段是交给执行者的要求；父代理应独立复验，不能只相信模型报告。

| 工具 | 作用 |
| --- | --- |
| `zcode_query` | 查询 app-server 连接与固定模型选择 |
| `zcode_start_task` | 异步启动任务，取得 taskId |
| `zcode_wait_task` | 单次等待状态变化，最多 45 秒，可再次等待 |
| `zcode_task_report` | 读取状态、模型、会话 ID、记录路径、待处理请求及响应摘要 |
| `zcode_continue_task` | 在已终止轮次的仍存活会话中继续；沿用原 workspace、写者范围、模型和推理等级 |
| `zcode_cancel_task` | 请求停止当前轮次 |
| `zcode_respond_attention` | 对报告中的指定 attentionId 作一次响应 |
| `zcode_read_task_communication` | 按 taskId 分页读取持久记录，MCP 重启后仍可读 |

权限请求会暂停为 `needs_attention`，不会自动批准。明确授权后，`allow_once` 只允许对原 writerScope 内符合检查的单次文件 Write/Edit 请求使用；桥接器不批准命令、不设置永久权限。权限请求可 `deny`；用户输入请求只能 `decline_input` 或 `cancel_input`，不能通过此工具回答。未知请求类型无法批准。

writerScope 是任务边界和审批检查的一部分，**不是操作系统 sandbox**；它不提供 OS 访问隔离。权限提示仍需逐项审查。需要扩大范围时应重新规划明确的任务，避免让模型自行越界。

## 运行配置、记录与隐私

`ZCODE_CLI` 必须指向现有 `zcode.cjs`，不要把凭证放入该值。可按需设置：

| 环境变量 | 用途 |
| --- | --- |
| `ZCODE_NODE` | 启动 ZCode 的 Node 可执行路径，默认使用运行 MCP 的 Node |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 内置 provider 配置路径覆盖 |
| `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | 个人 provider 配置路径覆盖 |
| `CODEX_HOME` | 未指定 records override 时用于记录目录 |
| `ZCODE_BRIDGE_RECORDS_DIR` | 明确记录目录，优先于 CODEX_HOME |

默认记录为 `CODEX_HOME/state/zcode-bridge/records/<taskId>.jsonl`。CODEX_HOME 未设置时，从标准 `tools/zcode-bridge` 安装布局推断 Codex home；源码布局则回退至当前用户的 `.codex`。服务拒绝把某任务的记录目录放入该任务 workspace。

记录含任务生命周期和分页的父代理/ZCode 消息。journal 会省略凭证、headers、provider 配置、原始工具输入和私有推理等命名字段，并脱敏常见 key/token 模式。脱敏不是完全保证：任务 brief 和消息不要含密码、API key 或访问令牌。记录是本地文件，请按需要保护和清理。smoke 中的假 secret 字符串与合成 taskId 是测试样例，不是用户记录。

活动任务与 live 会话映射保存在 MCP 进程内存中。进程退出或重启后，活动工作被停止，此服务不能恢复继续执行；JSONL 历史沟通仍可用 `zcode_read_task_communication` 读取。能读历史记录不代表能恢复任务。

## 本次修复了什么

- 运行要求从笼统的 ESM 支持改为 Node 24.14.0+，列出实际验证版本和平台。
- `mcp-smoke.mjs --help` 从仓库内 `devtools/zcode-bridge` 路径改为解压包内命令。
- 文档明确旧 runtime 差异导致安装器停止，补齐手动备份、更新及失败恢复步骤。
- 明确四项 provider-free 检查，补齐中英文公开使用说明，并使 ZIP 与发布目录逐文件一致。

这些修复没有改变任务 runtime 或安装器行为，也没有增加可选模型、自动批准、跨重启任务恢复或已验证的跨平台支持。

## 本地检查与现阶段不足

在包目录运行：

```powershell
node --check mcp-server.mjs
node --check app-server-client.mjs
node --check communication-journal.mjs
node --check mcp-smoke.mjs
node mcp-smoke.mjs --help
node mcp-smoke.mjs --protocol-only
node mcp-smoke.mjs --communication-log
node mcp-smoke.mjs --process-cleanup
node mcp-smoke.mjs --startup-eof
```

以上四项 smoke 使用本地进程/fake，无真实 provider 请求。本次在 Windows / Node 24.16.0 实际通过协议、记录分页与脱敏、进程清理和启动 EOF 检查；PowerShell 安装器 AST 语法检查也通过。

现阶段限制包括固定 provider/模型/max、writerScope 不提供 OS sandbox、活动任务重启后不可继续、runtime 升级需要手动流程。本次修复没有执行真实 provider 端到端 `--scratch-task`、真实安装或配置修改；其他平台、ZCode 版本及 Node 24.14.0 实际运行未经复测。`--scratch-task` 会调用真实 provider，仅在明确要验证该服务时运行；其中单次 scratch 写入授权需显式选项，详情见 `--help`。

本项目采用 [MIT 许可证](LICENSE)。
