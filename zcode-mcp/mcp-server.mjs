#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  getCommunicationJournalDirectory,
  readTaskCommunicationPage,
  redactCommunicationText,
  TaskCommunicationJournal,
} from "./communication-journal.mjs";
import {
  findTargetModel,
  getSessionId,
  getSessionSettings,
  selectionMatches,
  targetMetadata,
  ZCodeAppServerClient,
  ZCodeAppServerError,
} from "./app-server-client.mjs";

const SERVER_NAME = "zcode_bridge";
const SERVER_VERSION = "0.3.0";
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";
const SUPPORTED_VERSIONS = [MODERN_VERSION, LEGACY_VERSION];
const MODERN_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const TARGET_EFFORT = "max";
const ACTIVE_STATES = new Set(["starting", "running", "needs_attention"]);
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TASKS = 32;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

const INSTRUCTIONS =
  "Use an absolute workspace path. ZCode always uses OpenCode Go (Chat), " +
  "deepseek-v4.1-flash, and max reasoning. Start a task with its exact target, " +
  "sole-writer paths, and acceptance commands; the task stays uncommitted. " +
  "Wait or read its report by taskId. Read saved communication pages with " +
  "zcode_read_task_communication, including after an MCP restart. " +
  "Same-workspace active tasks are refused. " +
  "Permission and user-input requests pause as needs_attention; no request is " +
  "approved automatically. Task execution recovery across MCP restarts is not supported.";

