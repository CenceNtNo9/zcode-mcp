# ZCode MCP task bridge

[简体中文说明](README.zh-CN.md)

A local, dependency-free Node.js stdio MCP server that lets Codex query a ZCode installation and delegate scoped development tasks to it.

## What it addresses

The bridge gives Codex a single MCP workflow for ZCode connection queries, scoped task delegation, status/attention handling, same-session follow-ups, cancellation, and paged local communication records. It uses the existing local ZCode installation and provider configuration.

This package revision fixes the published runtime requirements, replaces repository-only paths in smoke help with package-local commands, and documents the installer's manual update process and provider-free checks. The task runtime and installer behavior were not changed by these documentation/help fixes.

## Current limitations

The provider/model/effort is fixed to `OpenCode Go (Chat) / deepseek-v4.1-flash / max`. Writer scope is not an OS sandbox. Active task state is in memory and cannot resume after an MCP restart, although saved communication records remain readable. Updates of an installer-managed runtime require the manual backup/replacement procedure below. Real-provider end-to-end testing was not run for this revision; verification used local provider-free checks on Windows. Other platforms and ZCode versions remain unverified. See the operating and privacy limits below before delegating tasks.

## Package contents

- `mcp-server.mjs` — MCP stdio server and task tools.
- `app-server-client.mjs` — ZCode app-server process and protocol client.
- `communication-journal.mjs` — local, paged task communication records with redaction.
- `mcp-smoke.mjs` — provider-free protocol and local fake-server checks.
- `install-global.ps1` — optional Windows PowerShell installer for Codex CLI.
- `LICENSE` — MIT license.

The package does not include a ZCode executable, provider settings, logs, credentials, or task/session data. It has no npm dependencies.

The smoke script uses synthetic task IDs and fake secret sentinels only to check journal redaction; these are test fixtures, not user records or credentials.

## Requirements

- Node.js **24.14.0 or later** for both the MCP server and the ZCode child process (including a `ZCODE_NODE` override). The package was tested with Node.js **24.16.0** and uses built-in modules only.
- Codex CLI or another Codex client that supports local stdio MCP servers.
- A local ZCode CLI installation and its existing provider configuration. `ZCODE_CLI` must point to the `zcode.cjs` file from the installation you want to use.
- The server currently requires the exact provider/model/reasoning selection `OpenCode Go (Chat) / deepseek-v4.1-flash / max`. It reports an error when that selection is unavailable; it does not fall back to another model.

The verified environment is **Windows, ZCode desktop 3.14.3, and its bundled ZCode CLI 0.16.9**. Other ZCode versions and macOS/Linux have not been verified. The optional installer, process-cleanup check, and startup-EOF check are Windows-specific; the presence of cross-platform runtime code does not establish support on other platforms.

Do not put credentials in `ZCODE_CLI`. The bridge starts the configured CLI through the current Node.js runtime and passes the existing provider configuration paths to that child process. It does not copy or edit provider configuration.

## Configure Codex

Use absolute paths in the examples and replace both placeholders with paths on your own machine.

### Codex CLI

```sh
codex mcp add zcode_bridge --env "ZCODE_CLI=/absolute/path/to/zcode.cjs" -- node /absolute/path/to/zcode-mcp/mcp-server.mjs
codex mcp list
```

If `node` is not on the environment Codex uses, replace it with the absolute path to your Node.js executable. Restart or reload the Codex MCP servers after changing the configuration.

### `config.toml`

Codex CLI, desktop, and IDE clients on the same host share MCP configuration. Add this entry to your Codex `config.toml`:

```toml
[mcp_servers.zcode_bridge]
command = "node"
args = ["/absolute/path/to/zcode-mcp/mcp-server.mjs"]
env = { ZCODE_CLI = "/absolute/path/to/zcode.cjs" }
```

Set `command` to the absolute Node.js executable path if needed. On Windows, escape backslashes as required by TOML or use forward slashes in paths.

The Codex CLI `mcp add --env` syntax and `config.toml` fields are documented in the [Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp).

### Optional Windows installer

`install-global.ps1` copies the three runtime modules under the selected Codex home and registers the stdio server, including the explicit `ZCODE_CLI` value. It is Windows-specific. Without `-Install`, it runs a read-only preflight; add `-Install` to write the runtime copy and Codex registration.

```powershell
.\install-global.ps1 -ZCodeCliPath 'C:\path\to\zcode.cjs'
.\install-global.ps1 -ZCodeCliPath 'C:\path\to\zcode.cjs' -Install
```

Optional installer parameters are `-CodexHome`, `-NodePath`, and `-CodexCliPath`. The selected Codex home must already exist. If a `zcode_bridge` registration exists with a different command or `ZCODE_CLI` value, the installer stops for manual review.

