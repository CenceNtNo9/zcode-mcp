import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_PART_CHARS = 3_000;
const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 12;

const SENSITIVE_FIELD = /(?:authorization|credential|headers?|password|secret|token|provider.?config|raw.?tool.?input|chain.?of.?thought|private.?thought)/i;

export class CommunicationJournalError extends Error {
  constructor(category) {
    super(category);
    this.name = "CommunicationJournalError";
    this.category = category;
  }
}

function installedCodexHome(moduleUrl) {
  const modulePath = fileURLToPath(moduleUrl);
  const bridgeDirectory = path.dirname(modulePath);
  const toolsDirectory = path.dirname(bridgeDirectory);
  if (path.basename(bridgeDirectory).toLowerCase() !== "zcode-bridge" ||
      path.basename(toolsDirectory).toLowerCase() !== "tools") return null;
  return path.dirname(toolsDirectory);
}

export function resolveCommunicationJournalDirectory({
  recordsDirectory = process.env.ZCODE_BRIDGE_RECORDS_DIR,
  codexHome = process.env.CODEX_HOME,
  moduleUrl = import.meta.url,
  userHome = os.homedir(),
} = {}) {
  const requested = recordsDirectory;
  if (requested !== undefined && requested.trim()) return path.resolve(requested);
  const configuredHome = typeof codexHome === "string" ? codexHome.trim() : "";
  const effectiveHome = configuredHome
    ? path.resolve(configuredHome)
    : installedCodexHome(moduleUrl) ?? path.join(userHome, ".codex");
  return path.resolve(effectiveHome, "state", "zcode-bridge", "records");
}

export function getCommunicationJournalDirectory() {
  return resolveCommunicationJournalDirectory();
}