const tools = [
  {
    name: "zcode_query",
    title: "Check ZCode connection",
    description: "Check app-server availability and the exact fixed provider, model, and max reasoning in a temporary session.",
    inputSchema: objectSchema({
      workspace: stringSchema("Existing absolute directory used only for the temporary query session."),
    }, ["workspace"]),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "zcode_start_task",
    title: "Start ZCode development task",
    description: "Start an asynchronous task in the stated workspace. Include a precise target, one writer scope, and acceptance commands. The ZCode session is persisted and the communication log is available in the task report. ZCode permission checks stay enabled; this tool never commits.",
    inputSchema: objectSchema({
      workspace: stringSchema("Existing absolute workspace directory."),
      target: stringSchema("Concrete task goal.", 1, 2000),
      brief: stringSchema("Relevant context, requirements, and completion boundary.", 1, 12000),
      writerScope: { type: "array", minItems: 1, maxItems: 100, items: stringSchema("Workspace-relative file or directory path.", 1, 512) },
      acceptance: { type: "array", minItems: 1, maxItems: 30, items: stringSchema("Exact validation command or manual check.", 1, 1000) },
      mode: { type: "string", enum: ["plan", "edit"], description: "ZCode plan or edit mode; defaults to edit." },
      timeoutSeconds: { type: "integer", minimum: 60, maximum: 7200, description: "Turn deadline; defaults to 1800 seconds." },
    }, ["workspace", "target", "brief", "writerScope", "acceptance"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "zcode_wait_task",
    title: "Wait for ZCode task",
    description: "Wait once for a task state change for at most 45 seconds; call again if it is still running.",
    inputSchema: objectSchema({
      taskId: stringSchema("ID returned by zcode_start_task."),
      waitSeconds: { type: "integer", minimum: 0, maximum: 45, description: "Wait duration; defaults to 30 seconds." },
    }, ["taskId"]),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "zcode_task_report",
    title: "Read ZCode task report",
    description: "Read task status, selected model metadata, the saved ZCode session ID, communication-log path, pending attention, and final response summary.",
    inputSchema: objectSchema({
      taskId: stringSchema("ID returned by zcode_start_task."),
    }, ["taskId"]),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "zcode_continue_task",
    title: "Continue ZCode task",
    description: "Send a follow-up in the same still-live ZCode session after a terminal turn. The original workspace, writer scope, model, and max effort remain fixed.",
    inputSchema: objectSchema({
      taskId: stringSchema("ID returned by zcode_start_task."),
      followUp: stringSchema("Specific correction or next instruction within the original writer scope.", 1, 12000),
      timeoutSeconds: { type: "integer", minimum: 60, maximum: 7200, description: "Turn deadline; defaults to 1800 seconds." },
    }, ["taskId", "followUp"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "zcode_cancel_task",
    title: "Cancel ZCode task",
    description: "Ask ZCode to stop this task's current turn. The app-server process remains available until MCP shutdown.",
    inputSchema: objectSchema({
      taskId: stringSchema("ID returned by zcode_start_task."),
    }, ["taskId"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "zcode_respond_attention",
    title: "Respond to ZCode permission request",
    description: "Respond only to the named pending request. Permission allow is one-call only and sends no persistent permission updates; use it only after explicit authorization for that exact tool call. User-input requests may only be declined or cancelled. Unknown request types cannot be approved.",
    inputSchema: objectSchema({
      taskId: stringSchema("Task containing the pending request."),
      attentionId: stringSchema("ID shown in the task report."),
      response: { type: "string", enum: ["allow_once", "deny", "decline_input", "cancel_input"] },
      reason: stringSchema("Short reason; never include credentials or secrets.", 0, 500),
    }, ["taskId", "attentionId", "response"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "zcode_read_task_communication",
    title: "Read ZCode communication log",
    description: "Read a page of the task's persistent, redacted parent/ZCode messages and lifecycle events. Works after the MCP process restarts and never reads other ZCode sessions.",
    inputSchema: objectSchema({
      taskId: stringSchema("UUID returned by zcode_start_task."),
      offset: { type: "integer", minimum: 0, description: "Zero-based event offset; defaults to 0." },
      limit: { type: "integer", minimum: 1, maximum: 12, description: "Events per page; defaults to 5." },
    }, ["taskId"]),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

const tasksById = new Map();
const activeByWorkspace = new Map();
const tasksBySession = new Map();
const inFlightQueries = new Set();
let appClient = null;
let appClientStarting = null;
let appClientStartController = null;
let cleanupPromise = null;
let inputBuffer = "";
let shuttingDown = false;
let legacyInitialized = false;
let modernSeen = false;

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringSchema(description, minLength = 1, maxLength = 4000) {
  return { type: "string", description, minLength, maxLength };
}

function writeJson(message) {
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch {
    process.stderr.write("zcode_bridge: response_serialization_failed\n");
  }
}

function logCategory(category) {
  process.stderr.write("zcode_bridge: " + safeCategory(category) + "\n");
}

function safeCategory(value) {
  const text = String(value || "unknown");
  return /^[a-z0-9_]{1,80}$/i.test(text) ? text : "unknown";
}

function successResponse(id, result, modern) {
  const body = modern
    ? { resultType: "complete", ...result, _meta: { [SERVER_INFO_META]: { name: SERVER_NAME, version: SERVER_VERSION } } }
    : result;
  writeJson({ jsonrpc: "2.0", id, result: body });
}

function errorResponse(id, code, message, data, modern = false) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeJson({ jsonrpc: "2.0", id, error });
}

function notification(message) {
  return message && message.id === undefined;
}

function validateRequestEra(message) {
  const meta = message?.params?._meta;
  const version = meta?.[MODERN_META];
  if (version === undefined && !legacyInitialized && (meta !== undefined || modernSeen)) {
    modernSeen = true;
    return { modern: true, error: { code: -32602, message: "Missing protocol version metadata" } };
  }
  if (typeof version === "string") {
    modernSeen = true;
    if (!SUPPORTED_VERSIONS.includes(version) || version !== MODERN_VERSION) {
      return {
        modern: true,
        error: {
          code: -32022,
          message: "Unsupported protocol version",
          data: { supported: [MODERN_VERSION], requested: version },
        },
      };
    }
    if (!meta[CLIENT_CAPABILITIES_META] || typeof meta[CLIENT_CAPABILITIES_META] !== "object") {
      return { modern: true, error: { code: -32602, message: "Missing client capabilities metadata" } };
    }
    return { modern: true };
  }
  return { modern: false };
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    if (!notification(message)) errorResponse(message?.id ?? null, -32600, "Invalid Request");
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "notifications/cancelled") return;

  if (message.method === "initialize" && !notification(message)) {
    const requested = message.params?.protocolVersion;
    if (typeof requested !== "string") {
      errorResponse(message.id, -32602, "Invalid initialize parameters");
      return;
    }
    legacyInitialized = true;
    successResponse(message.id, {
      protocolVersion: LEGACY_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    }, false);
    return;
  }

  const era = validateRequestEra(message);
  if (era.error) {
    if (!notification(message)) errorResponse(message.id, era.error.code, era.error.message, era.error.data, era.modern);
    return;
  }
  if (message.method === "server/discover") {
    if (!era.modern) {
      if (!notification(message)) errorResponse(message.id, -32601, "Method not found");
      return;
    }
    successResponse(message.id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
      ttlMs: 0,
      cacheScope: "private",
    }, true);
    return;
  }
  if (!era.modern && !legacyInitialized) {
    if (!notification(message)) errorResponse(message.id, -32002, "Server not initialized");
    return;
  }
  if (message.method === "ping") {
    if (!notification(message)) successResponse(message.id, {}, era.modern);
    return;
  }
  if (message.method === "tools/list") {
    if (!notification(message)) successResponse(message.id, { tools }, era.modern);
    return;
  }
  if (message.method === "tools/call") {
    if (notification(message)) return;
    void handleToolCall(message, era.modern);
    return;
  }
  if (!notification(message)) errorResponse(message.id, -32601, "Method not found", undefined, era.modern);
}

async function handleToolCall(message, modern) {
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  try {
    if (shuttingDown) return;
    const result = await invokeTool(name, args);
    if (shuttingDown) return;
    const body = { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
    if (modern) body.resultType = "complete";
    successResponse(message.id, body, modern);
  } catch (error) {
    if (shuttingDown) return;
    const result = { error: safeCategory(error?.category || error?.code || "request_failed") };
    const body = { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
    if (modern) body.resultType = "complete";
    successResponse(message.id, body, modern);
  }
}

async function invokeTool(name, args) {
  switch (name) {
    case "zcode_query": return await queryConnection(args);
    case "zcode_start_task": return await startTask(args);
    case "zcode_wait_task": return await waitTask(args);
    case "zcode_task_report": return taskReport(requireTask(args.taskId));
    case "zcode_continue_task": return await continueTask(args);
    case "zcode_cancel_task": return await cancelTask(args);
    case "zcode_respond_attention": return await respondAttention(args);
    case "zcode_read_task_communication": return readTaskCommunicationPage({
      taskId: args.taskId,
      offset: args.offset,
      limit: args.limit,
      directory: getCommunicationJournalDirectory(),
    });
    default: throw new ZCodeAppServerError("tool_not_found");
  }
}

function requireTask(taskId) {
  const task = tasksById.get(taskId);
  if (!task) throw new ZCodeAppServerError("task_not_found");
  return task;
}

function requireWorkspace(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || !existsSync(value)) {
    throw new ZCodeAppServerError("workspace_must_be_existing_absolute_directory");
  }
  let workspace;
  try {
    workspace = realpathSync(value);
  } catch {
    throw new ZCodeAppServerError("workspace_unavailable");
  }
  if (!statSync(workspace).isDirectory()) throw new ZCodeAppServerError("workspace_not_directory");
  return workspace;
}

function validateScope(scope) {
  if (!Array.isArray(scope) || scope.length < 1 || scope.length > 100) {
    throw new ZCodeAppServerError("writer_scope_required");
  }
  const unique = new Set();
  for (const entry of scope) {
    if (typeof entry !== "string" || !entry.trim() || path.isAbsolute(entry) || /^[a-z]:[\\/]/i.test(entry)) {
      throw new ZCodeAppServerError("writer_scope_must_be_relative");
    }
    const normalized = path.posix.normalize(entry.replaceAll("\\", "/"));
    if (normalized === ".." || normalized.startsWith("../") || normalized === "." || normalized.includes("\0")) {
      throw new ZCodeAppServerError("writer_scope_must_stay_in_workspace");
    }
    unique.add(normalized);
  }
  return [...unique];
}

function validateText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new ZCodeAppServerError("invalid_" + field);
  }
  return value.trim();
}

async function getAppClient() {
  if (shuttingDown) throw new ZCodeAppServerError("server_shutting_down");
  if (appClient && !appClient.closed && !appClient.failure) return appClient;
  if (appClientStarting) return await appClientStarting;
  let starting;
  const controller = new AbortController();
  appClientStartController = controller;
  starting = ZCodeAppServerClient.start({
    startupTimeoutMs: 25_000,
    rpcTimeoutMs: 15_000,
    signal: controller.signal,
  }).then(async (client) => {
    if (shuttingDown) {
      await client.stop();
      throw new ZCodeAppServerError("server_shutting_down");
    }
    appClient = client;
    client.on("sessionEvent", handleSessionEvent);
    client.on("serverRequest", handleServerRequest);
    client.on("failure", handleAppServerFailure);
    return client;
  }).finally(() => {
    if (appClientStarting === starting) {
      appClientStarting = null;
      appClientStartController = null;
    }
  });
  appClientStarting = starting;
  return await starting;
}

function ensureServiceOpen() {
  if (shuttingDown) throw new ZCodeAppServerError("server_shutting_down");
}

async function createDiscoverySession(client, workspace) {
  ensureServiceOpen();
  const result = await client.request("session/create", {
    workspace: { workspacePath: workspace, workspaceKey: workspace },
    mode: "plan",
    persistence: "deferred",
    titleGenerationEnabled: false,
    toolAllowlist: [],
  });
  const sessionId = getSessionId(result);
  if (!sessionId) throw new ZCodeAppServerError("session_id_missing");
  if (shuttingDown) {
    await closeSession(client, sessionId);
    throw new ZCodeAppServerError("server_shutting_down");
  }
  return { result, sessionId, settings: getSessionSettings(result) };
}

async function closeSession(client, sessionId) {
  try { await client.request("session/close", { sessionId }, 8_000); }
  catch { /* Close is best effort; child cleanup is the final boundary. */ }
}

async function targetInfo(client, workspace) {
  ensureServiceOpen();
  const discovery = await createDiscoverySession(client, workspace);
  try {
    const target = findTargetModel(discovery.settings);
    const metadata = targetMetadata(target);
    if (!target || metadata.disabled || !target.ref?.providerId) {
      throw new ZCodeAppServerError("target_model_unavailable");
    }
    if (!metadata.availableEfforts.includes(TARGET_EFFORT)) {
      throw new ZCodeAppServerError("max_reasoning_unavailable");
    }
    return { metadata, providerId: target.ref.providerId };
  } finally {
    await closeSession(client, discovery.sessionId);
  }
}

async function queryConnection(args) {
  const workspace = requireWorkspace(args.workspace);
  ensureServiceOpen();
  const operation = (async () => {
    const client = await getAppClient();
    ensureServiceOpen();
    const target = await targetInfo(client, workspace);
    ensureServiceOpen();
    return {
      connected: !client.closed && !client.failure,
      protocol: "ZCode Protocol stdio NDJSON",
      capabilities: client.capabilities,
      target: target.metadata,
      reasoningLevel: TARGET_EFFORT,
      workspace,
    };
  })();
  inFlightQueries.add(operation);
  try { return await operation; }
  finally { inFlightQueries.delete(operation); }
}

function taskDeadline(timeoutSeconds) {
  if (timeoutSeconds === undefined) return DEFAULT_TASK_TIMEOUT_MS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 7200) {
    throw new ZCodeAppServerError("timeout_seconds_out_of_range");
  }
  return timeoutSeconds * 1000;
}

function markJournalFailure(task, error) {
  const category = safeCategory(error?.category || "communication_log_write_failed");
  task.journalErrorCategory = category;
  if (!task.errorCategory) task.errorCategory = category;
  return category;
}

function appendJournalEvent(task, eventType, fields = {}, required = false) {
  try {
    return task.journal.append({ eventType, ...fields }, task);
  } catch (error) {
    const category = markJournalFailure(task, error);
    if (required) throw new ZCodeAppServerError(category);
    return null;
  }
}

function appendJournalMessage(task, message, required = false) {
  try {
    return task.journal.appendMessage({ task, ...message });
  } catch (error) {
    const category = markJournalFailure(task, error);
    if (required) throw new ZCodeAppServerError(category);
    return null;
  }
}

function trimTaskHistory() {
  if (tasksById.size <= MAX_TASKS) return;
  const terminal = [...tasksById.values()]
    .filter((task) => !ACTIVE_STATES.has(task.status) && !task.lockHeld)
    .sort((left, right) => left.updatedAt - right.updatedAt);
  while (tasksById.size > MAX_TASKS && terminal.length) {
    tasksById.delete(terminal.shift().id);
  }
}

function releaseWorkspaceLock(task) {
  task.lockHeld = false;
  if (activeByWorkspace.get(task.workspace) === task) activeByWorkspace.delete(task.workspace);
}

function isCancellationPending(task) {
  return task.cancelRequested || shuttingDown || task.status === "cancelled" || task.status === "timeout";
}

async function stopTaskTurn(task) {
  if (!task.sendStarted) return true;
  if (!task.client || !task.sessionId) return false;
  if (task.stopPromise) return await task.stopPromise;
  let stopping;
  stopping = task.client.request("session/stop", { sessionId: task.sessionId }, 8_000)
    .then(() => {
      task.sendStarted = false;
      return true;
    }, () => false)
    .finally(() => {
      if (task.stopPromise === stopping) task.stopPromise = null;
    });
  task.stopPromise = stopping;
  return await stopping;
}

async function closeTaskSession(task) {
  if (!task.client || !task.sessionId) return;
  const client = task.client;
  const sessionId = task.sessionId;
  await closeSession(client, sessionId);
  tasksBySession.delete(sessionId);
  if (task.sessionId === sessionId) task.sessionId = null;
}

async function initializeTask(task) {
  try {
    ensureServiceOpen();
    if (isCancellationPending(task)) return;
    const client = await getAppClient();
    if (isCancellationPending(task)) return;
    const targetData = await targetInfo(client, task.workspace);
    if (isCancellationPending(task)) return;
    const modelSelection = {
      providerId: targetData.providerId,
      modelId: "deepseek-v4.1-flash",
      options: { reasoningLevel: TARGET_EFFORT },
    };
    const result = await client.request("session/create", {
      workspace: { workspacePath: task.workspace, workspaceKey: task.workspace },
      mode: task.mode,
      persistence: "immediate",
      titleGenerationEnabled: false,
      model: modelSelection,
      thoughtLevel: TARGET_EFFORT,
    });
    const sessionId = getSessionId(result);
    const settings = getSessionSettings(result);
    if (!sessionId) throw new ZCodeAppServerError("session_id_missing");
    task.client = client;
    task.sessionId = sessionId;
    task.modelSelection = modelSelection;
    task.targetMetadata = targetData.metadata;
    tasksBySession.set(sessionId, task);
    appendJournalEvent(task, "session_created", {
      persistence: "immediate",
      titleGenerationEnabled: false,
      mode: task.mode,
    }, true);
    if (isCancellationPending(task)) {
      await closeTaskSession(task);
      return;
    }
    if (!selectionMatches(settings, targetData.providerId)) {
      await closeTaskSession(task);
      throw new ZCodeAppServerError("selected_model_metadata_mismatch");
    }
    await client.request("session/subscribe", {
      sessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
    });
    if (isCancellationPending(task)) {
      await closeTaskSession(task);
      return;
    }
    task.status = "running";
    task.turnNumber = 1;
    task.updatedAt = Date.now();
    const content = buildTaskPrompt(task);
    appendJournalMessage(task, {
      direction: "parent_to_zcode",
      messageType: "initial_assignment",
      deliveryState: "attempted",
      text: content,
    }, true);
    task.sendStarted = true;
    await client.request("session/send", {
      sessionId,
      modelSelection,
      content,
    });
    appendJournalEvent(task, "message_delivery_confirmed", {
      direction: "parent_to_zcode",
      messageType: "initial_assignment",
    });
    if (!shuttingDown) notifyTask(task);
  } catch (error) {
    if (!isCancellationPending(task)) {
      task.status = "failed";
      task.errorCategory = safeCategory(error?.category || "start_failed");
      appendJournalEvent(task, "task_start_failed", { errorCategory: task.errorCategory });
      task.updatedAt = Date.now();
      if (task.sendStarted) {
        const stopped = await stopTaskTurn(task);
        if (stopped) releaseWorkspaceLock(task);
        else task.errorCategory = "start_failed_stop_unconfirmed";
      } else {
        await closeTaskSession(task);
        releaseWorkspaceLock(task);
      }
      notifyTask(task);
    }
  } finally {
    if (isCancellationPending(task)) {
      if (task.sendStarted) {
        const stopped = await stopTaskTurn(task);
        if (stopped) releaseWorkspaceLock(task);
        else if (task.status === "timeout") task.errorCategory = "turn_timeout_stop_unconfirmed";
        else task.errorCategory = "cancel_stop_unconfirmed";
      } else {
        await closeTaskSession(task);
        releaseWorkspaceLock(task);
      }
      task.updatedAt = Date.now();
      if (!shuttingDown) notifyTask(task);
    }
  }
}

async function startTask(args) {
  ensureServiceOpen();
  const workspace = requireWorkspace(args.workspace);
  const prior = activeByWorkspace.get(workspace);
  if (prior?.lockHeld) throw new ZCodeAppServerError("workspace_task_conflict");
  const scope = validateScope(args.writerScope);
  const scopeDirectories = args.writerScope
    .filter((entry) => typeof entry === "string" && /[\\/]$/.test(entry))
    .map((entry) => path.posix.normalize(entry.replaceAll("\\", "/").replace(/\/+$/, "")));
  const target = validateText(args.target, "target", 2000);
  const brief = validateText(args.brief, "brief", 12000);
  if (!Array.isArray(args.acceptance) || args.acceptance.length < 1 || args.acceptance.length > 30) {
    throw new ZCodeAppServerError("acceptance_commands_required");
  }
  const acceptance = args.acceptance.map((entry) => validateText(entry, "acceptance_command", 1000));
  const mode = args.mode === undefined ? "edit" : args.mode;
  if (!["plan", "edit"].includes(mode)) throw new ZCodeAppServerError("mode_must_be_plan_or_edit");
  const deadlineMs = taskDeadline(args.timeoutSeconds);
  const task = {
    id: randomUUID(),
    workspace,
    target,
    brief,
    writerScope: scope,
    scopeDirectories,
    acceptance,
    mode,
    status: "starting",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnNumber: 0,
    sessionId: null,
    client: null,
    modelSelection: null,
    targetMetadata: null,
    turnResult: null,
    responseSummary: null,
    errorCategory: null,
    pendingRequests: new Map(),
    listeners: new Set(),
    timer: null,
    deadlineMs,
    lockHeld: true,
    cancelRequested: false,
    sendStarted: false,
    startPromise: null,
    stopPromise: null,
    journal: null,
    journalErrorCategory: null,
  };
  task.journal = TaskCommunicationJournal.create({
    taskId: task.id,
    workspace,
    directory: getCommunicationJournalDirectory(),
  });
  appendJournalEvent(task, "task_created", {
    target,
    brief,
    writerScope: scope,
    acceptance,
    mode,
    timeoutMs: deadlineMs,
  }, true);
  tasksById.set(task.id, task);
  activeByWorkspace.set(workspace, task);
  trimTaskHistory();
  task.timer = setTimeout(() => { void timeOutTask(task); }, task.deadlineMs);
  task.timer.unref?.();
  task.startPromise = initializeTask(task).finally(() => { task.startPromise = null; });
  return taskReport(task);
}

function buildTaskPrompt(task, followUp, turnNumber = task.turnNumber) {
  const scopeText = task.writerScope.map((entry) => "- " + entry).join("\n");
  const validationText = task.acceptance.map((entry) => "- " + entry).join("\n");
  const base =
    "Codex 委派任务 " + task.id + "：" + task.target + "\n\n" +
    "You are the delegated development executor. Work only inside this explicit workspace: " + task.workspace + "\n\n" +
    "Read the applicable AGENTS.md and relevant standards before editing. Treat the following as the sole-writer scope for this task:\n" +
    scopeText + "\n\n" +
    "Goal:\n" + task.target + "\n\n" +
    "Brief:\n" + task.brief + "\n\n" +
    "Acceptance checks to run and report:\n" + validationText + "\n\n" +
    "Use only the configured OpenCode Go (Chat) / deepseek-v4.1-flash / max selection. Do not switch provider, model, or effort. Keep ZCode permission checks enabled and wait for approval when required. Do not write files outside the listed scope. Run the acceptance checks, report changed paths and actual results, state anything not run, and leave all changes uncommitted. Do not merge or modify any other worktree.";
  if (!followUp) return base;
  return base + "\n\nSame-session follow-up for turn " + turnNumber + ":\n" + followUp +
    "\nRecheck the original acceptance commands affected by this correction. The original writer scope and constraints still apply.";
}

function beginDeadline(task, timeoutSeconds) {
  clearTimeout(task.timer);
  task.deadlineMs = taskDeadline(timeoutSeconds);
  task.timer = setTimeout(() => { void timeOutTask(task); }, task.deadlineMs);
  task.timer.unref?.();
}

async function timeOutTask(task) {
  if (!ACTIVE_STATES.has(task.status)) return;
  appendJournalEvent(task, "timeout_requested", { previousStatus: task.status });
  task.status = "timeout";
  task.errorCategory = "turn_timeout";
  task.cancelRequested = true;
  task.updatedAt = Date.now();
  clearTimeout(task.timer);
  if (task.startPromise) {
    try { await task.startPromise; } catch { /* The task lifecycle owns its safe terminal state. */ }
  }
  if (task.sendStarted) {
    if (await stopTaskTurn(task)) releaseWorkspaceLock(task);
    else task.errorCategory = "turn_timeout_stop_unconfirmed";
  } else {
    await closeTaskSession(task);
    releaseWorkspaceLock(task);
  }
  task.updatedAt = Date.now();
  appendJournalEvent(task, "timeout_terminal", {
    errorCategory: task.errorCategory,
    writerLockHeld: task.lockHeld,
  });
  notifyTask(task);
}

function onTurnTerminal(task, status, facts = {}) {
  if (!task || !ACTIVE_STATES.has(task.status)) return;
  clearTimeout(task.timer);
  task.status = status;
  task.sendStarted = false;
  task.turnResult = {
    outcome: facts.outcome || status,
    resultType: facts.resultType || null,
    modelRequestCount: Number.isSafeInteger(facts.modelRequestCount) ? facts.modelRequestCount : null,
    requestedModel: {
      providerId: task.modelSelection?.providerId || null,
      modelId: task.modelSelection?.modelId || null,
      reasoningLevel: task.modelSelection?.options?.reasoningLevel || null,
    },
  };
  const response = typeof facts.response === "string" ? facts.response : "";
  task.responseSummary = redactText(response).slice(0, 10_000);
  task.errorCategory = facts.errorCategory
    ? safeCategory(facts.errorCategory)
    : task.journalErrorCategory || null;
  task.updatedAt = Date.now();
  if (response) {
    appendJournalMessage(task, {
      direction: "zcode_to_parent",
      messageType: "assistant_response",
      deliveryState: "received",
      text: response,
    });
  }
  appendJournalEvent(task, "turn_terminal", {
    outcome: task.turnResult.outcome,
    resultType: task.turnResult.resultType,
    modelRequestCount: task.turnResult.modelRequestCount,
    errorCategory: task.errorCategory,
  });
  releaseWorkspaceLock(task);
  notifyTask(task);
}

function handleSessionEvent(event) {
  const task = event.sessionId ? tasksBySession.get(event.sessionId) : null;
  if (!task) return;
  const type = event.type;
  const payload = event.payload || {};
  if (type === "turn.completed") {
    const resultType = typeof payload.resultType === "string" ? payload.resultType : "unknown";
    onTurnTerminal(task, resultType === "success" ? "completed" : "failed", {
      outcome: resultType === "success" ? "completed" : "failed",
      resultType,
      response: typeof payload.response === "string" ? payload.response : "",
      modelRequestCount: payload.usage?.modelRequestCount,
      errorCategory: resultType === "success" ? null : "turn_result_not_success",
    });
    return;
  }
  if (type === "turn.failed") {
    onTurnTerminal(task, "failed", {
      outcome: "failed",
      errorCategory: payload.error?.code ? "turn_failed_" + safeCategory(payload.error.code) : "turn_failed",
    });
    return;
  }
}

function handleServerRequest(request) {
  const task = request.params?.sessionId ? tasksBySession.get(request.params.sessionId) : null;
  if (!task) {
    if (appClient) appClient.respondServerError(request.id, -32601, "Unsupported server request");
    return;
  }
  const kind = request.method === "interaction/requestPermission"
    ? "permission"
    : request.method === "interaction/requestUserInput"
      ? "user_input"
      : "unsupported";
  const attentionId = randomUUID();
  task.pendingRequests.set(attentionId, {
    attentionId,
    kind,
    rpcId: request.id,
    method: request.method,
    params: request.params,
    respondable: kind !== "unsupported",
  });
  task.status = "needs_attention";
  task.updatedAt = Date.now();
  const attention = sanitizeAttention({ ...task.pendingRequests.get(attentionId), task });
  if (kind === "user_input") {
    const prompt = request.params?.prompt || request.params?.question;
    if (typeof prompt === "string") {
      appendJournalMessage(task, {
        direction: "zcode_to_parent",
        messageType: "user_input_request",
        deliveryState: "received",
        text: prompt,
      });
    }
  }
  appendJournalEvent(task, "attention_requested", {
    method: request.method,
    attention,
  });
  notifyTask(task);
}

function handleAppServerFailure(category) {
  const failedClient = appClient;
  appClient = null;
  const affected = [];
  for (const task of tasksBySession.values()) {
    if (task.client === failedClient && (ACTIVE_STATES.has(task.status) || task.lockHeld)) {
      if (ACTIVE_STATES.has(task.status)) {
        clearTimeout(task.timer);
        task.status = "failed";
        task.errorCategory = safeCategory(category || "app_server_failed");
        task.updatedAt = Date.now();
        appendJournalEvent(task, "app_server_failed", { errorCategory: task.errorCategory });
      }
      affected.push(task);
      notifyTask(task);
    }
  }
  if (!failedClient) return;
  void failedClient.stop().then((stopped) => {
    for (const task of affected) {
      if (!task.lockHeld) continue;
      if (stopped) {
        task.sendStarted = false;
        releaseWorkspaceLock(task);
        appendJournalEvent(task, "app_server_stopped", { writerLockHeld: task.lockHeld });
      } else {
        task.errorCategory = "app_server_tree_stop_unconfirmed";
        appendJournalEvent(task, "app_server_stop_failed", { errorCategory: task.errorCategory });
      }
      task.updatedAt = Date.now();
      notifyTask(task);
    }
  }).catch(() => {
    for (const task of affected) {
      if (!task.lockHeld) continue;
      task.errorCategory = "app_server_tree_stop_unconfirmed";
      appendJournalEvent(task, "app_server_stop_failed", { errorCategory: task.errorCategory });
      task.updatedAt = Date.now();
      notifyTask(task);
    }
  });
}

function sanitizeAttention(entry) {
  const params = entry.params || {};
  const safe = { attentionId: entry.attentionId, kind: entry.kind, respondable: entry.respondable };
  if (entry.kind === "permission") {
    safe.toolName = safeField(params.toolName, 120);
    safe.riskLevel = safeField(params.riskLevel, 80);
    safe.reason = redactText(safeField(params.reason, 500));
    safe.withinWriterScope = requestPathWithinScope(entry.task, params);
    safe.canAllowOnce = hasSafeOneTimeOption(params) && safe.withinWriterScope &&
      isScopedFileTool(params.toolName);
  } else if (entry.kind === "user_input") {
    safe.prompt = redactText(safeField(params.prompt || params.question, 500));
  }
  return safe;
}

function safeField(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

function taskReport(task) {
  const communicationLog = task.journal
    ? task.journal.report()
    : { path: null, eventCount: 0, errorCategory: "communication_log_unavailable" };
  communicationLog.errorCategory = task.journalErrorCategory || communicationLog.errorCategory;
  return {
    taskId: task.id,
    sessionId: task.sessionId,
    status: task.status,
    workspace: task.workspace,
    mode: task.mode,
    turnNumber: task.turnNumber,
    writerLockHeld: task.lockHeld,
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
    selection: task.targetMetadata
      ? { ...task.targetMetadata, reasoningLevel: TARGET_EFFORT, thoughtLevel: TARGET_EFFORT }
      : null,
    turn: task.turnResult,
    pendingAttention: [...task.pendingRequests.values()].map((entry) => sanitizeAttention({ ...entry, task })),
    responseSummary: task.responseSummary,
    errorCategory: task.errorCategory,
    communicationLog,
  };
}

function notifyTask(task) {
  task.updatedAt = Date.now();
  for (const listener of [...task.listeners]) listener();
  task.listeners.clear();
}

function waitForChange(task, timeoutMs) {
  if (!["starting", "running"].includes(task.status)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      task.listeners.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    task.listeners.add(finish);
  });
}

async function waitTask(args) {
  const task = requireTask(args.taskId);
  const waitSeconds = args.waitSeconds === undefined ? 30 : args.waitSeconds;
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 45) {
    throw new ZCodeAppServerError("wait_seconds_out_of_range");
  }
  await waitForChange(task, waitSeconds * 1000);
  return taskReport(task);
}

async function continueTask(args) {
  ensureServiceOpen();
  const task = requireTask(args.taskId);
  if (!["completed", "failed", "cancelled", "timeout"].includes(task.status)) {
    throw new ZCodeAppServerError("task_not_terminal");
  }
  if (!task.client || task.client.closed || task.client.failure || !task.sessionId) {
    throw new ZCodeAppServerError("same_session_unavailable");
  }
  if (task.journalErrorCategory || task.journal?.failed) {
    throw new ZCodeAppServerError("communication_log_write_failed");
  }
  if (task.lockHeld) throw new ZCodeAppServerError("prior_turn_stop_unconfirmed");
  const active = activeByWorkspace.get(task.workspace);
  if (active?.lockHeld && active !== task) {
    throw new ZCodeAppServerError("workspace_task_conflict");
  }
  const followUp = validateText(args.followUp, "follow_up", 12000);
  const timeoutSeconds = args.timeoutSeconds;
  const nextTurnNumber = task.turnNumber + 1;
  const content = buildTaskPrompt(task, followUp, nextTurnNumber);
  appendJournalMessage(task, {
    direction: "parent_to_zcode",
    messageType: "follow_up_instruction",
    deliveryState: "attempted",
    text: content,
    turnNumber: nextTurnNumber,
  }, true);
  task.status = "starting";
  task.errorCategory = null;
  task.turnResult = null;
  task.responseSummary = null;
  task.pendingRequests.clear();
  activeByWorkspace.set(task.workspace, task);
  task.lockHeld = true;
  task.cancelRequested = false;
  task.sendStarted = false;
  task.turnNumber = nextTurnNumber;
  task.updatedAt = Date.now();
  try {
    beginDeadline(task, timeoutSeconds);
    task.status = "running";
    task.sendStarted = true;
    await task.client.request("session/send", {
      sessionId: task.sessionId,
      modelSelection: task.modelSelection,
      content,
    });
    appendJournalEvent(task, "message_delivery_confirmed", {
      direction: "parent_to_zcode",
      messageType: "follow_up_instruction",
    });
    notifyTask(task);
    return taskReport(task);
  } catch (error) {
    clearTimeout(task.timer);
    task.status = "failed";
    task.errorCategory = safeCategory(error?.category || "continue_failed");
    appendJournalEvent(task, "continue_failed", { errorCategory: task.errorCategory });
    if (task.sendStarted) {
      if (await stopTaskTurn(task)) releaseWorkspaceLock(task);
      else task.errorCategory = "continue_failed_stop_unconfirmed";
    } else {
      releaseWorkspaceLock(task);
    }
    notifyTask(task);
    throw new ZCodeAppServerError(task.errorCategory);
  }
}

async function cancelTask(args) {
  const task = requireTask(args.taskId);
  if (!ACTIVE_STATES.has(task.status)) return taskReport(task);
  appendJournalEvent(task, "cancel_requested", { previousStatus: task.status });
  clearTimeout(task.timer);
  task.cancelRequested = true;
  if (task.sendStarted) {
    if (!await stopTaskTurn(task)) {
      appendJournalEvent(task, "cancel_failed", { errorCategory: "cancel_stop_unconfirmed" });
      throw new ZCodeAppServerError("cancel_stop_unconfirmed");
    }
  }
  task.status = "cancelled";
  task.errorCategory = null;
  task.updatedAt = Date.now();
  for (const [attentionId, pending] of task.pendingRequests) {
    if (pending.rpcId !== null && task.client) task.client.respondServerError(pending.rpcId, -32800, "Task cancelled");
    appendJournalEvent(task, "attention_cancelled", { attentionId, kind: pending.kind });
    task.pendingRequests.delete(attentionId);
  }
  if (task.sendStarted) {
    throw new ZCodeAppServerError("cancel_stop_unconfirmed");
  }
  if (task.startPromise) {
    // Startup may still be resolving a create/send RPC. Its lifecycle retains
    // the workspace lock until it closes any created session or confirms stop.
  } else {
    releaseWorkspaceLock(task);
  }
  appendJournalEvent(task, "task_cancelled", { writerLockHeld: task.lockHeld });
  notifyTask(task);
  return taskReport(task);
}

async function respondAttention(args) {
  const task = requireTask(args.taskId);
  if (task.journalErrorCategory || task.journal?.failed) {
    throw new ZCodeAppServerError("communication_log_write_failed");
  }
  const entry = task.pendingRequests.get(args.attentionId);
  if (!entry) throw new ZCodeAppServerError("attention_request_not_found");
  if (!entry.respondable || entry.rpcId === null) throw new ZCodeAppServerError("attention_request_not_explicitly_respondable");
  const reason = typeof args.reason === "string" ? redactText(args.reason).slice(0, 500) : "";
  let result;
  if (entry.kind === "permission") {
    if (!["allow_once", "deny"].includes(args.response)) throw new ZCodeAppServerError("invalid_permission_response");
    if (args.response === "allow_once") {
      if (!hasSafeOneTimeOption(entry.params) || !isScopedFileTool(entry.params?.toolName) ||
          !requestPathWithinScope(task, entry.params)) {
        throw new ZCodeAppServerError("permission_not_safe_for_one_time_allow");
      }
    }
    result = {
      decision: args.response === "allow_once" ? "allow" : "deny",
      reason: reason || (args.response === "allow_once"
        ? "Explicit one-time caller approval; no permission updates."
        : "Denied by caller."),
    };
  } else if (entry.kind === "user_input") {
    if (!["decline_input", "cancel_input"].includes(args.response)) throw new ZCodeAppServerError("user_input_can_only_be_declined_or_cancelled");
    result = {
      action: args.response === "decline_input" ? "decline" : "cancel",
      reason: reason || "No user input was provided by this bridge.",
    };
  } else {
    throw new ZCodeAppServerError("unsupported_attention_kind");
  }
  const attention = sanitizeAttention({ ...entry, task });
  appendJournalEvent(task, "attention_response_attempted", {
    attention,
    response: args.response,
    reason: result.reason,
    responseDetails: result,
  }, true);
  if (!task.client.respondServerRequest(entry.rpcId, result)) {
    appendJournalEvent(task, "attention_response_failed", {
      attentionId: entry.attentionId,
      response: args.response,
    });
    throw new ZCodeAppServerError("attention_response_not_sent");
  }
  appendJournalEvent(task, "attention_response_sent", {
    attentionId: entry.attentionId,
    response: args.response,
    responseDetails: result,
  });
  task.pendingRequests.delete(args.attentionId);
  if (task.pendingRequests.size === 0 && task.status === "needs_attention") task.status = "running";
  task.updatedAt = Date.now();
  notifyTask(task);
  return taskReport(task);
}

const redactText = redactCommunicationText;

function hasSafeOneTimeOption(params) {
  if (!Array.isArray(params?.options)) return false;
  return params.options.some((option) =>
    option?.kind === "allow_once" &&
    typeof option.optionId === "string" &&
    option.response?.decision === "allow" &&
    !Array.isArray(option.response?.permissionUpdates) &&
    option.response?.modifiedInput === undefined,
  );
}

function isScopedFileTool(toolName) {
  return typeof toolName === "string" &&
    ["write", "edit", "multiedit", "write_file", "edit_file"].includes(toolName.toLowerCase());
}

function requestPathWithinScope(task, params) {
  const input = params?.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const requested = input.file_path || input.filePath || input.path;
  if (typeof requested !== "string" || !requested.trim()) return false;
  const resolved = resolveThroughExistingAncestor(path.resolve(task.workspace, requested));
  const workspaceRelative = path.relative(task.workspace, resolved);
  if (workspaceRelative === ".." || workspaceRelative.startsWith(".." + path.sep) || path.isAbsolute(workspaceRelative)) {
    return false;
  }
  for (const entry of task.writerScope) {
    const scopePath = resolveThroughExistingAncestor(path.resolve(task.workspace, entry));
    if (path.relative(scopePath, resolved) === "") return true;
    const isDirectory = task.scopeDirectories.includes(entry) ||
      (existsSync(scopePath) && statSync(scopePath).isDirectory());
    if (!isDirectory) continue;
    const relative = path.relative(scopePath, resolved);
    if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) return true;
  }
  return false;
}

function resolveThroughExistingAncestor(target) {
  let ancestor = target;
  const suffix = [];
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return target;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  try {
    return path.join(realpathSync(ancestor), ...suffix);
  } catch {
    return target;
  }
}

async function cleanup() {
  if (cleanupPromise) return await cleanupPromise;
  shuttingDown = true;
  cleanupPromise = (async () => {
    const tasks = [...tasksById.values()];
    for (const task of tasks) {
      clearTimeout(task.timer);
      if (ACTIVE_STATES.has(task.status)) {
        appendJournalEvent(task, "mcp_shutdown_cancel_requested", { previousStatus: task.status });
        task.cancelRequested = true;
        task.status = "cancelled";
        task.errorCategory = null;
        task.updatedAt = Date.now();
      }
    }
    const stopRequests = tasks
      .filter((task) => task.sendStarted)
      .map(async (task) => {
        const stopped = await stopTaskTurn(task);
        if (stopped) releaseWorkspaceLock(task);
        else task.errorCategory = "shutdown_stop_unconfirmed";
        appendJournalEvent(task, stopped ? "mcp_shutdown_stop_confirmed" : "mcp_shutdown_stop_failed", {
          errorCategory: stopped ? null : task.errorCategory,
          writerLockHeld: task.lockHeld,
        });
      });
    await Promise.allSettled(stopRequests);
    appClientStartController?.abort();
    const clientStart = appClientStarting;
    const client = appClient;
    if (client) {
      for (const sessionId of tasksBySession.keys()) await closeSession(client, sessionId);
      try {
        if (!await client.stop()) logCategory("app_server_cleanup_unconfirmed");
      } catch {
        logCategory("app_server_cleanup_failed");
      }
      if (appClient === client) appClient = null;
    }
    const pendingTasks = tasks.map((task) => task.startPromise).filter(Boolean);
    await Promise.allSettled([...pendingTasks, ...inFlightQueries]);
    if (clientStart) {
      try { await clientStart; } catch { /* Startup failure already stopped its child. */ }
    }
  })();
  return await cleanupPromise;
}

function printHelp() {
  process.stdout.write(
    "ZCode stdio MCP server " + SERVER_VERSION + "\n" +
    "Usage: node mcp-server.mjs\n" +
    "Requires existing ZCode CLI and provider configuration. Supports MCP 2026-07-28 per-request metadata and legacy 2025-11-25 initialize.\n" +
    "Provider/model/reasoning are fixed to OpenCode Go (Chat) / deepseek-v4.1-flash / max.\n",
  );
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    inputBuffer += chunk;
    if (Buffer.byteLength(inputBuffer, "utf8") > MAX_LINE_BYTES) {
      logCategory("input_line_too_large");
      process.stdin.pause();
      void cleanup().finally(() => process.exitCode = 2);
      return;
    }
    for (;;) {
      const newline = inputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        errorResponse(null, -32700, "Parse error");
        continue;
      }
      handleMessage(message);
    }
  });
  process.stdin.on("end", () => { void cleanup(); });
  process.on("SIGINT", () => { void cleanup().finally(() => process.exit(0)); });
  process.on("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
}