### Updating an installer-managed runtime

The installer accepts an empty runtime directory or an exact copy of the package's three runtime modules. It deliberately stops when an existing copy differs, including when updating from an older package; `-Install` does not overwrite it.

1. Stop active bridge tasks and unload the MCP server or close the Codex clients using it. An MCP restart cannot recover active tasks.
2. Review the new package and back up the selected Codex home's `config.toml` and `tools/zcode-bridge` directory outside that runtime directory. Keep `state/zcode-bridge/records` in place if you need the saved communication records.
3. After confirming the absolute target path is the intended Codex home's `tools/zcode-bridge`, move that runtime directory to the backup location. Do not put backup files inside the replacement runtime directory.
4. Run the new package's read-only preflight with the same `-CodexHome`, `-NodePath`, `-CodexCliPath`, and `-ZCodeCliPath` values used before. If it passes, rerun with `-Install`, then restart or reload the Codex MCP server. An unchanged, compatible registration can be reused.

If the launch command or `ZCODE_CLI` path also changes, inspect the existing registration and update it deliberately using the Codex configuration methods above before retrying. The installer never silently replaces an incompatible registration. If installation fails, stop the clients again and restore the backed-up runtime and configuration before reloading.

## Runtime configuration

`ZCODE_CLI` is required and must identify an existing `zcode.cjs` file. These optional environment variables can be set on the MCP server entry when your installation needs overrides:

- `ZCODE_NODE` — Node.js executable used to launch ZCode; defaults to the Node.js executable running the MCP server.
- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` — override for the built-in provider configuration path.
- `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` — override for the personal provider configuration path.
- `CODEX_HOME` — Codex home used for task records when the records override is unset.
- `ZCODE_BRIDGE_RECORDS_DIR` — explicit task-record directory; takes precedence over `CODEX_HOME`.

The ZCode app-server starts lazily when a query or task tool needs it. MCP initialization and `tools/list` do not start ZCode.

## Tools and operating limits

The server provides `zcode_query`, `zcode_start_task`, `zcode_wait_task`, `zcode_task_report`, `zcode_continue_task`, `zcode_cancel_task`, `zcode_respond_attention`, and `zcode_read_task_communication`.

A task brief supplies an existing absolute workspace, a goal, context, workspace-relative writer paths, and acceptance checks. One unsettled task at a time is allowed for a canonical workspace. The server keeps ZCode permission checks enabled. A one-call file write/edit approval is available only for a requested path inside the declared writer scope; command requests cannot be approved through this bridge. User-input requests can only be declined or cancelled.

The bridge does **not** create an operating-system sandbox. A writer scope describes the intended file boundary; it is not an OS access-control mechanism. Keep scopes narrow and review permission prompts before responding.

Tasks and their live ZCode sessions are held in memory by the MCP process. If that process stops or restarts, active work is stopped and cannot be resumed by this server. Communication records remain on disk and can be read after a restart.

## Communication records and privacy

Records are newline-delimited JSON under `CODEX_HOME/state/zcode-bridge/records/<taskId>.jsonl`. If `CODEX_HOME` is unset and `ZCODE_BRIDGE_RECORDS_DIR` is not set, the server uses the Codex home inferred from its standard `tools/zcode-bridge` install location, or the current user's `.codex` directory for a source-layout run. The server refuses to put a task's record directory inside that task's workspace.

Records contain task lifecycle events and paged parent/ZCode messages. The journal omits fields named like credentials, headers, provider configuration, raw tool input, or private reasoning, and redacts common key/token patterns. Redaction is a safeguard, not a guarantee: do not include passwords, API keys, access tokens, or other secrets in task briefs or messages. Protect and delete the local records according to your retention needs. No credentials or existing logs are bundled with this package.

## Safe checks

Run the protocol-only check from the package directory:

```sh
node mcp-smoke.mjs --protocol-only
```

It starts only the local MCP server process and checks the supported MCP discovery/list and initialization/list exchanges. It does not start ZCode, inspect provider configuration, or make a model request.

Check JavaScript syntax without launching any service:

```sh
node --check mcp-server.mjs
node --check app-server-client.mjs
node --check communication-journal.mjs
node --check mcp-smoke.mjs
```

The following additional checks are also provider-free and use local helper processes or fakes. `--process-cleanup` and `--startup-eof` require Windows; `--communication-log` was tested on Windows.

```sh
node mcp-smoke.mjs --communication-log
node mcp-smoke.mjs --process-cleanup
node mcp-smoke.mjs --startup-eof
```

Run `node mcp-smoke.mjs --help` for details. `--scratch-task` makes live ZCode requests and should only be run when you intend to exercise the configured provider.
