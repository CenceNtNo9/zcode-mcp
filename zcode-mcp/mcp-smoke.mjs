#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { terminateProcessTree, ZCodeAppServerClient } from "./app-server-client.mjs";
import {
  resolveCommunicationJournalDirectory,
  TaskCommunicationJournal,
} from "./communication-journal.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(ROOT, "mcp-server.mjs");
const MARKER_V1 = "ZCODE_MCP_SMOKE_V1";
const MARKER_V2 = "ZCODE_MCP_SMOKE_V2";
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";
const MODERN_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const ALL_TOOL_NAMES = [
  "zcode_query",
  "zcode_start_task",
  "zcode_wait_task",
  "zcode_task_report",
  "zcode_continue_task",
  "zcode_cancel_task",
  "zcode_respond_attention",
  "zcode_read_task_communication",
];

function help() {
  return [
    "ZCode MCP scoped smoke test (no extra dependencies)",
    "",
    "Usage:",
    "  From the extracted zcode-mcp package directory:",
    "  node mcp-smoke.mjs --protocol-only",
    "  node mcp-smoke.mjs --scratch-task [--approve-scratch-write]",
    "  node mcp-smoke.mjs --process-cleanup",
    "  node mcp-smoke.mjs --startup-eof",
    "  node mcp-smoke.mjs --communication-log",
    "",
    "--protocol-only checks modern server/discover + tools/list and legacy initialize +",
    "tools/list without launching ZCode. --scratch-task checks exact-model query, async",
    "task creation, same-workspace conflict, a real note creation and same-session",
    "rewrite in a disposable temp workspace, cancel, and app-server cleanup.",
    "",
    "--approve-scratch-write explicitly permits a one-time allow response only when the",
    "MCP server confirms a ZCode Write/Edit request targets the declared note.txt scope.",
    "Without it the test stops at needs_attention. It never approves commands or broad",
    "permission updates. The default ZCode task deadline is 30 minutes.",
    "--process-cleanup checks an owned detached parent/child tree through direct and",
    "client stop paths. --startup-eof checks fast task start and cleanup during delayed",
    "app-server startup with a local fake; both are Windows-only and provider-free.",
    "--communication-log checks multi-turn journal persistence, paging, redaction,",
    "path boundaries, explicit write failure, MCP restart readback, and installed-home resolution",
    "using local fakes without starting a provider or app-server.",
    "",
  ].join("\n");
}

function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const modes = args.filter((arg) => ["--protocol-only", "--scratch-task", "--process-cleanup", "--startup-eof", "--communication-log"].includes(arg));
  if (modes.length !== 1) throw new Error("choose one smoke mode");
  const unknown = args.filter((arg) => !["--protocol-only", "--scratch-task", "--process-cleanup", "--startup-eof", "--communication-log", "--approve-scratch-write"].includes(arg));
  if (unknown.length) throw new Error("unknown option");
  if (args.includes("--approve-scratch-write") && !args.includes("--scratch-task")) {
    throw new Error("--approve-scratch-write requires --scratch-task");
  }
  return { mode: modes[0], approveScratchWrite: args.includes("--approve-scratch-write") };
}

class SmokeCheckError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

function assert(condition, category) {
  if (!condition) throw new SmokeCheckError(category);
}

