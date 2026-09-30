import { spawn, execFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNTIME_PREFERENCES = Object.freeze({
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false,
});
const terminatingTrees = new WeakMap();

export class ZCodeAppServerError extends Error {
  constructor(category, code = undefined) {
    super(category);
    this.name = "ZCodeAppServerError";
    this.category = category;
    this.code = code;
  }
}

function runPowerShellJson(script) {
  try {
    const output = execFileSync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

function snapshotWindowsProcessTree(rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) return null;
  const script = [
    "$ErrorActionPreference='Stop'",
    `$rootPid=${rootPid}`,
    "$processes=@(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$root=@($processes | Where-Object { [int]$_.ProcessId -eq $rootPid })",
    "if ($root.Count -eq 0) { '[]'; exit 0 }",
    "$ids=@{}; $ids[[string]$rootPid]=$true",
    "do { $changed=$false; foreach ($process in $processes) { $parent=[string][int]$process.ParentProcessId; $id=[string][int]$process.ProcessId; if ($ids.ContainsKey($parent) -and -not $ids.ContainsKey($id)) { $ids[$id]=$true; $changed=$true } } } while ($changed)",
    "$rows=@($processes | Where-Object { $ids.ContainsKey([string][int]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; creation=[string]$_.CreationDate } })",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("; ");
  const rows = runPowerShellJson(script);
  if (!rows || rows.some((row) => !Number.isSafeInteger(row?.pid) || typeof row.creation !== "string" || !row.creation)) {
    return null;
  }
  return rows;
}

function snapshotWindowsPids(pids) {
  const unique = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (!unique.length) return [];
  const script = [
    "$ErrorActionPreference='Stop'",
    `$wanted=@(${unique.join(",")})`,
    "$rows=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $wanted -contains [int]$_.ProcessId } | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; creation=[string]$_.CreationDate } })",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("; ");
  const rows = runPowerShellJson(script);
  if (!rows || rows.some((row) => !Number.isSafeInteger(row?.pid) || typeof row.creation !== "string" || !row.creation)) {
    return null;
  }
  return rows;
}

function sameProcessIdentity(expected, actual) {
  return expected.pid === actual.pid && expected.creation === actual.creation;
}

function taskkill(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5_000,
      windowsVerbatimArguments: false,
    }, (error) => resolve(!error));
  });
}