export function redactCommunicationText(value) {
  return String(value ?? "")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[redacted private key]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|credential|token|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function assertOutsideWorkspace(workspace, candidate) {
  if (workspace && isWithin(realpathSync(workspace), candidate)) {
    throw new CommunicationJournalError("communication_log_inside_workspace");
  }
}

function nearestExistingPath(absolute) {
  let current = absolute;
  while (true) {
    try {
      return { path: current, info: lstatSync(current) };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function sanitizeValue(value, key = "") {
  if (SENSITIVE_FIELD.test(key)) return "[omitted]";
  if (typeof value === "string") return redactCommunicationText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childValue !== undefined) sanitized[childKey] = sanitizeValue(childValue, childKey);
    }
    return sanitized;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

function chunksOf(text) {
  const chunks = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > MESSAGE_PART_CHARS && chunk) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function canonicalJournalDirectory(directory, workspace = null, create = false) {
  const absolute = path.resolve(directory);
  try {
    let info = null;
    try {
      info = lstatSync(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT" || !create) throw error;
      const ancestor = nearestExistingPath(absolute);
      if (!statSync(ancestor.path).isDirectory()) {
        throw new CommunicationJournalError("communication_log_directory_invalid");
      }
      const canonicalAncestor = realpathSync(ancestor.path);
      const prospectiveDirectory = path.resolve(canonicalAncestor, path.relative(ancestor.path, absolute));
      assertOutsideWorkspace(workspace, prospectiveDirectory);
      mkdirSync(absolute, { recursive: true });
      info = lstatSync(absolute);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CommunicationJournalError("communication_log_directory_invalid");
    }
    const canonical = realpathSync(absolute);
    assertOutsideWorkspace(workspace, canonical);
    return canonical;
  } catch (error) {
    if (error instanceof CommunicationJournalError) throw error;
    throw new CommunicationJournalError(create ? "communication_log_create_failed" : "communication_log_not_found");
  }
}

function validateTaskId(taskId) {
  if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
    throw new CommunicationJournalError("invalid_task_id");
  }
  return taskId.toLowerCase();
}

function modelMetadata(task) {
  return {
    providerLabel: task.targetMetadata?.providerLabel || "OpenCode Go (Chat)",
    modelId: task.modelSelection?.modelId || "deepseek-v4.1-flash",
    reasoningLevel: task.modelSelection?.options?.reasoningLevel || "max",
  };
}

export class TaskCommunicationJournal {
  constructor({ taskId, workspace, directory, filePath }) {
    this.taskId = taskId;
    this.workspace = workspace;
    this.directory = directory;
    this.filePath = filePath;
    this.eventCount = 0;
    this.failed = false;
  }

  static create({ taskId, workspace, directory = getCommunicationJournalDirectory() }) {
    const safeTaskId = validateTaskId(taskId);
    const safeWorkspace = realpathSync(workspace);
    const safeDirectory = canonicalJournalDirectory(directory, safeWorkspace, true);
    const filePath = path.join(safeDirectory, safeTaskId + ".jsonl");
    let descriptor;
    try {
      descriptor = openSync(filePath, "wx", 0o600);
      closeSync(descriptor);
    } catch {
      throw new CommunicationJournalError("communication_log_create_failed");
    }
    return new TaskCommunicationJournal({
      taskId: safeTaskId,
      workspace: safeWorkspace,
      directory: safeDirectory,
      filePath,
    });
  }

  append(event, task) {
    if (this.failed) throw new CommunicationJournalError("communication_log_write_failed");
    const record = sanitizeValue({
      ...event,
      sequence: this.eventCount + 1,
      timestamp: new Date().toISOString(),
      taskId: this.taskId,
      sessionId: task.sessionId,
      workspace: this.workspace,
      turnNumber: event.turnNumber ?? task.turnNumber,
      model: modelMetadata(task),
    });
    try {
      appendFileSync(this.filePath, JSON.stringify(record) + "\n", { encoding: "utf8" });
      this.eventCount += 1;
      return this.eventCount;
    } catch {
      this.failed = true;
      throw new CommunicationJournalError("communication_log_write_failed");
    }
  }

  appendMessage({ task, direction, messageType, text, turnNumber = task.turnNumber, deliveryState = "recorded" }) {
    const safeText = redactCommunicationText(text);
    const chunks = chunksOf(safeText);
    const messageId = randomUUID();
    for (let index = 0; index < chunks.length; index += 1) {
      this.append({
        eventType: "message",
        direction,
        messageType,
        messageId,
        part: index + 1,
        parts: chunks.length,
        deliveryState,
        text: chunks[index],
      }, { ...task, turnNumber });
    }
    return messageId;
  }

  report() {
    return {
      path: this.filePath,
      eventCount: this.eventCount,
      errorCategory: this.failed ? "communication_log_write_failed" : null,
    };
  }
}

export function readTaskCommunicationPage({
  taskId,
  offset = 0,
  limit = DEFAULT_PAGE_SIZE,
  directory = getCommunicationJournalDirectory(),
}) {
  const safeTaskId = validateTaskId(taskId);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new CommunicationJournalError("communication_log_offset_invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new CommunicationJournalError("communication_log_page_size_invalid");
  }
  const safeDirectory = canonicalJournalDirectory(directory);
  const filePath = path.join(safeDirectory, safeTaskId + ".jsonl");
  let info;
  let canonicalFile;
  let contents;
  try {
    info = lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CommunicationJournalError("communication_log_not_found");
    }
    canonicalFile = realpathSync(filePath);
    if (path.dirname(canonicalFile).toLowerCase() !== safeDirectory.toLowerCase()) {
      throw new CommunicationJournalError("communication_log_path_invalid");
    }
    if (!statSync(canonicalFile).isFile()) {
      throw new CommunicationJournalError("communication_log_not_found");
    }
    contents = readFileSync(canonicalFile, "utf8");
  } catch (error) {
    if (error instanceof CommunicationJournalError) throw error;
    throw new CommunicationJournalError("communication_log_not_found");
  }

  const lines = contents.split(/\r?\n/).filter(Boolean);
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try { event = JSON.parse(lines[index]); }
    catch { throw new CommunicationJournalError("communication_log_corrupt"); }
    if (event.sequence !== index + 1 || event.taskId !== safeTaskId) {
      throw new CommunicationJournalError("communication_log_corrupt");
    }
    events.push(event);
  }
  const page = events.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    taskId: safeTaskId,
    path: canonicalFile,
    totalEvents: events.length,
    offset,
    nextOffset,
    hasMore: nextOffset < events.length,
    events: page,
  };
}

export const communicationJournalLimits = Object.freeze({
  defaultPageSize: DEFAULT_PAGE_SIZE,
  maxPageSize: MAX_PAGE_SIZE,
  messagePartChars: MESSAGE_PART_CHARS,
});