class McpProcess {
  constructor(options = {}) {
    const childEnv = { ...process.env, ...(options.env || {}) };
    for (const key of options.unsetEnv || []) {
      for (const name of Object.keys(childEnv)) {
        if (name.toLowerCase() === key.toLowerCase()) delete childEnv[name];
      }
    }
    this.child = spawn(process.execPath, [options.server || SERVER], {
      cwd: options.cwd || os.tmpdir(),
      env: childEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.exitCode = null;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-512);
    });
    this.child.on("exit", (code) => {
      this.exitCode = code;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("mcp_process_exited"));
      }
      this.pending.clear();
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.failPending(new Error("non_json_stdout")); return; }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  }

  failPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}, timeoutMs = 20_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("mcp_request_timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error("mcp_stdin_closed"));
        }
      });
    });
  }

  modernParams(params = {}) {
    return {
      ...params,
      _meta: {
        [MODERN_META]: MODERN_VERSION,
        [CLIENT_CAPABILITIES_META]: {},
        "io.modelcontextprotocol/clientInfo": { name: "zcode-mcp-smoke", version: "1.0.0" },
      },
    };
  }

  modernRequest(method, params = {}, timeoutMs) {
    return this.request(method, this.modernParams(params), timeoutMs);
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(name, args, timeoutMs = 30_000) {
    const response = await this.modernRequest("tools/call", { name, arguments: args }, timeoutMs);
    assert(!response.error, response.error?.message || "mcp_jsonrpc_error");
    const wrapper = response.result;
    const textBlock = wrapper?.content?.find((entry) => entry.type === "text");
    assert(textBlock, "missing_tool_text_result");
    let value;
    try { value = JSON.parse(textBlock.text); }
    catch { throw new Error("invalid_tool_json_result"); }
    return { value, isError: wrapper.isError === true };
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await waitForChildExit(this.child, 20_000);
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function countZCodeChildren() {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "$rows=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'zcode\\.cjs app-server --stdio' }); $rows.Count",
    ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    const count = Number(String(output).trim());
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

function windowsProcessIdentity(pid) {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { [string]$p.CreationDate }`;
    const creation = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return creation ? { pid, creation } : null;
  } catch {
    return null;
  }
}

function windowsPidExists(pid) {
  return windowsProcessIdentity(pid) !== null;
}

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return existsSync(file);
}

async function waitForPidGone(identity, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = windowsProcessIdentity(identity.pid);
    if (!current || current.creation !== identity.creation) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const current = windowsProcessIdentity(identity.pid);
  return !current || current.creation !== identity.creation;
}

function killCapturedPid(identity) {
  if (!identity || process.platform !== "win32") return false;
  const current = windowsProcessIdentity(identity.pid);
  if (!current || current.creation !== identity.creation) return false;
  try {
    execFileSync("taskkill.exe", ["/PID", String(identity.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5_000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function makeTreeFixture(rootDir, label) {
  const pidFile = path.join(rootDir, label + ".pid");
  const source = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });",
    "fs.writeFileSync(process.env.ZCODE_TREE_PID_FILE, String(descendant.pid), 'utf8');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const root = spawn(process.execPath, ["-e", source], {
    cwd: rootDir,
    env: { ...process.env, ZCODE_TREE_PID_FILE: pidFile },
    windowsHide: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    assert(await waitForFile(pidFile), "process_fixture_descendant_pid_missing");
    const descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    assert(Number.isSafeInteger(descendantPid) && descendantPid > 0, "process_fixture_descendant_pid_invalid");
    const rootIdentity = windowsProcessIdentity(root.pid);
    const descendantIdentity = windowsProcessIdentity(descendantPid);
    assert(rootIdentity && descendantIdentity, "process_fixture_identity_missing");
    return { root, rootIdentity, descendantIdentity };
  } catch (error) {
    try { await terminateProcessTree(root); } catch { /* Test cleanup below checks captured descendants. */ }
    throw error;
  }
}

async function cleanTreeFixture(fixture) {
  if (!fixture) return;
  try { await terminateProcessTree(fixture.root); } catch { /* Continue with verified descendant cleanup. */ }
  if (windowsProcessIdentity(fixture.descendantIdentity.pid)?.creation === fixture.descendantIdentity.creation) {
    killCapturedPid(fixture.descendantIdentity);
  }
  await waitForPidGone(fixture.descendantIdentity, 5_000);
}

async function processCleanupCheck() {
  assert(process.platform === "win32", "process_cleanup_check_requires_windows");
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "zcode-process-tree-smoke-"));
  let direct;
  let viaClient;
  try {
    direct = await makeTreeFixture(rootDir, "direct");
    const directStopped = await terminateProcessTree(direct.root);
    assert(directStopped, "direct_tree_cleanup_unconfirmed");
    assert(await waitForChildExit(direct.root, 2_000), "direct_tree_root_exit_missing");
    assert(await waitForPidGone(direct.descendantIdentity), "direct_tree_detached_descendant_alive");

    viaClient = await makeTreeFixture(rootDir, "client-stop");
    const client = new ZCodeAppServerClient(viaClient.root, 1_000);
    const clientStopped = await client.stop();
    assert(clientStopped, "client_stop_tree_cleanup_unconfirmed");
    assert(await waitForChildExit(viaClient.root, 2_000), "client_stop_root_exit_missing");
    assert(await waitForPidGone(viaClient.descendantIdentity), "client_stop_detached_descendant_alive");
    return { ok: true, directTreeStopped: true, appServerStopTreeStopped: true, providerRequestCount: 0 };
  } finally {
    await cleanTreeFixture(direct);
    await cleanTreeFixture(viaClient);
    const expectedPrefix = path.resolve(os.tmpdir()) + path.sep;
    const resolved = path.resolve(rootDir);
    if (resolved.toLowerCase().startsWith(expectedPrefix.toLowerCase()) &&
        path.basename(resolved).startsWith("zcode-process-tree-smoke-")) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}

async function startupEofCheck() {
  assert(process.platform === "win32", "startup_eof_check_requires_windows");
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "zcode-startup-eof-smoke-"));
  const workspace = path.join(rootDir, "workspace");
  const recordsDirectory = path.join(rootDir, "records");
  mkdirSync(workspace);
  const fakeCli = path.join(rootDir, "mock-zcode.cjs");
  const builtinConfig = path.join(rootDir, "builtin.json");
  const personalConfig = path.join(rootDir, "personal.json");
  const appPidFile = path.join(rootDir, "app-server.pid");
  const methodsFile = path.join(rootDir, "methods.log");
  const fakeSource = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(process.env.ZCODE_MOCK_PID_FILE, String(process.pid), 'utf8');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.exitCode = 3; return; }
  fs.appendFileSync(process.env.ZCODE_MOCK_METHODS_FILE, String(message.method || '') + '\n', 'utf8');
  if (message.method === 'runtime/capabilities') {
    setTimeout(() => process.stdout.write(JSON.stringify({ id: message.id, result: { independentPlanState: false } }) + '\n'), 3500);
  } else if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
  }
});
setInterval(() => {}, 1000);
`;
  writeFileSync(fakeCli, fakeSource, "utf8");
  writeFileSync(builtinConfig, "{}\n", "utf8");
  writeFileSync(personalConfig, "{}\n", "utf8");
  const mcp = new McpProcess({ env: {
    ZCODE_CLI: fakeCli,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfig,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalConfig,
    ZCODE_MOCK_PID_FILE: appPidFile,
    ZCODE_MOCK_METHODS_FILE: methodsFile,
    ZCODE_BRIDGE_RECORDS_DIR: recordsDirectory,
  } });
  let queryPending;
  let appIdentity;
  try {
    const discovered = await mcp.modernRequest("server/discover", {});
    assert(!discovered.error, "startup_eof_discover_failed");
    const listed = await mcp.modernRequest("tools/list", {});
    assert(listed.result?.tools?.length === ALL_TOOL_NAMES.length, "startup_eof_tools_list_failed");

    const startedAt = Date.now();
    const started = toolValue(await mcp.callTool("zcode_start_task", {
      workspace,
      target: "Provider-free async startup check.",
      brief: "Startup fixture only. The app-server will delay capabilities; no task should reach session/create before stdin closes.",
      writerScope: ["note.txt"],
      acceptance: ["No ZCode session is created before shutdown."],
      mode: "plan",
      timeoutSeconds: 60,
    }, 3_000), null);
    const startLatencyMs = Date.now() - startedAt;
    assert(started.status === "starting" && started.taskId, "async_task_did_not_return_starting");
    assert(startLatencyMs < 1_500, "async_start_waited_for_app_server");
    assert(await waitForFile(appPidFile), "startup_fixture_pid_missing");
    const appPid = Number(readFileSync(appPidFile, "utf8").trim());
    appIdentity = windowsProcessIdentity(appPid);
    assert(appIdentity, "startup_fixture_process_not_running");

    const report = toolValue(await mcp.callTool("zcode_task_report", { taskId: started.taskId }), null);
    assert(report.status === "starting" && report.writerLockHeld === true, "startup_task_report_mismatch");
    const cancelled = toolValue(await mcp.callTool("zcode_cancel_task", { taskId: started.taskId }), null);
    assert(cancelled.status === "cancelled" && cancelled.writerLockHeld === true, "startup_cancel_released_unsettled_lock");
    const conflict = await mcp.callTool("zcode_start_task", {
      workspace,
      target: "Conflict must remain blocked until delayed startup is settled.",
      brief: "Lock retention check.",
      writerScope: ["note.txt"],
      acceptance: ["Must be rejected while the original start is unsettled."],
      mode: "plan",
      timeoutSeconds: 60,
    });
    toolValue(conflict, "workspace_task_conflict");

    queryPending = mcp.callTool("zcode_query", { workspace })
      .then((value) => ({ value }), (error) => ({ error: error.message }));
    mcp.child.stdin.end();
    const exited = await waitForChildExit(mcp.child, 10_000);
    assert(exited, "mcp_did_not_exit_after_eof_during_startup");
    const queryOutcome = await queryPending;
    assert(queryOutcome.error, "query_unexpectedly_completed_after_eof");
    assert(await waitForPidGone(appIdentity, 5_000), "app_server_child_survived_eof_cleanup");
    const methods = existsSync(methodsFile) ? readFileSync(methodsFile, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
    assert(methods.length === 1 && methods[0] === "runtime/capabilities", "session_created_after_shutdown");
    assert(mcp.child.exitCode === 0, "mcp_eof_cleanup_nonzero_exit");
    return {
      ok: true,
      taskStartReturnedPromptly: true,
      startLatencyMs,
      startingReportQueryable: true,
      cancellationKeptLockUntilStartupSettled: true,
      sameWorkspaceConflictRejected: true,
      queryInterruptedByEof: true,
      appServerExited: true,
      sessionCreateAfterEof: false,
    };
  } finally {
    if (mcp.child.exitCode === null) {
      mcp.child.stdin.end();
      await waitForChildExit(mcp.child, 10_000);
    }
    if (appIdentity && windowsProcessIdentity(appIdentity.pid)?.creation === appIdentity.creation) {
      killCapturedPid(appIdentity);
      await waitForPidGone(appIdentity, 5_000);
    }
    const expectedPrefix = path.resolve(os.tmpdir()) + path.sep;
    const resolved = path.resolve(rootDir);
    if (resolved.toLowerCase().startsWith(expectedPrefix.toLowerCase()) &&
        path.basename(resolved).startsWith("zcode-startup-eof-smoke-")) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}

async function protocolOnly() {
  const modern = new McpProcess();
  let modernPassed = false;
  try {
    const discovery = await modern.modernRequest("server/discover", {});
    assert(!discovery.error, "modern_discover_failed");
    assert(discovery.result?.supportedVersions?.includes(MODERN_VERSION), "modern_version_missing");
    assert(discovery.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "zcode_bridge", "modern_server_info_missing");
    const unsupported = await modern.request("tools/list", {
      _meta: {
        [MODERN_META]: "2099-01-01",
        [CLIENT_CAPABILITIES_META]: {},
      },
    });
    assert(unsupported.error?.code === -32022, "unsupported_modern_version_not_rejected");
    assert(unsupported.error?.data?.supported?.includes(MODERN_VERSION), "unsupported_modern_version_missing_offer");
    const missingMetadata = await modern.request("tools/list", {});
    assert(missingMetadata.error?.code === -32602, "missing_modern_metadata_not_rejected");
    const progressTokenWithoutVersion = await modern.request("tools/list", { _meta: { progressToken: 7 } });
    assert(progressTokenWithoutVersion.error?.code === -32602, "modern_progress_token_without_version_not_rejected");
    const missingCapabilities = await modern.request("tools/list", { _meta: { [MODERN_META]: MODERN_VERSION } });
    assert(missingCapabilities.error?.code === -32602, "missing_modern_capabilities_not_rejected");
    const modernList = await modern.modernRequest("tools/list", {});
    assert(modernList.result?.tools?.map((tool) => tool.name).join(",") === ALL_TOOL_NAMES.join(","), "modern_tool_list_mismatch");
    modernPassed = true;
  } finally {
    await modern.close();
  }

  const legacy = new McpProcess();
  let legacyPassed = false;
  try {
    const initialized = await legacy.request("initialize", {
      protocolVersion: LEGACY_VERSION,
      capabilities: {},
      clientInfo: { name: "zcode-mcp-smoke", version: "1.0.0" },
    });
    assert(!initialized.error, "legacy_initialize_failed");
    assert(initialized.result?.protocolVersion === LEGACY_VERSION, "legacy_version_mismatch");
    legacy.notify("notifications/initialized");
    const legacyList = await legacy.request("tools/list");
    assert(legacyList.result?.tools?.map((tool) => tool.name).join(",") === ALL_TOOL_NAMES.join(","), "legacy_tool_list_mismatch");
    const legacyProgressList = await legacy.request("tools/list", { _meta: { progressToken: 7 } });
    assert(legacyProgressList.result?.tools?.map((tool) => tool.name).join(",") === ALL_TOOL_NAMES.join(","), "legacy_progress_token_rejected");
    legacyPassed = true;
  } finally {
    await legacy.close();
  }
  return { ok: modernPassed && legacyPassed, modernPassed, legacyPassed, tools: ALL_TOOL_NAMES };
}

function toolValue(response, expectedError) {
  if (expectedError) {
    assert(response.isError, "expected_tool_error_missing");
    if (response.value.error !== expectedError) {
      throw new SmokeCheckError("expected_" + expectedError + "_got_" + String(response.value.error || "unknown"));
    }
  } else {
    assert(!response.isError, response.value.error || "tool_failed");
  }
  return response.value;
}

async function readAllCommunication(mcp, taskId) {
  let offset = 0;
  let nextPage;
  const events = [];
  const pageRanges = [];
  do {
    const pageStart = offset;
    nextPage = toolValue(await mcp.callTool("zcode_read_task_communication", {
      taskId,
      offset,
      limit: 12,
    }), null);
    assert(nextPage.offset === offset, "communication_page_offset_mismatch");
    pageRanges.push({ start: pageStart, end: nextPage.nextOffset });
    events.push(...nextPage.events);
    offset = nextPage.nextOffset;
  } while (nextPage.hasMore);
  return { path: nextPage?.path, totalEvents: nextPage?.totalEvents, events, pageRanges };
}

function isPathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function pathsEqual(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function writeJournalFixture(directory, taskId, text) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, taskId + ".jsonl"), JSON.stringify({
    sequence: 1,
    timestamp: "2026-09-29T00:00:00.000Z",
    taskId,
    eventType: "message",
    direction: "zcode_to_parent",
    messageType: "assistant_response",
    messageId: "fixture-message-1",
    part: 1,
    parts: 1,
    text,
  }) + "\n", "utf8");
}

async function readFixtureWithMcp({ server, cwd, env, unsetEnv = [], taskId, expectedPath, expectedText }) {
  const mcp = new McpProcess({ server, cwd, env, unsetEnv });
  try {
    const page = toolValue(await mcp.callTool("zcode_read_task_communication", { taskId }), null);
    assert(page.totalEvents === 1 && page.events.length === 1, "home_resolution_fixture_record_missing");
    assert(page.events[0].text === expectedText, "home_resolution_fixture_text_mismatch");
    assert(pathsEqual(page.path, path.join(expectedPath, taskId + ".jsonl")), "home_resolution_fixture_path_mismatch");
    return page;
  } finally {
    await mcp.close();
    assert(await waitForChildExit(mcp.child, 2_000), "home_resolution_mcp_cleanup_unconfirmed");
  }
}

async function installedHomeResolutionCheck(rootDir) {
  const customHome = path.join(rootDir, "custom Codex Home with spaces");
  const installedBridgeDirectory = path.join(customHome, "tools", "zcode-bridge");
  const unrelatedCwd = path.join(rootDir, "unrelated process working directory");
  const fallbackUserHome = path.join(rootDir, "fallback user home");
  const sourceModuleUrl = pathToFileURL(path.join(ROOT, "communication-journal.mjs")).href;
  const installedJournalPath = path.join(installedBridgeDirectory, "communication-journal.mjs");
  const installedModuleUrl = pathToFileURL(installedJournalPath).href;
  const statePath = (...parts) => path.join("state", "zcode-bridge", "records", ...parts);
  const inferredRecordsDirectory = path.join(customHome, statePath());
  const explicitCodexHome = path.join(rootDir, "explicit CODEX_HOME with spaces");
  const explicitHomeRecordsDirectory = path.join(explicitCodexHome, statePath());
  const ignoredCodexHome = path.join(rootDir, "lower priority CODEX_HOME");
  const overrideRecordsDirectory = path.join(rootDir, "explicit records override");
  const cliInvocationMarker = path.join(rootDir, "unexpected-app-server-started");
  const neverLaunchCli = path.join(rootDir, "never-launch-this-cli.cjs");
  const installedTaskId = "00000000-0000-4000-8000-000000000010";
  const codexHomeTaskId = "00000000-0000-4000-8000-000000000011";
  const recordsOverrideTaskId = "00000000-0000-4000-8000-000000000012";

  mkdirSync(installedBridgeDirectory, { recursive: true });
  mkdirSync(unrelatedCwd, { recursive: true });
  const runtimeFiles = ["mcp-server.mjs", "app-server-client.mjs", "communication-journal.mjs"];
  for (const name of runtimeFiles) copyFileSync(path.join(ROOT, name), path.join(installedBridgeDirectory, name));
  writeFileSync(neverLaunchCli, "require('node:fs').writeFileSync(process.env.ZCODE_HOME_SMOKE_MARKER, 'started'); process.exit(71);\n", "utf8");
  assert(!isPathWithin(path.resolve(ROOT), path.resolve(unrelatedCwd)), "home_resolution_smoke_cwd_inside_repo");

  const sourceFallback = resolveCommunicationJournalDirectory({
    recordsDirectory: "",
    codexHome: "",
    moduleUrl: sourceModuleUrl,
    userHome: fallbackUserHome,
  });
  assert(pathsEqual(sourceFallback, path.join(fallbackUserHome, ".codex", statePath())), "source_layout_user_home_fallback_mismatch");

  const inferredPath = resolveCommunicationJournalDirectory({
    recordsDirectory: "",
    codexHome: "",
    moduleUrl: installedModuleUrl,
    userHome: fallbackUserHome,
  });
  assert(pathsEqual(inferredPath, inferredRecordsDirectory), "installed_layout_codex_home_inference_mismatch");

  const explicitHomePath = resolveCommunicationJournalDirectory({
    recordsDirectory: "",
    codexHome: explicitCodexHome,
    moduleUrl: installedModuleUrl,
    userHome: fallbackUserHome,
  });
  assert(pathsEqual(explicitHomePath, explicitHomeRecordsDirectory), "explicit_codex_home_priority_mismatch");

  const explicitRecordsPath = resolveCommunicationJournalDirectory({
    recordsDirectory: overrideRecordsDirectory,
    codexHome: explicitCodexHome,
    moduleUrl: installedModuleUrl,
    userHome: fallbackUserHome,
  });
  assert(pathsEqual(explicitRecordsPath, overrideRecordsDirectory), "explicit_records_directory_priority_mismatch");

  writeJournalFixture(inferredRecordsDirectory, installedTaskId, "Installed custom-home reader fixture.");
  writeJournalFixture(explicitHomeRecordsDirectory, codexHomeTaskId, "Explicit CODEX_HOME reader fixture.");
  writeJournalFixture(overrideRecordsDirectory, recordsOverrideTaskId, "Explicit records override fixture.");
  const baseEnv = {
    ZCODE_CLI: neverLaunchCli,
    ZCODE_HOME_SMOKE_MARKER: cliInvocationMarker,
  };

  const installedRead = await readFixtureWithMcp({
    server: path.join(installedBridgeDirectory, "mcp-server.mjs"),
    cwd: unrelatedCwd,
    env: baseEnv,
    unsetEnv: ["CODEX_HOME", "ZCODE_BRIDGE_RECORDS_DIR"],
    taskId: installedTaskId,
    expectedPath: inferredRecordsDirectory,
    expectedText: "Installed custom-home reader fixture.",
  });
  assert(pathsEqual(installedRead.path, path.join(inferredRecordsDirectory, installedTaskId + ".jsonl")), "installed_layout_runtime_reader_path_mismatch");

  await readFixtureWithMcp({
    server: path.join(installedBridgeDirectory, "mcp-server.mjs"),
    cwd: unrelatedCwd,
    env: { ...baseEnv, CODEX_HOME: explicitCodexHome },
    unsetEnv: ["ZCODE_BRIDGE_RECORDS_DIR"],
    taskId: codexHomeTaskId,
    expectedPath: explicitHomeRecordsDirectory,
    expectedText: "Explicit CODEX_HOME reader fixture.",
  });

  await readFixtureWithMcp({
    server: path.join(installedBridgeDirectory, "mcp-server.mjs"),
    cwd: unrelatedCwd,
    env: {
      ...baseEnv,
      CODEX_HOME: ignoredCodexHome,
      ZCODE_BRIDGE_RECORDS_DIR: overrideRecordsDirectory,
    },
    taskId: recordsOverrideTaskId,
    expectedPath: overrideRecordsDirectory,
    expectedText: "Explicit records override fixture.",
  });
  assert(!existsSync(cliInvocationMarker), "communication_reader_started_zcode_cli");

  return {
    installedRuntimeCopy: runtimeFiles,
    installedLayoutFallback: true,
    explicitCodexHomePriority: true,
    explicitRecordsDirectoryPriority: true,
    sourceLayoutUserHomeFallback: true,
    customHomePathWithSpaces: true,
    unrelatedCwd: true,
    appServerStarted: false,
  };
}

async function waitForAttention(mcp, taskId, maxWaitMs = 10_000) {
  const endAt = Date.now() + maxWaitMs;
  while (Date.now() < endAt) {
    const report = toolValue(await mcp.callTool("zcode_task_report", { taskId }), null);
    if (report.status === "needs_attention") return report;
    if (!["starting", "running"].includes(report.status)) {
      throw new SmokeCheckError("expected_attention_missing");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new SmokeCheckError("expected_attention_deadline_exceeded");
}

async function waitUntilTerminal(mcp, taskId, approveScratchWrite, maxWaitMs = 180_000) {
  const endAt = Date.now() + maxWaitMs;
  while (Date.now() < endAt) {
    const current = taskId
      ? toolValue(await mcp.callTool("zcode_task_report", { taskId }), null)
      : null;
    if (current && !["starting", "running", "needs_attention"].includes(current.status)) return current;
    if (current?.status === "needs_attention") {
      if (!approveScratchWrite) return current;
      for (const attention of current.pendingAttention || []) {
        if (attention.kind !== "permission" || !attention.canAllowOnce ||
            !attention.withinWriterScope || !["Write", "Edit", "MultiEdit"].includes(attention.toolName)) {
          throw new Error("scratch_permission_not_safely_approvable");
        }
        toolValue(await mcp.callTool("zcode_respond_attention", {
          taskId,
          attentionId: attention.attentionId,
          response: "allow_once",
          reason: "Explicit smoke-test authorization for the exact temporary note.txt writer scope.",
        }), null);
      }
    }
    const waited = toolValue(await mcp.callTool("zcode_wait_task", { taskId, waitSeconds: 35 }, 45_000), null);
    if (!["starting", "running", "needs_attention"].includes(waited.status)) return waited;
  }
  throw new Error("smoke_task_deadline_exceeded");
}

async function waitUntilRunning(mcp, taskId, maxWaitMs = 30_000) {
  const endAt = Date.now() + maxWaitMs;
  while (Date.now() < endAt) {
    const report = toolValue(await mcp.callTool("zcode_task_report", { taskId }), null);
    if (report.status !== "starting") return report;
    const remainingSeconds = Math.max(1, Math.min(5, Math.ceil((endAt - Date.now()) / 1000)));
    toolValue(await mcp.callTool("zcode_wait_task", { taskId, waitSeconds: remainingSeconds }, 10_000), null);
  }
  throw new SmokeCheckError("smoke_task_start_deadline_exceeded");
}

async function verifyPersistedSessionMetadata(sessionId, expectedWorkspace = null) {
  const client = await ZCodeAppServerClient.start();
  try {
    const response = await client.request("session/list", { sessionIds: [sessionId] });
    const sessions = Array.isArray(response?.sessions) ? response.sessions : [];
    assert(sessions.length === 1, "persisted_session_not_found");
    const session = sessions[0];
    const foundSessionId = session?.sessionId || session?.id || null;
    assert(foundSessionId === sessionId, "persisted_session_id_mismatch");
    const title = [session.title, session.name, session.displayTitle]
      .find((value) => typeof value === "string") || null;
    const workspacePath = session.workspace?.workspacePath || session.workspacePath || session.path || session.directory || null;
    if (expectedWorkspace) assert(workspacePath === expectedWorkspace, "persisted_session_workspace_mismatch");
    return {
      found: true,
      sessionId: foundSessionId,
      title: typeof title === "string" ? title.slice(0, 200) : null,
      workspaceMatches: expectedWorkspace ? workspacePath === expectedWorkspace : null,
    };
  } finally {
    const stopped = await client.stop();
    assert(stopped, "session_list_app_server_cleanup_unconfirmed");
  }
}

async function communicationLogCheck() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "zcode-communication-log-smoke-"));
  const workspace = path.join(rootDir, "workspace");
  const recordsDirectory = path.join(rootDir, "records");
  const fakeCli = path.join(rootDir, "mock-zcode.cjs");
  const builtinConfig = path.join(rootDir, "builtin.json");
  const personalConfig = path.join(rootDir, "personal.json");
  const createRequestsFile = path.join(rootDir, "create-requests.jsonl");
  const sentMessagesFile = path.join(rootDir, "sent-messages.jsonl");
  const badRecordsPath = path.join(rootDir, "records-is-a-file");
  const failedMethodsFile = path.join(rootDir, "failed-start-methods.jsonl");
  mkdirSync(workspace);
  writeFileSync(badRecordsPath, "not a directory\n", "utf8");
  const fakeSource = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
let createCount = 0;
let taskSessionId = null;
let taskTurn = 0;
const providerId = 'fixture-opencode-go';
const modelId = 'deepseek-v4.1-flash';
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function ok(id, result) { send({ id, result: result || {} }); }
function emitTurn(response) {
  send({ method: 'session/event', params: { event: {
    sessionId: taskSessionId,
    type: 'turn.completed',
    payload: { resultType: 'success', response, usage: { modelRequestCount: 1 } }
  } } });
}
const longReply = 'ZCODE_LOG_REPLY_V1 ' + '界🙂'.repeat(12_000) + ' api_key=fixture-long-reply-secret-123456 END_OF_LONG_REPLY';
function modelSettings() {
  return { model: {
    available: [{ providerLabel: 'OpenCode Go (Chat)', label: modelId,
      ref: { providerId, modelId }, reasoning: { levels: [{ value: 'max' }] } }],
    current: { providerId, modelId, options: { reasoningLevel: 'max' } }
  }, thoughtLevel: { current: 'max', available: [{ value: 'max' }] } };
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.exitCode = 3; return; }
  if (process.env.ZCODE_MOCK_METHODS_FILE) {
    fs.appendFileSync(process.env.ZCODE_MOCK_METHODS_FILE, String(message.method || '') + '\n', 'utf8');
  }
  if (message.method === 'runtime/capabilities') { ok(message.id, { independentPlanState: true }); return; }
  if (message.method === 'session/create') {
    createCount += 1;
    const sessionId = 'fixture-session-' + createCount;
    if (message.params.model) taskSessionId = sessionId;
    fs.appendFileSync(process.env.ZCODE_MOCK_CREATE_FILE, JSON.stringify(message.params) + '\n', 'utf8');
    ok(message.id, { sessionId, settings: modelSettings() });
    return;
  }
  if (message.method === 'session/send') {
    taskTurn += 1;
    fs.appendFileSync(process.env.ZCODE_MOCK_SENT_FILE, JSON.stringify({
      sessionId: message.params.sessionId,
      content: message.params.content,
      modelSelection: message.params.modelSelection
    }) + '\n', 'utf8');
    ok(message.id, { accepted: true });
    if (taskTurn === 1) {
      setTimeout(() => send({
        id: 'fixture-permission-request',
        method: 'interaction/requestPermission',
        params: {
          sessionId: taskSessionId,
          toolName: 'Write',
          riskLevel: 'low',
          reason: 'Write the declared note; api_key=fixture-permission-secret-123456',
          input: { path: process.env.ZCODE_MOCK_NOTE_PATH },
          options: [{ kind: 'allow_once', optionId: 'fixture-allow', response: { decision: 'allow' } }]
        }
      }), 25);
    } else {
      setTimeout(() => emitTurn('ZCODE_LOG_REPLY_V2'), 25);
    }
    return;
  }
  if (message.id === 'fixture-permission-request' && message.result) {
    fs.appendFileSync(process.env.ZCODE_MOCK_SENT_FILE, JSON.stringify({ permissionResponse: message.result }) + '\n', 'utf8');
    setTimeout(() => emitTurn(longReply), 25);
    return;
  }
  if (message.method === 'session/subscribe' || message.method === 'session/close' || message.method === 'session/stop') {
    ok(message.id, {});
    return;
  }
  if (message.id !== undefined) ok(message.id, {});
});
setInterval(() => {}, 1000);
`;
  writeFileSync(fakeCli, fakeSource, "utf8");
  writeFileSync(builtinConfig, "{}\n", "utf8");
  writeFileSync(personalConfig, "{}\n", "utf8");
  const commonEnv = {
    ZCODE_CLI: fakeCli,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfig,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalConfig,
    ZCODE_MOCK_CREATE_FILE: createRequestsFile,
    ZCODE_MOCK_SENT_FILE: sentMessagesFile,
    ZCODE_MOCK_NOTE_PATH: path.join(workspace, "note.txt"),
  };
  let mcp;
  let restarted;
  let failing;
  try {
    const insideWorkspaceId = "00000000-0000-4000-8000-000000000001";
    let boundaryCategory = null;
    const blockedWorkspaceSubdirectory = path.join(workspace, "should-not-be-created");
    try {
      TaskCommunicationJournal.create({
        taskId: insideWorkspaceId,
        workspace,
        directory: path.join(blockedWorkspaceSubdirectory, "records"),
      });
    } catch (error) {
      boundaryCategory = error?.category;
    }
    assert(boundaryCategory === "communication_log_inside_workspace", "journal_workspace_boundary_not_enforced");
    assert(!existsSync(blockedWorkspaceSubdirectory), "journal_workspace_boundary_created_parent");

    mcp = new McpProcess({ env: { ...commonEnv, ZCODE_BRIDGE_RECORDS_DIR: recordsDirectory } });
    const discovered = await mcp.modernRequest("server/discover", {});
    assert(!discovered.error, "communication_log_discover_failed");
    const listed = await mcp.modernRequest("tools/list", {});
    assert(listed.result?.tools?.length === ALL_TOOL_NAMES.length, "communication_log_tools_list_failed");

    const started = toolValue(await mcp.callTool("zcode_start_task", {
      workspace,
      target: "Persistent journal two-turn fixture.",
      brief: "Provider-free smoke only. Redact api_key=fixture-parent-secret-123456 from the saved transcript.",
      writerScope: ["note.txt"],
      acceptance: ["The provider-free fixture returns two distinct assistant messages."],
      mode: "edit",
      timeoutSeconds: 120,
    }), null);
    assert(started.status === "starting" && started.taskId, "communication_log_task_not_started");
    const attention = await waitForAttention(mcp, started.taskId);
    assert(attention.pendingAttention?.[0]?.kind === "permission", "communication_log_permission_missing");
    assert(attention.pendingAttention[0].canAllowOnce, "communication_log_fixture_permission_not_scoped");
    const attentionId = attention.pendingAttention[0].attentionId;
    toolValue(await mcp.callTool("zcode_respond_attention", {
      taskId: started.taskId,
      attentionId,
      response: "allow_once",
      reason: "Provider-free fixture approval for the declared note.txt scope.",
    }), null);

    const first = await waitUntilTerminal(mcp, started.taskId, false, 10_000);
    assert(first.status === "completed" && first.turnNumber === 1, "communication_log_first_turn_failed");
    const beforeContinue = await readAllCommunication(mcp, started.taskId);
    assert(beforeContinue.events.some((entry) => entry.eventType === "attention_requested"), "permission_request_missing_from_log");
    assert(beforeContinue.events.some((entry) => entry.eventType === "attention_response_sent"), "permission_response_missing_from_log");
    const firstReplyParts = beforeContinue.events.filter((entry) => entry.messageType === "assistant_response" &&
      entry.direction === "zcode_to_parent" && entry.turnNumber === 1);
    assert(firstReplyParts.length > 12, "communication_log_long_reply_not_chunked");
    assert(firstReplyParts.every((entry) => entry.messageId === firstReplyParts[0].messageId &&
      entry.parts === firstReplyParts.length), "communication_log_long_reply_message_id_mismatch");
    const orderedReplyParts = [...firstReplyParts].sort((left, right) => left.part - right.part);
    assert(orderedReplyParts.every((entry, index) => entry.part === index + 1), "communication_log_long_reply_part_sequence_mismatch");
    const expectedLongReply = "ZCODE_LOG_REPLY_V1 " + "界🙂".repeat(12_000) + " api_key=[redacted] END_OF_LONG_REPLY";
    const reconstructedLongReply = orderedReplyParts.map((entry) => entry.text).join("");
    assert(reconstructedLongReply === expectedLongReply, "communication_log_long_reply_reassembly_mismatch");
    assert(reconstructedLongReply.endsWith(" END_OF_LONG_REPLY"), "communication_log_long_reply_tail_lost");
    assert(beforeContinue.pageRanges.length > 1 && firstReplyParts.some((entry) => {
      const eventIndex = beforeContinue.events.indexOf(entry);
      return beforeContinue.pageRanges.some((range) => range.start === eventIndex && range.start > 0);
    }), "communication_log_long_reply_did_not_cross_pages");
    assert(typeof first.responseSummary === "string" && first.responseSummary.length === 10_000 &&
      first.responseSummary === expectedLongReply.slice(0, 10_000), "communication_log_response_summary_limit_mismatch");

    const continued = toolValue(await mcp.callTool("zcode_continue_task", {
      taskId: started.taskId,
      followUp: "Follow-up marker for the second turn.",
      timeoutSeconds: 120,
    }), null);
    assert(continued.turnNumber === 2 && continued.status === "running", "communication_log_followup_not_started");
    const second = await waitUntilTerminal(mcp, started.taskId, false, 10_000);
    assert(second.status === "completed" && second.turnNumber === 2, "communication_log_second_turn_failed");
    assert(second.sessionId === first.sessionId, "communication_log_session_id_changed");
    const completed = await readAllCommunication(mcp, started.taskId);
    assert(completed.events.length > beforeContinue.events.length, "communication_log_followup_did_not_append");
    assert(JSON.stringify(completed.events.slice(0, beforeContinue.events.length)) === JSON.stringify(beforeContinue.events), "communication_log_old_round_was_overwritten");
    assert(completed.events.some((entry) => entry.messageType === "assistant_response" && entry.text.includes("ZCODE_LOG_REPLY_V2")), "second_reply_missing_from_log");

    const sequenceIsContinuous = completed.events.every((entry, index) => entry.sequence === index + 1);
    assert(sequenceIsContinuous, "communication_log_sequence_gap");
    assert(completed.events.every((entry) => entry.taskId === started.taskId && entry.workspace === workspace &&
      typeof entry.timestamp === "string" && entry.model?.providerLabel === "OpenCode Go (Chat)" &&
      entry.model?.modelId === "deepseek-v4.1-flash" && entry.model?.reasoningLevel === "max"), "communication_log_metadata_mismatch");
    const transcript = JSON.stringify(completed.events);
    for (const secret of [
      "fixture-parent-secret-123456",
      "fixture-permission-secret-123456",
      "fixture-reply-secret-123456",
      "fixture-long-reply-secret-123456",
    ]) assert(!transcript.includes(secret), "communication_log_secret_not_redacted");
    assert(transcript.includes("[redacted]"), "communication_log_redaction_marker_missing");
    const sentMessages = readFileSync(sentMessagesFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const actualSends = sentMessages.filter((entry) => typeof entry.content === "string");
    assert(actualSends.length === 2, "communication_log_fake_send_count_mismatch");
    assert(actualSends[0].content.startsWith("Codex 委派任务 " + started.taskId + "："), "initial_delegation_title_prefix_missing");
    assert(actualSends[1].content.includes("Same-session follow-up for turn 2:"), "followup_turn_marker_mismatch");
    const createRequests = readFileSync(createRequestsFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const taskCreate = createRequests.find((entry) => entry.model);
    assert(taskCreate?.persistence === "immediate" && taskCreate?.titleGenerationEnabled === false, "persistent_session_creation_options_mismatch");
    assert(taskCreate?.model?.modelId === "deepseek-v4.1-flash" && taskCreate?.model?.options?.reasoningLevel === "max", "persistent_session_model_mismatch");
    assert(path.dirname(completed.path) === recordsDirectory && !completed.path.startsWith(workspace), "communication_log_path_boundary_mismatch");

    const escaped = await mcp.callTool("zcode_read_task_communication", { taskId: "../" + started.taskId });
    toolValue(escaped, "invalid_task_id");
    await mcp.close();
    assert(await waitForChildExit(mcp.child, 2_000), "communication_log_mcp_exit_missing");
    mcp = null;

    restarted = new McpProcess({ env: { ZCODE_BRIDGE_RECORDS_DIR: recordsDirectory } });
    const lostTaskState = await restarted.callTool("zcode_task_report", { taskId: started.taskId });
    toolValue(lostTaskState, "task_not_found");
    const afterRestart = await readAllCommunication(restarted, started.taskId);
    assert(JSON.stringify(afterRestart.events) === JSON.stringify(completed.events), "communication_log_restart_readback_mismatch");

    failing = new McpProcess({ env: { ...commonEnv, ZCODE_BRIDGE_RECORDS_DIR: badRecordsPath, ZCODE_MOCK_METHODS_FILE: failedMethodsFile } });
    const failedStart = await failing.callTool("zcode_start_task", {
      workspace,
      target: "This task must fail before opening ZCode when its communication log cannot be created.",
      brief: "Explicit log-write failure check.",
      writerScope: ["note.txt"],
      acceptance: ["The tool returns the communication log directory failure."],
      mode: "plan",
      timeoutSeconds: 60,
    });
    toolValue(failedStart, "communication_log_directory_invalid");
    assert(!existsSync(failedMethodsFile), "zcode_started_after_communication_log_failure");
    const homeResolution = await installedHomeResolutionCheck(rootDir);

    return {
      ok: true,
      providerRequestCount: 0,
      twoTurnsRecorded: true,
      permissionRoundTripRecorded: true,
      longReplyReassembledAcrossPages: true,
      responseSummaryStillBounded: true,
      sequenceIsContinuous,
      oldRoundPreserved: true,
      restartReadable: true,
      taskRecoveryAfterRestart: false,
      credentialsRedacted: true,
      taskWorkspaceExcludedFromLogPath: true,
      invalidPathRejected: true,
      logFailureExplicit: true,
      homeResolution,
      logPath: completed.path,
      eventCount: completed.totalEvents,
      sessionId: first.sessionId,
    };
  } finally {
    for (const child of [mcp, restarted, failing]) {
      if (child?.child.exitCode === null) {
        await child.close();
        await waitForChildExit(child.child, 5_000);
      }
    }
    const expectedPrefix = path.resolve(os.tmpdir()) + path.sep;
    const resolved = path.resolve(rootDir);
    if (!resolved.toLowerCase().startsWith(expectedPrefix.toLowerCase()) ||
        !path.basename(resolved).startsWith("zcode-communication-log-smoke-")) {
      throw new Error("communication_log_cleanup_target_invalid");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
}

async function scratchTask(approveScratchWrite) {
  const baseline = countZCodeChildren();
  const workspace = mkdtempSync(path.join(os.tmpdir(), "zcode-mcp-smoke-"));
  const recordsDirectory = mkdtempSync(path.join(os.tmpdir(), "zcode-mcp-records-"));
  const notePath = path.join(workspace, "note.txt");
  writeFileSync(path.join(workspace, "AGENTS.md"),
    "For this temporary smoke test, follow the task's exact writer scope and do not alter any other file.\n",
    "utf8");
  const mcp = new McpProcess({ env: { ZCODE_BRIDGE_RECORDS_DIR: recordsDirectory } });
  let result;
  let serverExited = false;
  try {
    const discovery = await mcp.modernRequest("server/discover", {});
    assert(!discovery.error, "modern_discover_failed");
    const list = await mcp.modernRequest("tools/list", {});
    assert(list.result?.tools?.length === ALL_TOOL_NAMES.length, "modern_tool_list_failed");

    const query = toolValue(await mcp.callTool("zcode_query", { workspace }), null);
    assert(query.connected === true, "zcode_connection_not_ready");
    assert(query.target?.providerLabel === "OpenCode Go (Chat)", "provider_mismatch");
    assert(query.target?.modelId === "deepseek-v4.1-flash", "model_mismatch");
    assert(query.reasoningLevel === "max", "reasoning_mismatch");

    const task = toolValue(await mcp.callTool("zcode_start_task", {
      workspace,
      target: "Create note.txt with exactly the line ZCODE_MCP_SMOKE_V1.",
      brief: "Use the ZCode file-writing tool to create only note.txt in the declared scope. Do not run shell commands or access the network. Report the exact changed path and acceptance result.",
      writerScope: ["note.txt"],
      acceptance: ["Manual check: note.txt contains exactly ZCODE_MCP_SMOKE_V1 and no other task-created file exists."],
      mode: "edit",
      timeoutSeconds: 300,
    }, 40_000), null);
    assert(task.taskId && task.status === "starting", "task_start_did_not_return_promptly");

    const conflict = await mcp.callTool("zcode_start_task", {
      workspace,
      target: "This conflicting task must not start.",
      brief: "Conflict rejection check.",
      writerScope: ["note.txt"],
      acceptance: ["Must be rejected."],
      mode: "edit",
      timeoutSeconds: 300,
    });
    toolValue(conflict, "workspace_task_conflict");

    const first = await waitUntilTerminal(mcp, task.taskId, approveScratchWrite);
    assert(first.status === "completed", "first_turn_not_completed_" + first.status);
    assert(readFileSync(notePath, "utf8").trim() === MARKER_V1, "first_note_content_mismatch");

    const followUp = toolValue(await mcp.callTool("zcode_continue_task", {
      taskId: task.taskId,
      followUp: "Replace the entire contents of note.txt with exactly ZCODE_MCP_SMOKE_V2. Do not change any other file, and report the same-session correction.",
      timeoutSeconds: 300,
    }, 40_000), null);
    assert(followUp.status === "running" && followUp.turnNumber === 2, "same_session_followup_not_started");
    const second = await waitUntilTerminal(mcp, task.taskId, approveScratchWrite);
    assert(second.status === "completed", "second_turn_not_completed_" + second.status);
    assert(second.sessionId === first.sessionId, "same_session_id_not_retained");
    assert(readFileSync(notePath, "utf8").trim() === MARKER_V2, "second_note_content_mismatch");

    const communication = await readAllCommunication(mcp, task.taskId);
    assert(communication.events.length === communication.totalEvents, "communication_log_page_count_mismatch");
    assert(communication.events.some((entry) => entry.messageType === "assistant_response" && entry.text.includes(MARKER_V1)), "first_turn_reply_missing_from_log");
    assert(communication.events.some((entry) => entry.messageType === "assistant_response" && entry.text.includes(MARKER_V2)), "second_turn_reply_missing_from_log");
    assert(communication.events.some((entry) => entry.messageType === "follow_up_instruction" && entry.turnNumber === 2 && entry.text.includes("Same-session follow-up for turn 2:")), "followup_turn_marker_mismatch");
    const sessionMetadata = await verifyPersistedSessionMetadata(first.sessionId, workspace);

    const cancelStart = toolValue(await mcp.callTool("zcode_start_task", {
      workspace,
      target: "Prepare a short implementation plan for a fictional feature and wait for review.",
      brief: "Plan mode only. Do not edit files, run commands, or access the network. This turn will be cancelled by the smoke harness.",
      writerScope: ["cancel-plan.txt"],
      acceptance: ["No files are changed."],
      mode: "plan",
      timeoutSeconds: 300,
    }, 40_000), null);
    const cancelRunning = await waitUntilRunning(mcp, cancelStart.taskId);
    assert(cancelRunning.status === "running" || cancelRunning.status === "needs_attention", "cancel_task_never_started");
    const cancelled = toolValue(await mcp.callTool("zcode_cancel_task", { taskId: cancelStart.taskId }, 20_000), null);
    assert(cancelled.status === "cancelled", "cancel_not_confirmed_" + cancelled.status);
    result = {
      ok: true,
      modernProtocol: true,
      exactTarget: { provider: query.target.providerLabel, model: query.target.modelId, reasoningLevel: query.reasoningLevel },
      firstTurn: first.status,
      sameSessionTurn: second.turnNumber + ":" + second.status,
      sessionId: first.sessionId,
      sessionList: sessionMetadata,
      communicationLogPath: communication.path,
      communicationEvents: communication.totalEvents,
      conflictRejected: true,
      cancelStatus: cancelled.status,
      noteContents: [MARKER_V1, MARKER_V2],
      workspaceCleaned: true,
    };
  } finally {
    await mcp.close();
    serverExited = await waitForChildExit(mcp.child, 2_000);
    if (baseline !== null) {
      let after = countZCodeChildren();
      for (let retry = 0; after !== baseline && retry < 8; retry += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        after = countZCodeChildren();
      }
      if (after !== baseline) {
        throw new Error("zcode_app_server_process_not_cleaned");
      }
    }
    if (!serverExited && process.platform === "win32" && mcp.child.pid) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(mcp.child.pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 8_000,
          stdio: "ignore",
        });
      } catch { /* The child may have exited between the check and taskkill. */ }
      throw new Error("mcp_server_exit_timeout");
    }
    const expectedPrefix = path.resolve(os.tmpdir()) + path.sep;
    const resolvedWorkspace = path.resolve(workspace);
    if (!resolvedWorkspace.toLowerCase().startsWith(expectedPrefix.toLowerCase()) ||
        path.basename(resolvedWorkspace).toLowerCase().startsWith("zcode-mcp-smoke-") !== true) {
      throw new Error("scratch_cleanup_target_invalid");
    }
    rmSync(resolvedWorkspace, { recursive: true, force: true });
    const resolvedRecords = path.resolve(recordsDirectory);
    if (!resolvedRecords.toLowerCase().startsWith(expectedPrefix.toLowerCase()) ||
        path.basename(resolvedRecords).toLowerCase().startsWith("zcode-mcp-records-") !== true) {
      throw new Error("communication_cleanup_target_invalid");
    }
    rmSync(resolvedRecords, { recursive: true, force: true });
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
    return 0;
  }
  if (options.mode === "--protocol-only") {
    const result = await protocolOnly();
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 1;
  }
  if (options.mode === "--process-cleanup") {
    const result = await processCleanupCheck();
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 1;
  }
  if (options.mode === "--startup-eof") {
    const result = await startupEofCheck();
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 1;
  }
  if (options.mode === "--communication-log") {
    const result = await communicationLogCheck();
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 1;
  }
  const result = await scratchTask(options.approveScratchWrite);
  process.stdout.write(JSON.stringify(result) + "\n");
  return result.ok ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const category = /^[a-z0-9_:-]{1,100}$/i.test(error?.category || "")
    ? error.category
    : /^[a-z0-9_]{2,40}$/i.test(error?.code || "")
      ? "runtime_" + String(error.code).toLowerCase()
      : /^[a-z0-9_]{2,40}$/i.test(error?.name || "")
        ? "unexpected_" + String(error.name).toLowerCase()
        : "smoke_failed";
  process.stderr.write("zcode-mcp-smoke: " + category + "\n");
  process.exitCode = 1;
});