async function waitForWindowsTreeExit(processes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = snapshotWindowsPids(processes.map((entry) => entry.pid));
    if (!current) return false;
    const remaining = processes.some((expected) => current.some((actual) => sameProcessIdentity(expected, actual)));
    if (!remaining) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function resolveZCodePaths(options = {}) {
  const configuredCliPath = options.cliPath ?? process.env.ZCODE_CLI;
  if (typeof configuredCliPath !== "string" || !configuredCliPath.trim()) {
    throw new ZCodeAppServerError("zcode_cli_not_configured");
  }
  const cliPath = path.resolve(configuredCliPath.trim());
  const cliDir = path.dirname(cliPath);
  const builtinCandidates = [
    path.join(cliDir, "provider", "zcode-builtin.json"),
    path.resolve(cliDir, "../config/provider/zcode-builtin.json"),
    path.resolve(cliDir, "../../../../../config/provider/zcode-builtin.json"),
  ];
  const paths = {
    nodePath: path.resolve(options.nodePath || process.env.ZCODE_NODE || process.execPath),
    cliPath,
    builtinConfigPath: path.resolve(
      options.builtinConfigPath ||
        process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ||
        builtinCandidates.find((candidate) => existsSync(candidate)) ||
        builtinCandidates[0],
    ),
    personalConfigPath: path.resolve(
      options.personalConfigPath ||
        process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||
        path.join(os.homedir(), ".zcode", "v2", "provider_config.json"),
    ),
  };

  if (!existsSync(paths.nodePath)) throw new ZCodeAppServerError("node_missing");
  if (!existsSync(paths.cliPath)) throw new ZCodeAppServerError("cli_missing");
  if (!existsSync(paths.builtinConfigPath)) throw new ZCodeAppServerError("builtin_config_missing");
  if (!existsSync(paths.personalConfigPath)) throw new ZCodeAppServerError("personal_config_missing");
  return paths;
}

export function terminateProcessTree(child, graceMs = 900) {
  if (!child) return Promise.resolve(true);
  const current = terminatingTrees.get(child);
  if (current) return current;
  let operation;
  operation = terminateProcessTreeOnce(child, graceMs).finally(() => {
    if (terminatingTrees.get(child) === operation) terminatingTrees.delete(child);
  });
  terminatingTrees.set(child, operation);
  return operation;
}

async function terminateProcessTreeOnce(child, graceMs) {
  if (process.platform === "win32" && child.pid) {
    // Once Node reports exit, the numeric PID may already identify another
    // process. Its current tree can no longer be attributed to this child.
    if (child.exitCode !== null || child.signalCode !== null) return false;
    // Capture exact process identities before killing the root. taskkill /T runs
    // while the owned root is alive; any fallback targets only these captured PIDs.
    const tree = snapshotWindowsProcessTree(child.pid);
    if (!tree) {
      await taskkill(child.pid);
      return false;
    }
    if (!tree.length) return child.exitCode !== null || child.signalCode !== null;
    const descendants = tree.filter((entry) => entry.pid !== child.pid).reverse();
    const rootKillSucceeded = await taskkill(child.pid);
    let stopped = await waitForWindowsTreeExit(tree, Math.max(graceMs, 1_000));
    if (!rootKillSucceeded || !stopped) {
      const current = snapshotWindowsPids(tree.map((entry) => entry.pid));
      if (!current) return false;
      for (const entry of descendants) {
        if (!current.some((candidate) => sameProcessIdentity(entry, candidate))) continue;
        await taskkill(entry.pid);
      }
      const root = tree.find((entry) => entry.pid === child.pid);
      const latest = snapshotWindowsPids(tree.map((entry) => entry.pid));
      if (root && latest?.some((candidate) => sameProcessIdentity(root, candidate))) {
        await taskkill(root.pid);
      }
      stopped = await waitForWindowsTreeExit(tree, Math.max(graceMs, 1_000));
    }
    const rootExited = await waitForExit(child, Math.max(graceMs, 1_000));
    return stopped && rootExited;
  }
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill();
  const stopped = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), graceMs);
    child.once("exit", onExit);
  });
  if (stopped || child.exitCode !== null || child.signalCode !== null) return true;
  if (!child.pid) {
    child.kill("SIGKILL");
    return false;
  }
  child.kill("SIGKILL");
  return await waitForExit(child, Math.max(graceMs, 1_000));
}

export class ZCodeAppServerClient extends EventEmitter {
  static async start(options = {}) {
    if (options.signal?.aborted) throw new ZCodeAppServerError("client_start_aborted");
    const paths = resolveZCodePaths(options);
    const childEnv = {
      ...process.env,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: paths.builtinConfigPath,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: paths.personalConfigPath,
      NO_COLOR: "1",
    };
    const child = spawn(paths.nodePath, [paths.cliPath, "app-server", "--stdio"], {
      cwd: os.tmpdir(),
      env: childEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new ZCodeAppServerClient(child, options.rpcTimeoutMs || 15_000);
    const onAbort = () => { void client.stop(); };
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const capabilities = await client.request("runtime/capabilities", {}, options.startupTimeoutMs || 25_000);
      if (options.signal?.aborted) throw new ZCodeAppServerError("client_start_aborted");
      client.capabilities = {
        independentPlanState: typeof capabilities?.independentPlanState === "boolean"
          ? capabilities.independentPlanState
          : null,
      };
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  constructor(child, rpcTimeoutMs) {
    super();
    this.child = child;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.stderrTail = "";
    this.stderrCategory = "unknown";
    this.closed = false;
    this.failure = null;
    this.capabilities = null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => this.onStderr(chunk));
    child.on("error", (error) => this.fail(error.code ? "spawn_error" : "process_error"));
    child.on("exit", (code, signal) => {
      this.closed = true;
      this.fail("process_exit");
      this.emit("exit", { code, signal });
    });
  }

  onStderr(chunk) {
    const candidate = `${this.stderrTail}${chunk}`;
    this.stderrTail = candidate.slice(-512);
    this.stderrCategory = classifyText(candidate);
  }

  fail(category) {
    if (this.failure) return;
    this.failure = category;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ZCodeAppServerError(category));
    }
    this.pending.clear();
    this.emit("failure", category);
  }

  onStdout(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.fail("protocol_line_too_large");
      void terminateProcessTree(this.child);
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
    }
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail("invalid_protocol_json");
      void terminateProcessTree(this.child);
      return;
    }

    if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
      this.onServerRequest(message);
      return;
    }
    if (typeof message.method === "string") {
      this.emit("notification", message);
      if (message.method === "session/event") this.emit("sessionEvent", unpackSessionEvent(message));
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new ZCodeAppServerError(
        classifyText(message.error.message),
        Number.isInteger(message.error.code) ? message.error.code : undefined,
      ));
    } else {
      entry.resolve(message.result);
    }
  }

  onServerRequest(message) {
    if (this.serverRequests.has(message.id)) return;
    const request = { id: message.id, method: message.method, params: message.params || {} };
    this.serverRequests.set(message.id, request);
    if (message.method === "session/requestRuntimePreferences") {
      this.respondServerRequest(message.id, RUNTIME_PREFERENCES);
      return;
    }
    this.emit("serverRequest", request);
  }

  respondServerRequest(id, result) {
    if (!this.serverRequests.has(id) || this.closed) return false;
    this.serverRequests.delete(id);
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
    return true;
  }

  respondServerError(id, code, message) {
    if (!this.serverRequests.has(id) || this.closed) return false;
    this.serverRequests.delete(id);
    this.child.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
    return true;
  }

  request(method, params = {}, timeoutMs = this.rpcTimeoutMs) {
    if (this.closed || this.failure) {
      return Promise.reject(new ZCodeAppServerError(this.failure || "process_closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ZCodeAppServerError("rpc_timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new ZCodeAppServerError("stdin_closed"));
        }
      });
    });
  }

  async stop() {
    if (process.platform === "win32") return await terminateProcessTree(this.child);
    if (this.closed || this.child.exitCode !== null || this.child.signalCode !== null) return true;
    try { this.child.stdin.end(); } catch { /* Process cleanup below is authoritative. */ }
    const exited = await waitForExit(this.child, 1_500);
    if (exited) return true;
    const killed = await terminateProcessTree(this.child);
    await waitForExit(this.child, 1_500);
    return killed;
  }
}

export function getSessionId(result) {
  return result?.session?.sessionId || result?.sessionId || null;
}

export function getSessionSettings(result) {
  return result?.settings || result?.session?.settings || {};
}

export function unpackSessionEvent(message) {
  const outer = message?.params || {};
  const event = outer.event || outer;
  return {
    sessionId: typeof event.sessionId === "string" ? event.sessionId : null,
    type: typeof event.type === "string" ? event.type : event.eventType,
    payload: event.payload && typeof event.payload === "object" ? event.payload : event,
  };
}

export function findTargetModel(settings) {
  const available = Array.isArray(settings?.model?.available) ? settings.model.available : [];
  return available.find((entry) =>
    entry?.providerLabel === "OpenCode Go (Chat)" && entry?.ref?.modelId === "deepseek-v4.1-flash",
  ) || null;
}

export function targetMetadata(entry) {
  return {
    providerId: entry?.ref?.providerId || null,
    providerLabel: entry?.providerLabel || null,
    modelId: entry?.ref?.modelId || null,
    modelLabel: entry?.label || null,
    disabled: Boolean(entry?.disabledReason),
    availableEfforts: Array.isArray(entry?.reasoning?.levels)
      ? entry.reasoning.levels.map((level) => level.value).filter((value) => typeof value === "string")
      : [],
  };
}

export function selectionMatches(settings, providerId) {
  const current = settings?.model?.current;
  const levels = Array.isArray(settings?.thoughtLevel?.available)
    ? settings.thoughtLevel.available.map((level) => level.value)
    : [];
  return Boolean(
    current &&
    current.providerId === providerId &&
    current.modelId === "deepseek-v4.1-flash" &&
    current.options?.reasoningLevel === "max" &&
    settings?.thoughtLevel?.current === "max" &&
    levels.includes("max"),
  );
}

function classifyText(text) {
  const normalized = String(text || "").toLowerCase();
  if (normalized.includes("zcode built-in") && normalized.includes("personal provider config")) {
    return "provider_config_paths_required";
  }
  if (normalized.includes("model config is missing")) return "model_config_missing";
  if (normalized.includes("select a model before continuing")) return "model_selection_missing";
  if (normalized.includes("provider registry") && normalized.includes("model")) return "model_unavailable";
  if (/unauthori[sz]ed|authentication|credential|api.?key|token expired/.test(normalized)) {
    return "authentication";
  }
  return "protocol_error";
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}
