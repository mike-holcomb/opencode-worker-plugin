import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Review } from "./contracts.js";
import type { UserConfig } from "./config.js";
import type { ManagedLaunchContract } from "./launch-config.js";
import type { ArtifactRegistration } from "./artifacts.js";

export type ExecutionPhase = "queued" | "dispatching" | "running" | "waiting_input" | "cancelling" | "finalizing" | "completed" | "failed" | "cancelled" | "timed_out";
export type Observation = "current" | "reconciling" | "unknown";

export type StoredInputRequest = {
  requestId: string;
  executionId: string;
  kind: "permission" | "question";
  revision: number;
  detail: unknown;
  status: "pending" | "responding" | "responded" | "unconfirmed" | "expired";
  createdAt: string;
  response: unknown | null;
  authorizationBasis: unknown | null;
};

export type CreationIntent = { backendId: string; marker: string; sessionId: string | null; createdAt: string };
export type CancellationIntent = { reason: string; requester: string; deadlineOrigin: string | null; createdAt: string; abortAcknowledged: boolean };
export type CancellationDiagnostic = {
  reason: string; backendAvailable: boolean; freshAbortProof: boolean;
  status: string | null; statusOmitted: boolean | null; activeTools: number | null; pendingRequests: number | null;
};
type CancellationEventKind = "cancellation_diagnostic" | "cancellation_recovery_intent" | "cancellation_stop_confirmed";
type PublicEvent = { cursor: number; kind: string; detail: unknown; createdAt: string;
  detailTruncated?: { originalBytes: number; sha256: string; cursor: string } };

export type StoredTask = {
  taskId: string;
  executionId: string;
  scopeId: string;
  revision: number;
  phase: ExecutionPhase;
  observation: Observation;
  workspace: string;
  workspaceAccess?: "exclusive" | "shared_read";
  packet: unknown;
  model: string;
  requestModel?: unknown;
  profile: string;
  backendId: string | null;
  backendConfig: UserConfig | null;
  launchContract: ManagedLaunchContract | null;
  sessionId: string | null;
  userMessageId: string | null;
  predecessorExecutionId: string | null;
  contextMode: "resume" | "fresh" | null;
  baselineHash: string;
  promptHash: string;
  frozenPrompt: string;
  frozenBaseline: unknown | null;
  reportPath: string | null;
  queueDeadlineAt: string | null;
  admittedAt: string | null;
  executionDeadlineAt: string | null;
  finalizationDeadlineAt: string | null;
  intendedOutcome: "completed" | "failed" | "cancelled" | "timed_out" | null;
  creationIntent: CreationIntent | null;
  cancellationIntent: CancellationIntent | null;
  pendingRequests: StoredInputRequest[];
  createdAt: string;
  updatedAt: string;
  reportValidity: "pending" | "valid" | "missing" | "invalid";
  finalManifestHash: string | null;
  reviewStatus: "pending" | "accepted" | "needs_correction" | "rejected" | "awaiting_evidence";
  workerInstanceId: string | null;
};

export type StartRecord = {
  taskId?: string;
  executionId?: string;
  scopeId: string;
  idempotencyKey: string;
  workspace: string;
  requestWorkspace?: string;
  workspaceAccess?: "exclusive" | "shared_read";
  packet: unknown;
  model: string;
  requestModel?: unknown;
  backendConfig?: UserConfig;
  launchContract?: ManagedLaunchContract;
  profile: string;
  baselineHash: string;
  promptHash: string;
  frozenPrompt?: string;
  frozenBaseline?: unknown;
  reportPath?: string;
  queueTimeoutSeconds?: number;
  executionTimeoutSeconds?: number;
};

export type ContinueRecord = {
  scopeId: string;
  taskId: string;
  predecessorExecutionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  executionId?: string;
  packet: unknown;
  contextMode: "resume" | "fresh";
  baselineHash: string;
  promptHash: string;
  frozenPrompt: string;
  frozenBaseline?: unknown;
  backendConfig?: UserConfig;
  launchContract?: ManagedLaunchContract;
  reportPath?: string;
  queueTimeoutSeconds?: number;
  executionTimeoutSeconds?: number;
};

export type CancelRecord = {
  scopeId: string;
  taskId: string;
  executionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  reason: string;
  requester: string;
  deadlineOrigin?: string;
};

export type RequestReplyRecord = {
  scopeId: string;
  taskId: string;
  executionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  requestId: string;
  requestRevision: number;
  reply: unknown;
  authorizationBasis: unknown;
};

export class StoreConflict extends Error {
  constructor(readonly code: "IDEMPOTENCY_CONFLICT" | "STALE_REVISION" | "SESSION_BUSY" | "INVALID_STATE" | "REQUEST_EXPIRED", message: string = code) {
    super(message);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : canonical(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function now(): string { return new Date().toISOString(); }
function deadline(start: string, seconds: number): string { return new Date(Date.parse(start) + seconds * 1000).toISOString(); }
const terminalPhases = new Set<ExecutionPhase>(["completed", "failed", "cancelled", "timed_out"]);
const diagnosticCaptureLimit = 64 * 1024;
const diagnosticChunkLimit = 2 * 1024;
const diagnosticRetentionMs = 7 * 24 * 60 * 60 * 1_000;

type StartSemanticInput = Pick<StartRecord, "workspace" | "requestWorkspace" | "packet" | "model" | "profile" | "workspaceAccess" | "requestModel" | "queueTimeoutSeconds" | "executionTimeoutSeconds">;
function startSemanticHash(input: StartSemanticInput): string {
  return hashPayload({ workspace: input.requestWorkspace ?? input.workspace, workspaceAccess: input.workspaceAccess ?? "exclusive", packet: input.packet,
    model: input.requestModel ?? input.model, profile: input.profile,
    queueTimeoutSeconds: input.queueTimeoutSeconds ?? 600, executionTimeoutSeconds: input.executionTimeoutSeconds ?? 1800 });
}

type ContinueSemanticInput = Pick<ContinueRecord, "taskId" | "predecessorExecutionId" | "packet" | "contextMode">;
function continueSemanticHash(input: ContinueSemanticInput): string {
  return hashPayload({ taskId: input.taskId, predecessorExecutionId: input.predecessorExecutionId,
    packet: input.packet, contextMode: input.contextMode });
}

type CancelSemanticInput = Pick<CancelRecord, "taskId" | "executionId" | "reason" | "requester" | "deadlineOrigin">;
function cancelSemanticHash(input: CancelSemanticInput): string {
  return hashPayload({ taskId: input.taskId, executionId: input.executionId,
    reason: input.reason, requester: input.requester, deadlineOrigin: input.deadlineOrigin ?? null });
}

type ReplySemanticInput = Pick<RequestReplyRecord, "taskId" | "executionId" | "requestId" | "requestRevision" | "reply" | "authorizationBasis">;
function replySemanticHash(input: ReplySemanticInput): string {
  return hashPayload({ taskId: input.taskId, executionId: input.executionId, requestId: input.requestId,
    requestRevision: input.requestRevision, reply: input.reply, authorizationBasis: input.authorizationBasis });
}

export class SqliteTaskStore {
  private readonly db: DatabaseSync;
  private readonly saturatedDiagnostics = new Set<string>();
  private readonly overflowRecordedDiagnostics = new Set<string>();
  private readonly pendingDiagnosticBytes = new Map<string, number>();
  private diagnosticFlushTimer: NodeJS.Timeout | null = null;
  private readonly diagnosticMaintenanceTimer: NodeJS.Timeout;

  constructor(filename: string, options: { diagnosticMaintenanceIntervalMs?: number } = {}) {
    const existingDatabase = existsSync(filename);
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    const versionTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    let schemaVersion: number | null = null;
    if (versionTable) {
      const version = this.db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null };
      schemaVersion = version.version;
      if (version.version !== null && version.version > 3) {
        this.db.close();
        throw new Error(`store schema version ${version.version} is newer than this runtime supports`);
      }
    }
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    chmodSync(filename, 0o600);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(filename + suffix)) chmodSync(filename + suffix, 0o600);
    const objects = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{ name: string }>).map((row) => row.name));
    const requiredObjects = ["schema_version", "scopes", "tasks", "executions", "unresolved_session_owner",
      "backend_instances", "operations", "dispatch_intents", "creation_intents", "cancellation_intents",
      "resource_reservations", "input_requests", "artifacts", "reviews", "events", "diagnostic_logs"];
    const missingColumn = (table: string, required: string[]) => {
      const columns = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
      return required.some((name) => !columns.has(name));
    };
    const schemaNeedsUpgrade = schemaVersion !== 3 || requiredObjects.some((name) => !objects.has(name)) ||
      missingColumn("executions", ["packet_json", "frozen_prompt", "frozen_baseline_json", "report_path",
        "queue_deadline_at", "admitted_at", "execution_deadline_at", "finalization_deadline_at", "intended_outcome",
        "execution_timeout_seconds", "context_mode", "backend_config_json", "launch_contract_json", "worker_instance_id"]) ||
      missingColumn("tasks", ["workspace_access", "request_model_json"]) ||
      missingColumn("input_requests", ["created_at", "response_json", "authorization_basis_json"]) ||
      missingColumn("cancellation_intents", ["abort_acknowledged"]);
    if (existingDatabase && schemaNeedsUpgrade) {
      const backupDirectory = join(dirname(filename), "backups");
      let backupPath: string | null = null;
      try {
        mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
        backupPath = join(backupDirectory,
          `${new Date().toISOString().replaceAll(":", "-")}-schema-${schemaVersion ?? "unknown"}-to-3-${randomUUID()}.sqlite`);
        closeSync(openSync(backupPath, "wx", 0o600));
        this.db.prepare("VACUUM INTO ?").run(backupPath);
        const backupFd = openSync(backupPath, "r");
        try { fsyncSync(backupFd); } finally { closeSync(backupFd); }
        const directoryFd = openSync(backupDirectory, "r");
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      } catch (error) {
        if (backupPath) rmSync(backupPath, { force: true });
        this.db.close();
        throw new Error(`pre-migration database backup failed: ${String(error)}`);
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS scopes(scope_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(
        task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
        workspace TEXT NOT NULL, packet_json TEXT NOT NULL, model TEXT NOT NULL, profile TEXT NOT NULL,
        current_execution_id TEXT NOT NULL, created_at TEXT NOT NULL,
        workspace_access TEXT, request_model_json TEXT
      );
      CREATE TABLE IF NOT EXISTS executions(
        execution_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
        predecessor_execution_id TEXT REFERENCES executions(execution_id),
        revision INTEGER NOT NULL, phase TEXT NOT NULL, observation TEXT NOT NULL,
        backend_id TEXT, session_id TEXT, user_message_id TEXT,
        baseline_hash TEXT NOT NULL, prompt_hash TEXT NOT NULL,
        report_validity TEXT NOT NULL DEFAULT 'pending', review_status TEXT NOT NULL DEFAULT 'pending',
        final_manifest_hash TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        packet_json TEXT, frozen_prompt TEXT, frozen_baseline_json TEXT, report_path TEXT,
        queue_deadline_at TEXT, admitted_at TEXT, execution_deadline_at TEXT,
        finalization_deadline_at TEXT, intended_outcome TEXT, execution_timeout_seconds INTEGER,
        context_mode TEXT, backend_config_json TEXT, launch_contract_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS unresolved_session_owner ON executions(backend_id,session_id)
        WHERE session_id IS NOT NULL AND phase NOT IN ('completed','failed','cancelled','timed_out');
      CREATE TABLE IF NOT EXISTS backend_instances(
        backend_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, config_digest TEXT NOT NULL,
        identity_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations(
        operation_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
        operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(scope_id,operation,idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS dispatch_intents(
        execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
        backend_id TEXT NOT NULL, session_id TEXT NOT NULL, user_message_id TEXT NOT NULL,
        prompt_hash TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS creation_intents(
        execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
        backend_id TEXT NOT NULL, marker TEXT NOT NULL UNIQUE, session_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cancellation_intents(
        execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
        reason TEXT NOT NULL, requester TEXT NOT NULL, deadline_origin TEXT,
        created_at TEXT NOT NULL, abort_acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS resource_reservations(
        resource_key TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        acquired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS input_requests(
        request_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        kind TEXT NOT NULL, revision INTEGER NOT NULL, detail_json TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT, response_json TEXT, authorization_basis_json TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts(
        artifact_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, media_type TEXT NOT NULL,
        path TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews(
        review_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        disposition TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        kind TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diagnostic_logs(
        execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
        content_blob BLOB NOT NULL, original_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Early v2 databases predate these columns. ALTER TABLE preserves admitted work.
    const columns = new Set((this.db.prepare("PRAGMA table_info(executions)").all() as Array<{ name: string }>).map((row) => row.name));
    for (const [name, definition] of Object.entries({
      packet_json: "TEXT", frozen_prompt: "TEXT", frozen_baseline_json: "TEXT", report_path: "TEXT",
      queue_deadline_at: "TEXT", admitted_at: "TEXT", execution_deadline_at: "TEXT",
      finalization_deadline_at: "TEXT", intended_outcome: "TEXT", execution_timeout_seconds: "INTEGER", context_mode: "TEXT",
      backend_config_json: "TEXT", launch_contract_json: "TEXT",
      worker_instance_id: "TEXT",
    })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE executions ADD COLUMN ${name} ${definition}`);
    }
    const taskColumns = new Set((this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((row) => row.name));
    for (const [name, definition] of Object.entries({ workspace_access: "TEXT", request_model_json: "TEXT" })) {
      if (!taskColumns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    }
    const requestColumns = new Set((this.db.prepare("PRAGMA table_info(input_requests)").all() as Array<{ name: string }>).map((row) => row.name));
    for (const [name, definition] of Object.entries({ created_at: "TEXT", response_json: "TEXT", authorization_basis_json: "TEXT" })) {
      if (!requestColumns.has(name)) this.db.exec(`ALTER TABLE input_requests ADD COLUMN ${name} ${definition}`);
    }
    const cancellationColumns = new Set((this.db.prepare("PRAGMA table_info(cancellation_intents)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!cancellationColumns.has("abort_acknowledged")) this.db.exec("ALTER TABLE cancellation_intents ADD COLUMN abort_acknowledged INTEGER NOT NULL DEFAULT 0");
    this.db.prepare("UPDATE schema_version SET version=3 WHERE version<3").run();
    this.purgeExpiredDiagnostics();
    const maintenanceInterval = options.diagnosticMaintenanceIntervalMs ?? 60 * 60 * 1_000;
    if (!Number.isSafeInteger(maintenanceInterval) || maintenanceInterval <= 0)
      throw new Error("diagnostic maintenance interval must be positive");
    this.diagnosticMaintenanceTimer = setInterval(() => {
      try { this.purgeExpiredDiagnostics(); }
      catch { /* optional diagnostic retention must not stop the supervisor */ }
    }, maintenanceInterval);
    this.diagnosticMaintenanceTimer.unref();
  }

  close(): void {
    clearInterval(this.diagnosticMaintenanceTimer);
    if (this.diagnosticFlushTimer) clearTimeout(this.diagnosticFlushTimer);
    this.diagnosticFlushTimer = null;
    this.flushPendingDiagnostics();
    this.db.close();
  }

  private flushPendingDiagnostics(executionId?: string): void {
    const entries = executionId === undefined ? [...this.pendingDiagnosticBytes] :
      [[executionId, this.pendingDiagnosticBytes.get(executionId) ?? 0] as const];
    for (const [id, count] of entries) {
      if (!count) continue;
      this.db.prepare("UPDATE diagnostic_logs SET original_bytes=MIN(?,original_bytes+?),updated_at=? WHERE execution_id=?")
        .run(Number.MAX_SAFE_INTEGER, count, now(), id);
      this.pendingDiagnosticBytes.delete(id);
    }
  }

  private scheduleDiagnosticFlush(): void {
    if (this.diagnosticFlushTimer) return;
    this.diagnosticFlushTimer = setTimeout(() => {
      this.diagnosticFlushTimer = null;
      try { this.flushPendingDiagnostics(); }
      catch { this.scheduleDiagnosticFlush(); }
    }, 1_000);
    this.diagnosticFlushTimer.unref();
  }

  /** Optional private stderr capture. Raw bytes never enter material events. */
  appendDiagnostic(executionId: string, chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (this.saturatedDiagnostics.has(executionId)) {
      if (!this.overflowRecordedDiagnostics.has(executionId)) {
        this.db.prepare("UPDATE diagnostic_logs SET original_bytes=MIN(?,original_bytes+?),updated_at=? WHERE execution_id=?")
          .run(Number.MAX_SAFE_INTEGER, chunk.byteLength, now(), executionId);
        this.overflowRecordedDiagnostics.add(executionId);
        return;
      }
      this.pendingDiagnosticBytes.set(executionId,
        Math.min(Number.MAX_SAFE_INTEGER, (this.pendingDiagnosticBytes.get(executionId) ?? 0) + chunk.byteLength));
      this.scheduleDiagnosticFlush();
      return;
    }
    this.transaction(() => {
      const row = this.db.prepare("SELECT content_blob,original_bytes FROM diagnostic_logs WHERE execution_id=?")
        .get(executionId) as { content_blob: Uint8Array; original_bytes: number } | undefined;
      const retained = row ? Buffer.from(row.content_blob) : Buffer.alloc(0);
      const incoming = Buffer.from(chunk);
      const available = Math.max(0, diagnosticCaptureLimit - retained.byteLength);
      const content = available ? Buffer.concat([retained, incoming.subarray(0, available)]) : retained;
      const original = Math.min(Number.MAX_SAFE_INTEGER, (row?.original_bytes ?? 0) + incoming.byteLength);
      this.db.prepare(`INSERT INTO diagnostic_logs(execution_id,content_blob,original_bytes,updated_at)
        VALUES(?,?,?,?) ON CONFLICT(execution_id) DO UPDATE SET content_blob=excluded.content_blob,
        original_bytes=excluded.original_bytes,updated_at=excluded.updated_at`)
        .run(executionId, content, original, now());
      if (content.byteLength === diagnosticCaptureLimit) {
        this.saturatedDiagnostics.add(executionId);
        if (original > diagnosticCaptureLimit) this.overflowRecordedDiagnostics.add(executionId);
      }
    });
  }

  purgeExpiredDiagnostics(at = new Date()): number {
    this.flushPendingDiagnostics();
    const cutoff = new Date(at.getTime() - diagnosticRetentionMs).toISOString();
    const expired = this.db.prepare("SELECT execution_id FROM diagnostic_logs WHERE updated_at<?")
      .all(cutoff) as Array<{ execution_id: string }>;
    const purged = Number(this.db.prepare("DELETE FROM diagnostic_logs WHERE updated_at<?").run(cutoff).changes);
    for (const row of expired) {
      this.saturatedDiagnostics.delete(row.execution_id);
      this.overflowRecordedDiagnostics.delete(row.execution_id);
    }
    return purged;
  }

  diagnosticChunk(executionId: string, opaqueCursor: string): {
    originalBytes: number; capturedBytes: number; truncated: boolean; sha256: string;
    byteOffset: number; contentBase64: string; nextDiagnosticCursor: string | null;
  } | null {
    this.purgeExpiredDiagnostics();
    const row = this.db.prepare("SELECT content_blob,original_bytes FROM diagnostic_logs WHERE execution_id=?")
      .get(executionId) as { content_blob: Uint8Array; original_bytes: number } | undefined;
    if (!row) return null;
    const bytes = Buffer.from(row.content_blob);
    const digest = createHash("sha256").update(bytes).digest("hex");
    let offset = 0;
    if (opaqueCursor !== "start") {
      let token: { executionId?: unknown; offset?: unknown; sha256?: unknown };
      try { token = JSON.parse(Buffer.from(opaqueCursor, "base64url").toString("utf8")); }
      catch { throw new StoreConflict("INVALID_STATE"); }
      if (!token || token.executionId !== executionId || !Number.isSafeInteger(token.offset) ||
        typeof token.offset !== "number" || token.offset < 0 || token.offset > bytes.byteLength ||
        token.sha256 !== digest) throw new StoreConflict("INVALID_STATE");
      offset = token.offset;
    }
    const content = bytes.subarray(offset, offset + diagnosticChunkLimit);
    const next = offset + content.byteLength;
    return { originalBytes: row.original_bytes, capturedBytes: bytes.byteLength,
      truncated: row.original_bytes > bytes.byteLength, sha256: digest, byteOffset: offset,
      contentBase64: content.toString("base64"),
      nextDiagnosticCursor: next < bytes.byteLength
        ? Buffer.from(JSON.stringify({ executionId, offset: next, sha256: digest })).toString("base64url") : null };
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private event(executionId: string, kind: string, detail: unknown): void {
    this.db.prepare("INSERT INTO events(execution_id,kind,detail_json,created_at) VALUES(?,?,?,?)")
      .run(executionId, kind, canonical(detail), now());
  }

  start(input: StartRecord): StoredTask {
    const queueTimeoutSeconds = input.queueTimeoutSeconds ?? 600;
    const executionTimeoutSeconds = input.executionTimeoutSeconds ?? 1800;
    if (queueTimeoutSeconds <= 0 || executionTimeoutSeconds <= 0) throw new StoreConflict("INVALID_STATE");
    const payloadHash = startSemanticHash(input);
    return this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO scopes(scope_id,created_at) VALUES(?,?)").run(input.scopeId, now());
      const existing = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='start' AND idempotency_key=?")
        .get(input.scopeId, input.idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
        const result = JSON.parse(existing.result_json) as { taskId: string; executionId: string };
        const task = this.getExecution(input.scopeId, result.taskId, result.executionId);
        if (!task) throw new Error("stored idempotency result is missing");
        return task;
      }
      const taskId = input.taskId ?? `task_${randomUUID()}`;
      const executionId = input.executionId ?? `exec_${randomUUID()}`;
      const created = now();
      this.db.prepare("INSERT INTO tasks(task_id,scope_id,workspace,packet_json,model,profile,current_execution_id,created_at,workspace_access,request_model_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(taskId, input.scopeId, input.workspace, canonical(input.packet), input.model, input.profile, executionId, created,
          input.workspaceAccess ?? "exclusive", input.requestModel === undefined ? null : canonical(input.requestModel));
      this.db.prepare(`INSERT INTO executions(execution_id,task_id,revision,phase,observation,baseline_hash,prompt_hash,
        packet_json,frozen_prompt,frozen_baseline_json,report_path,queue_deadline_at,execution_timeout_seconds,backend_config_json,launch_contract_json,created_at,updated_at)
        VALUES(?,?,1,'queued','current',?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(executionId, taskId, input.baselineHash, input.promptHash, canonical(input.packet), input.frozenPrompt ?? "",
          input.frozenBaseline === undefined ? null : canonical(input.frozenBaseline), input.reportPath ?? null,
          deadline(created, queueTimeoutSeconds), executionTimeoutSeconds,
          input.backendConfig === undefined ? null : canonical(input.backendConfig),
          input.launchContract === undefined ? null : canonical(input.launchContract), created, created);
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
        .run(`op_${randomUUID()}`, input.scopeId, "start", input.idempotencyKey, payloadHash, canonical({ taskId, executionId }), created);
      this.event(executionId, "queued", { taskId });
      const task = this.get(input.scopeId, taskId);
      if (!task) throw new Error("new task missing");
      return task;
    });
  }

  findStartByKey(scopeId: string, idempotencyKey: string, semanticInput: StartSemanticInput): StoredTask | null {
    const row = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='start' AND idempotency_key=?")
      .get(scopeId, idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.payload_hash !== startSemanticHash(semanticInput)) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
    const result = JSON.parse(row.result_json) as { taskId: string; executionId: string };
    const task = this.getExecution(scopeId, result.taskId, result.executionId);
    if (!task) throw new Error("stored start execution missing");
    return task;
  }

  findContinueByKey(scopeId: string, idempotencyKey: string, semanticInput: ContinueSemanticInput): StoredTask | null {
    const row = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='continue' AND idempotency_key=?")
      .get(scopeId, idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.payload_hash !== continueSemanticHash(semanticInput)) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
    const result = JSON.parse(row.result_json) as { taskId: string; executionId: string };
    const task = this.getExecution(scopeId, result.taskId, result.executionId);
    if (!task) throw new Error("stored continuation execution missing");
    return task;
  }

  get(scopeId: string, taskId: string): StoredTask | null {
    const current = this.db.prepare("SELECT current_execution_id FROM tasks WHERE scope_id=? AND task_id=?")
      .get(scopeId, taskId) as { current_execution_id: string } | undefined;
    return current ? this.getExecution(scopeId, taskId, current.current_execution_id) : null;
  }

  getExecution(scopeId: string, taskId: string, executionId: string): StoredTask | null {
    const row = this.db.prepare(`SELECT t.task_id,t.scope_id,t.workspace,t.workspace_access,t.request_model_json,t.packet_json AS task_packet_json,t.model,t.profile,
      e.execution_id,e.predecessor_execution_id,e.context_mode,e.revision,e.phase,e.observation,e.backend_id,
      e.session_id,e.user_message_id,e.report_validity,e.review_status,e.final_manifest_hash,e.backend_config_json,e.launch_contract_json,
      e.baseline_hash,e.prompt_hash,e.frozen_prompt,e.frozen_baseline_json,e.report_path,
      e.queue_deadline_at,e.admitted_at,e.execution_deadline_at,e.finalization_deadline_at,e.intended_outcome,
      e.worker_instance_id,e.packet_json,e.created_at,e.updated_at
      FROM tasks t JOIN executions e ON e.task_id=t.task_id
      WHERE t.scope_id=? AND t.task_id=? AND e.execution_id=?`).get(scopeId, taskId, executionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id as string, executionId: row.execution_id as string, scopeId: row.scope_id as string,
      revision: row.revision as number, phase: row.phase as ExecutionPhase, observation: row.observation as Observation,
      workspace: row.workspace as string, packet: JSON.parse((row.packet_json ?? row.task_packet_json) as string),
      workspaceAccess: (row.workspace_access as StoredTask["workspaceAccess"] | null) ?? "exclusive",
      requestModel: row.request_model_json ? JSON.parse(row.request_model_json as string) : null,
      model: row.model as string, profile: row.profile as string,
      backendId: row.backend_id as string | null,
      backendConfig: row.backend_config_json ? JSON.parse(row.backend_config_json as string) as UserConfig : null,
      launchContract: row.launch_contract_json ? JSON.parse(row.launch_contract_json as string) as ManagedLaunchContract : null,
      sessionId: row.session_id as string | null, userMessageId: row.user_message_id as string | null,
      predecessorExecutionId: row.predecessor_execution_id as string | null,
      contextMode: row.context_mode as StoredTask["contextMode"],
      baselineHash: row.baseline_hash as string, promptHash: row.prompt_hash as string,
      frozenPrompt: (row.frozen_prompt as string | null) ?? "",
      frozenBaseline: row.frozen_baseline_json ? JSON.parse(row.frozen_baseline_json as string) : null,
      reportPath: row.report_path as string | null,
      queueDeadlineAt: row.queue_deadline_at as string | null,
      admittedAt: row.admitted_at as string | null,
      executionDeadlineAt: row.execution_deadline_at as string | null,
      finalizationDeadlineAt: row.finalization_deadline_at as string | null,
      intendedOutcome: row.intended_outcome as StoredTask["intendedOutcome"],
      creationIntent: this.creationIntent(executionId),
      cancellationIntent: this.cancellationIntent(executionId),
      pendingRequests: this.inputRequests(executionId, true),
      createdAt: row.created_at as string, updatedAt: row.updated_at as string,
      reportValidity: row.report_validity as StoredTask["reportValidity"],
      finalManifestHash: row.final_manifest_hash as string | null,
      reviewStatus: row.review_status as StoredTask["reviewStatus"],
      workerInstanceId: row.worker_instance_id as string | null,
    };
  }

  list(scopeId: string, limit = 20): StoredTask[] {
    return this.listPage(scopeId, { limit }).tasks;
  }

  listPage(scopeId: string, options: { limit?: number; states?: ExecutionPhase[]; cursor?: string } = {}): { tasks: StoredTask[]; nextCursor: string | null } {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreConflict("INVALID_STATE");
    const states = options.states ?? [];
    const stateHash = hashPayload([...states].sort());
    type PageCursor = { createdAt: string; taskId: string; scopeId: string; stateHash: string };
    let page: PageCursor | null = null;
    if (options.cursor) {
      try { page = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as PageCursor; }
      catch { throw new StoreConflict("INVALID_STATE"); }
      if (!page || page.scopeId !== scopeId || page.stateHash !== stateHash || typeof page.createdAt !== "string" || typeof page.taskId !== "string") {
        throw new StoreConflict("INVALID_STATE");
      }
    }
    const filters = states.length ? `AND e.phase IN (${states.map(() => "?").join(",")})` : "";
    const cursorFilter = page ? "AND (t.created_at<cursor_values.cursor_time OR (t.created_at=cursor_values.cursor_time AND t.task_id<cursor_values.cursor_task))" : "";
    // Bound cursor values in a one-row CTE so the same parameters serve both comparisons.
    const rows = this.db.prepare(`WITH cursor_values(cursor_time,cursor_task) AS (SELECT ?,?)
      SELECT t.task_id,t.created_at FROM tasks t JOIN executions e ON e.execution_id=t.current_execution_id
      CROSS JOIN cursor_values WHERE t.scope_id=? ${filters} ${cursorFilter}
      ORDER BY t.created_at DESC,t.task_id DESC LIMIT ?`)
      .all(page?.createdAt ?? null, page?.taskId ?? null, scopeId, ...states, limit + 1) as Array<{ task_id: string; created_at: string }>;
    const visible = rows.slice(0, limit);
    const tasks = visible.flatMap(({ task_id }) => { const task = this.get(scopeId, task_id); return task ? [task] : []; });
    const last = visible.at(-1);
    const nextCursor = rows.length > limit && last
      ? Buffer.from(JSON.stringify({ createdAt: last.created_at, taskId: last.task_id, scopeId, stateHash })).toString("base64url")
      : null;
    return { tasks, nextCursor };
  }

  unresolved(): StoredTask[] {
    const rows = this.db.prepare(`SELECT t.scope_id,t.task_id FROM tasks t JOIN executions e ON e.execution_id=t.current_execution_id
      WHERE e.phase NOT IN ('completed','failed','cancelled','timed_out')
        AND t.profile IN ('bounded-build','bounded-inspect') ORDER BY t.created_at`)
      .all() as Array<{ scope_id: string; task_id: string }>;
    return rows.flatMap((row) => { const task = this.get(row.scope_id, row.task_id); return task ? [task] : []; });
  }

  backendInstance(backendId: string): { backendId: string; workspace: string; configDigest: string; identity: unknown; createdAt: string } | null {
    const row = this.db.prepare("SELECT * FROM backend_instances WHERE backend_id=?").get(backendId) as Record<string, unknown> | undefined;
    return row ? { backendId: row.backend_id as string, workspace: row.workspace as string,
      configDigest: row.config_digest as string, identity: JSON.parse(row.identity_json as string), createdAt: row.created_at as string } : null;
  }

  registerBackendInstance(backendId: string, workspace: string, configDigest: string, identity: unknown): void {
    this.transaction(() => {
      const existing = this.backendInstance(backendId);
      if (existing) {
        if (existing.workspace !== workspace || existing.configDigest !== configDigest || hashPayload(existing.identity) !== hashPayload(identity)) {
          throw new StoreConflict("INVALID_STATE");
        }
        return;
      }
      this.db.prepare("INSERT INTO backend_instances VALUES(?,?,?,?,?)")
        .run(backendId, workspace, configDigest, canonical(identity), now());
    });
  }

  admit(scopeId: string, taskId: string, expectedRevision: number, resourceKeys: string[], executionTimeoutSeconds?: number): StoredTask | null {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      if (task.phase !== "queued") throw new StoreConflict("INVALID_STATE");
      const instant = now();
      if (task.queueDeadlineAt && instant >= task.queueDeadlineAt) throw new StoreConflict("INVALID_STATE");
      const keys = [...new Set(resourceKeys)].sort();
      for (const key of keys) {
        const owner = this.db.prepare("SELECT execution_id FROM resource_reservations WHERE resource_key=?")
          .get(key) as { execution_id: string } | undefined;
        if (owner && owner.execution_id !== task.executionId) return null;
      }
      for (const key of keys) this.db.prepare("INSERT OR IGNORE INTO resource_reservations VALUES(?,?,?)")
        .run(key, task.executionId, instant);
      const row = this.db.prepare("SELECT execution_timeout_seconds FROM executions WHERE execution_id=?")
        .get(task.executionId) as { execution_timeout_seconds: number | null };
      const seconds = executionTimeoutSeconds ?? row.execution_timeout_seconds ?? 1800;
      if (!Number.isInteger(seconds) || seconds <= 0) throw new StoreConflict("INVALID_STATE");
      this.db.prepare("UPDATE executions SET phase='dispatching',admitted_at=?,execution_deadline_at=?,revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(instant, deadline(instant, seconds), instant, task.executionId);
      this.event(task.executionId, "admitted", { resourceKeys: keys, executionDeadlineAt: deadline(instant, seconds) });
      return this.get(scopeId, taskId)!;
    });
  }

  creationIntent(executionId: string): CreationIntent | null {
    const row = this.db.prepare("SELECT backend_id,marker,session_id,created_at FROM creation_intents WHERE execution_id=?")
      .get(executionId) as { backend_id: string; marker: string; session_id: string | null; created_at: string } | undefined;
    return row ? { backendId: row.backend_id, marker: row.marker, sessionId: row.session_id, createdAt: row.created_at } : null;
  }

  getCreationIntent(executionId: string): CreationIntent | null { return this.creationIntent(executionId); }

  recordCreationIntent(scopeId: string, taskId: string, expectedRevision: number, backendId: string, marker: string): StoredTask {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      if (task.phase !== "dispatching" || task.sessionId || task.creationIntent) throw new StoreConflict("INVALID_STATE");
      const instant = now();
      this.db.prepare("INSERT INTO creation_intents(execution_id,backend_id,marker,created_at) VALUES(?,?,?,?)")
        .run(task.executionId, backendId, marker, instant);
      this.db.prepare("UPDATE executions SET backend_id=?,revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(backendId, instant, task.executionId);
      this.event(task.executionId, "creation_intent", { backendId, marker });
      return this.get(scopeId, taskId)!;
    });
  }

  reserve(executionId: string, keys: string[]): boolean {
    return this.transaction(() => {
      for (const key of [...new Set(keys)].sort()) {
        const owner = this.db.prepare("SELECT execution_id FROM resource_reservations WHERE resource_key=?")
          .get(key) as { execution_id: string } | undefined;
        if (owner && owner.execution_id !== executionId) return false;
      }
      for (const key of [...new Set(keys)].sort()) {
        this.db.prepare("INSERT OR IGNORE INTO resource_reservations VALUES(?,?,?)").run(key, executionId, now());
      }
      return true;
    });
  }

  release(executionId: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT phase FROM executions WHERE execution_id=?")
        .get(executionId) as { phase: ExecutionPhase } | undefined;
      if (!row || !terminalPhases.has(row.phase)) throw new StoreConflict("INVALID_STATE");
      this.db.prepare("DELETE FROM resource_reservations WHERE execution_id=?").run(executionId);
    });
  }

  dispatchIntent(executionId: string): { backendId: string; sessionId: string; messageId: string; acknowledged: boolean } | null {
    const row = this.db.prepare("SELECT backend_id,session_id,user_message_id,acknowledged FROM dispatch_intents WHERE execution_id=?")
      .get(executionId) as { backend_id: string; session_id: string; user_message_id: string; acknowledged: number } | undefined;
    return row ? { backendId: row.backend_id, sessionId: row.session_id, messageId: row.user_message_id, acknowledged: Boolean(row.acknowledged) } : null;
  }

  events(executionId: string, afterCursor = 0, limit = 100): Array<{ cursor: number; kind: string; detail: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT sequence,kind,detail_json,created_at FROM events WHERE execution_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(executionId, afterCursor, limit) as Array<{ sequence: number; kind: string; detail_json: string; created_at: string }>;
    return rows.map((row) => ({ cursor: row.sequence, kind: row.kind, detail: JSON.parse(row.detail_json), createdAt: row.created_at }));
  }

  /** Public event page. A cursor advances only past events actually returned. */
  eventPage(executionId: string, afterCursor = 0): {
    events: PublicEvent[];
    cursor: number;
    hasMore: boolean;
  } {
    const limit = 100;
    const maxBytes = 4_096;
    const rows = this.db.prepare("SELECT sequence,kind,detail_json,created_at FROM events WHERE execution_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(executionId, afterCursor, limit + 1) as Array<{ sequence: number; kind: string; detail_json: string; created_at: string }>;
    const events: PublicEvent[] = [];
    let bytes = 2; // JSON array brackets
    for (const row of rows.slice(0, limit)) {
      const full = { cursor: row.sequence, kind: row.kind, detail: JSON.parse(row.detail_json), createdAt: row.created_at };
      let event: PublicEvent = full;
      if (Buffer.byteLength(JSON.stringify(full)) > 1_024) {
        const source = full.detail && typeof full.detail === "object" && !Array.isArray(full.detail)
          ? full.detail as Record<string, unknown> : {};
        const blockers: Record<string, string> = {};
        for (const key of ["blocker", "reason", "error", "code", "message"]) {
          if (source[key] === undefined) continue;
          const value = typeof source[key] === "string" ? source[key] : JSON.stringify(source[key]);
          blockers[key] = Buffer.from(value).subarray(0, 256).toString("utf8");
        }
        const digest = createHash("sha256").update(row.detail_json).digest("hex");
        const detailCursor = Buffer.from(JSON.stringify({ executionId, sequence: row.sequence, offset: 0,
          sha256: digest })).toString("base64url");
        event = { cursor: row.sequence, kind: row.kind, createdAt: row.created_at,
          detail: { ...blockers, preview: Buffer.from(row.detail_json).subarray(0, 256).toString("utf8") },
          detailTruncated: { originalBytes: Buffer.byteLength(row.detail_json),
            sha256: digest, cursor: detailCursor } };
        if (Buffer.byteLength(JSON.stringify(event)) > maxBytes - 2) {
          // The exact JSON stays available through detailCursor even when every
          // blocker field is enormous. This bounded envelope always progresses.
          event = { cursor: row.sequence, kind: row.kind.slice(0, 64), createdAt: row.created_at,
            detail: { truncated: true }, detailTruncated: event.detailTruncated! };
        }
      }
      const eventBytes = Buffer.byteLength(JSON.stringify(event)) + (events.length ? 1 : 0);
      if (bytes + eventBytes > maxBytes) break;
      events.push(event);
      bytes += eventBytes;
    }
    return { events, cursor: events.at(-1)?.cursor ?? afterCursor, hasMore: events.length < rows.length };
  }

  eventDetailChunk(executionId: string, opaqueCursor: string): {
    eventCursor: number; sha256: string; originalBytes: number; byteOffset: number;
    contentBase64: string; nextDetailCursor: string | null;
  } {
    let token: { executionId?: unknown; sequence?: unknown; offset?: unknown; sha256?: unknown };
    try { token = JSON.parse(Buffer.from(opaqueCursor, "base64url").toString("utf8")); }
    catch { throw new StoreConflict("INVALID_STATE"); }
    if (!token || token.executionId !== executionId || !Number.isSafeInteger(token.sequence) ||
      !Number.isSafeInteger(token.offset) || typeof token.offset !== "number" || token.offset < 0 ||
      typeof token.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(token.sha256)) throw new StoreConflict("INVALID_STATE");
    const row = this.db.prepare("SELECT detail_json FROM events WHERE execution_id=? AND sequence=?")
      .get(executionId, token.sequence as number) as { detail_json: string } | undefined;
    if (!row) throw new StoreConflict("INVALID_STATE");
    const bytes = Buffer.from(row.detail_json);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== token.sha256 || token.offset > bytes.byteLength) throw new StoreConflict("INVALID_STATE");
    const offset = token.offset;
    const chunk = bytes.subarray(offset, offset + 2_048);
    const next = offset + chunk.byteLength;
    return { eventCursor: token.sequence as number, sha256: digest, originalBytes: bytes.byteLength,
      byteOffset: offset, contentBase64: chunk.toString("base64"),
      nextDetailCursor: next < bytes.byteLength
        ? Buffer.from(JSON.stringify({ executionId, sequence: token.sequence, offset: next, sha256: digest })).toString("base64url")
        : null };
  }

  transition(scopeId: string, taskId: string, expectedRevision: number, phase: ExecutionPhase, observation: Observation, detail: unknown = {}): StoredTask {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      const instant = now();
      this.db.prepare("UPDATE executions SET phase=?,observation=?,finalization_deadline_at=CASE WHEN ?='finalizing' AND finalization_deadline_at IS NULL THEN ? ELSE finalization_deadline_at END,revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(phase, observation, phase, deadline(instant, task.backendConfig?.limits.finalization_timeout_seconds ?? 60), instant, task.executionId);
      this.event(task.executionId, phase, detail);
      return this.get(scopeId, taskId)!;
    });
  }

  beginFinalization(scopeId: string, taskId: string, expectedRevision: number,
    intendedOutcome: "completed" | "failed" | "cancelled" | "timed_out", detail: unknown = {}): StoredTask {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      if (!["running", "waiting_input", "cancelling", "dispatching"].includes(task.phase)) throw new StoreConflict("INVALID_STATE");
      const instant = now();
      this.db.prepare("UPDATE executions SET phase='finalizing',observation='current',intended_outcome=?,finalization_deadline_at=?,revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(intendedOutcome, deadline(instant, task.backendConfig?.limits.finalization_timeout_seconds ?? 60), instant, task.executionId);
      this.event(task.executionId, "finalizing", { intendedOutcome, detail });
      return this.get(scopeId, taskId)!;
    });
  }

  bindSession(scopeId: string, taskId: string, expectedRevision: number, backendId: string, sessionId: string): StoredTask {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      if (task.sessionId) {
        if (task.backendId === backendId && task.sessionId === sessionId) return task;
        // A resume follow-up owns the predecessor's exact session, but runs in
        // a new worker whose policy names only this execution's report path.
        if (task.backendId !== null || task.contextMode !== "resume" || task.sessionId !== sessionId ||
          !task.predecessorExecutionId) throw new StoreConflict("SESSION_BUSY");
        const predecessor = this.getExecution(task.scopeId, task.taskId, task.predecessorExecutionId);
        if (!predecessor || !terminalPhases.has(predecessor.phase) || predecessor.sessionId !== sessionId)
          throw new StoreConflict("INVALID_STATE");
      }
      if (task.backendId && task.backendId !== backendId) throw new StoreConflict("INVALID_STATE");
      if (task.creationIntent && task.creationIntent.backendId !== backendId) throw new StoreConflict("INVALID_STATE");
      try {
        this.db.prepare("UPDATE executions SET backend_id=?,session_id=?,revision=revision+1,updated_at=? WHERE execution_id=?")
          .run(backendId, sessionId, now(), task.executionId);
        this.db.prepare("UPDATE creation_intents SET session_id=? WHERE execution_id=?").run(sessionId, task.executionId);
      } catch (error) {
        if (String(error).includes("UNIQUE")) throw new StoreConflict("SESSION_BUSY");
        throw error;
      }
      this.event(task.executionId, "session_bound", { backendId, sessionId });
      return this.get(scopeId, taskId)!;
    });
  }

  recordDispatchIntent(scopeId: string, taskId: string, expectedRevision: number, backendId: string, sessionId: string, messageId: string, workerInstanceId?: string | null): StoredTask {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      if (task.backendId !== backendId || task.sessionId !== sessionId || !["queued", "dispatching"].includes(task.phase)) throw new StoreConflict("INVALID_STATE");
      if (task.userMessageId || this.dispatchIntent(task.executionId)) throw new StoreConflict("INVALID_STATE");
      const execution = this.db.prepare("SELECT prompt_hash,worker_instance_id FROM executions WHERE execution_id=?")
        .get(task.executionId) as { prompt_hash: string; worker_instance_id: string | null };
      this.db.prepare("INSERT INTO dispatch_intents VALUES(?,?,?,?,?,0,?)")
        .run(task.executionId, backendId, sessionId, messageId, execution.prompt_hash, now());
      const updates = ["user_message_id=?", "phase='dispatching'", "revision=revision+1", "updated_at=?"];
      const params: any[] = [messageId, now()];
      if (workerInstanceId && !execution.worker_instance_id) {
        updates.push("worker_instance_id=?");
        params.push(workerInstanceId);
      }
      params.push(task.executionId);
      this.db.prepare(`UPDATE executions SET ${updates.join(",")} WHERE execution_id=?`).run(...params);
      this.event(task.executionId, "dispatch_intent", { messageId, workerInstanceId: workerInstanceId ?? null });
      return this.get(scopeId, taskId)!;
    });
  }

  acknowledgeDispatch(executionId: string): void {
    this.transaction(() => {
      const existing = this.dispatchIntent(executionId);
      if (!existing) throw new StoreConflict("INVALID_STATE");
      if (existing.acknowledged) return;
      this.db.prepare("UPDATE dispatch_intents SET acknowledged=1 WHERE execution_id=?").run(executionId);
      this.event(executionId, "dispatch_acknowledged", {});
    });
  }

  finalize(scopeId: string, taskId: string, expectedRevision: number, outcome: Extract<ExecutionPhase, "completed" | "failed" | "cancelled" | "timed_out">,
    reportValidity: StoredTask["reportValidity"], finalManifestHash: string | null): StoredTask {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      if (task.phase !== "finalizing") throw new StoreConflict("INVALID_STATE");
      if (task.intendedOutcome && task.intendedOutcome !== outcome) throw new StoreConflict("INVALID_STATE");
      this.db.prepare("UPDATE executions SET phase=?,report_validity=?,final_manifest_hash=?,revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(outcome, reportValidity, finalManifestHash, now(), task.executionId);
      this.db.prepare("DELETE FROM resource_reservations WHERE execution_id=?").run(task.executionId);
      this.db.prepare("UPDATE input_requests SET status='expired' WHERE execution_id=? AND status='pending'").run(task.executionId);
      this.db.prepare("UPDATE input_requests SET status='unconfirmed' WHERE execution_id=? AND status='responding'").run(task.executionId);
      this.event(task.executionId, "finalized", { outcome, reportValidity, finalManifestHash });
      return this.get(scopeId, taskId)!;
    });
  }

  continueTask(input: ContinueRecord): StoredTask {
    const queueTimeoutSeconds = input.queueTimeoutSeconds ?? 600;
    const executionTimeoutSeconds = input.executionTimeoutSeconds ?? 1800;
    if (queueTimeoutSeconds <= 0 || executionTimeoutSeconds <= 0) throw new StoreConflict("INVALID_STATE");
    const payloadHash = continueSemanticHash(input);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='continue' AND idempotency_key=?")
        .get(input.scopeId, input.idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
        const result = JSON.parse(existing.result_json) as { taskId: string; executionId: string };
        const task = this.getExecution(input.scopeId, result.taskId, result.executionId);
        if (!task) throw new Error("stored continuation is missing");
        return task;
      }
      const predecessor = this.get(input.scopeId, input.taskId);
      if (!predecessor || predecessor.executionId !== input.predecessorExecutionId) throw new StoreConflict("INVALID_STATE");
      if (!["bounded-build", "bounded-inspect"].includes(predecessor.profile)) throw new StoreConflict("INVALID_STATE");
      if (predecessor.revision !== input.expectedRevision) throw new StoreConflict("STALE_REVISION");
      if (!terminalPhases.has(predecessor.phase) || predecessor.pendingRequests.length > 0) throw new StoreConflict("INVALID_STATE");
      const packet = input.packet as { objective?: unknown };
      const original = this.db.prepare("SELECT packet_json FROM tasks WHERE task_id=?")
        .get(input.taskId) as { packet_json: string };
      const objective = (JSON.parse(original.packet_json) as { objective?: unknown }).objective;
      if (packet.objective !== objective) throw new StoreConflict("INVALID_STATE");
      if (input.contextMode === "resume" && (!predecessor.backendId || !predecessor.sessionId)) throw new StoreConflict("INVALID_STATE");
      const executionId = input.executionId ?? `exec_${randomUUID()}`;
      const instant = now();
      const backendId = null;
      const sessionId = input.contextMode === "resume" ? predecessor.sessionId : null;
      this.db.prepare(`INSERT INTO executions(execution_id,task_id,predecessor_execution_id,revision,phase,observation,backend_id,session_id,
        baseline_hash,prompt_hash,packet_json,frozen_prompt,frozen_baseline_json,report_path,queue_deadline_at,
        execution_timeout_seconds,context_mode,backend_config_json,launch_contract_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(executionId, input.taskId, predecessor.executionId, 1, "queued", "current", backendId, sessionId,
          input.baselineHash, input.promptHash, canonical(input.packet), input.frozenPrompt,
          input.frozenBaseline === undefined ? null : canonical(input.frozenBaseline), input.reportPath ?? null,
          deadline(instant, queueTimeoutSeconds), executionTimeoutSeconds, input.contextMode,
          input.backendConfig === undefined ? null : canonical(input.backendConfig),
          input.launchContract === undefined ? null : canonical(input.launchContract), instant, instant);
      this.db.prepare("UPDATE tasks SET current_execution_id=? WHERE task_id=?")
        .run(executionId, input.taskId);
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
        .run(`op_${randomUUID()}`, input.scopeId, "continue", input.idempotencyKey, payloadHash,
          canonical({ taskId: input.taskId, executionId }), instant);
      this.event(executionId, "queued", { taskId: input.taskId, predecessorExecutionId: predecessor.executionId, contextMode: input.contextMode });
      return this.get(input.scopeId, input.taskId)!;
    });
  }

  cancellationIntent(executionId: string): CancellationIntent | null {
    const row = this.db.prepare("SELECT reason,requester,deadline_origin,created_at,abort_acknowledged FROM cancellation_intents WHERE execution_id=?")
      .get(executionId) as { reason: string; requester: string; deadline_origin: string | null; created_at: string; abort_acknowledged: number } | undefined;
    return row ? { reason: row.reason, requester: row.requester, deadlineOrigin: row.deadline_origin,
      createdAt: row.created_at, abortAcknowledged: Boolean(row.abort_acknowledged) } : null;
  }

  acknowledgeAbort(executionId: string): void {
    this.transaction(() => {
      const intent = this.cancellationIntent(executionId);
      if (!intent) throw new StoreConflict("INVALID_STATE");
      if (intent.abortAcknowledged) return;
      this.db.prepare("UPDATE cancellation_intents SET abort_acknowledged=1 WHERE execution_id=?").run(executionId);
      this.event(executionId, "abort_acknowledged", {});
    });
  }

  cancellationEvent(executionId: string, kind: CancellationEventKind): { detail: Record<string, unknown>; createdAt: string } | null {
    const row = this.db.prepare("SELECT detail_json,created_at FROM events WHERE execution_id=? AND kind=? ORDER BY sequence DESC LIMIT 1")
      .get(executionId, kind) as { detail_json: string; created_at: string } | undefined;
    return row ? { detail: JSON.parse(row.detail_json), createdAt: row.created_at } : null;
  }

  recordCancellationEvent(executionId: string, kind: CancellationEventKind,
    detail: CancellationDiagnostic | { backendId: string; instanceId: string }): void {
    this.transaction(() => {
      const previous = this.cancellationEvent(executionId, kind);
      if (previous && canonical(previous.detail) === canonical(detail) &&
        (kind !== "cancellation_diagnostic" || Date.now() - Date.parse(previous.createdAt) < 30_000)) return;
      this.event(executionId, kind, detail);
      this.db.prepare("UPDATE executions SET revision=revision+1,updated_at=? WHERE execution_id=?").run(now(), executionId);
    });
  }

  ownsResource(executionId: string, resourceKey: string): boolean {
    const row = this.db.prepare("SELECT execution_id FROM resource_reservations WHERE resource_key=?")
      .get(resourceKey) as { execution_id: string } | undefined;
    return row?.execution_id === executionId;
  }

  cancelTask(input: CancelRecord): StoredTask {
    const payloadHash = cancelSemanticHash(input);
    return this.transaction(() => {
      const candidate = this.getExecution(input.scopeId, input.taskId, input.executionId);
      if (candidate && !["bounded-build", "bounded-inspect"].includes(candidate.profile)) throw new StoreConflict("INVALID_STATE");
      const existing = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='cancel' AND idempotency_key=?")
        .get(input.scopeId, input.idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
        const original = JSON.parse(existing.result_json) as { taskId: string; executionId: string };
        const task = this.getExecution(input.scopeId, original.taskId, original.executionId);
        if (!task) throw new Error("cancelled execution missing");
        return task;
      }
      const task = this.get(input.scopeId, input.taskId);
      if (!task || task.executionId !== input.executionId) throw new StoreConflict("INVALID_STATE");
      if (task.revision !== input.expectedRevision) throw new StoreConflict("STALE_REVISION");
      if (terminalPhases.has(task.phase) || task.phase === "finalizing" || task.cancellationIntent) throw new StoreConflict("INVALID_STATE");
      const instant = now();
      this.db.prepare("INSERT INTO cancellation_intents(execution_id,reason,requester,deadline_origin,created_at) VALUES(?,?,?,?,?)")
        .run(task.executionId, input.reason, input.requester, input.deadlineOrigin ?? null, instant);
      const phase = task.phase === "queued" ? (input.deadlineOrigin ? "timed_out" : "cancelled") : "cancelling";
      this.db.prepare("UPDATE executions SET phase=?,revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(phase, instant, task.executionId);
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
        .run(`op_${randomUUID()}`, input.scopeId, "cancel", input.idempotencyKey, payloadHash,
          canonical({ taskId: input.taskId, executionId: input.executionId }), instant);
      this.event(task.executionId, "cancellation_requested", { reason: input.reason, requester: input.requester, phase });
      return this.get(input.scopeId, input.taskId)!;
    });
  }

  findCancelByKey(scopeId: string, idempotencyKey: string, semanticInput: CancelSemanticInput): StoredTask | null {
    const row = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='cancel' AND idempotency_key=?")
      .get(scopeId, idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.payload_hash !== cancelSemanticHash(semanticInput)) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
    const result = JSON.parse(row.result_json) as { taskId: string; executionId: string };
    const task = this.getExecution(scopeId, result.taskId, result.executionId);
    if (!task) throw new Error("stored cancellation execution missing");
    return task;
  }

  inputRequests(executionId: string, pendingOnly = false): StoredInputRequest[] {
    const rows = this.db.prepare(`SELECT * FROM input_requests WHERE execution_id=? ${pendingOnly ? "AND status IN ('pending','responding')" : ""} ORDER BY created_at,request_id`)
      .all(executionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ requestId: row.request_id as string, executionId: row.execution_id as string,
      kind: row.kind as StoredInputRequest["kind"], revision: row.revision as number,
      detail: JSON.parse(row.detail_json as string), status: row.status as StoredInputRequest["status"],
      createdAt: (row.created_at as string | null) ?? "", response: row.response_json ? JSON.parse(row.response_json as string) : null,
      authorizationBasis: row.authorization_basis_json ? JSON.parse(row.authorization_basis_json as string) : null }));
  }

  upsertInputRequest(scopeId: string, taskId: string, executionId: string, requestId: string,
    kind: "permission" | "question", detail: unknown): StoredInputRequest {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task || task.executionId !== executionId || !["running", "waiting_input", "dispatching", "cancelling"].includes(task.phase)) {
        throw new StoreConflict("INVALID_STATE");
      }
      const previous = this.inputRequests(executionId).find((request) => request.requestId === requestId);
      if (previous && previous.kind === kind && hashPayload(previous.detail) === hashPayload(detail) && previous.status === "pending") return previous;
      if (previous && previous.status !== "pending") return previous;
      const instant = now();
      if (previous) {
        this.db.prepare("UPDATE input_requests SET revision=revision+1,detail_json=? WHERE request_id=?")
          .run(canonical(detail), requestId);
      } else {
        this.db.prepare("INSERT INTO input_requests(request_id,execution_id,kind,revision,detail_json,status,created_at) VALUES(?,?,?,1,?,'pending',?)")
          .run(requestId, executionId, kind, canonical(detail), instant);
      }
      this.db.prepare("UPDATE executions SET phase=?,revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(task.cancellationIntent ? "cancelling" : "waiting_input", instant, executionId);
      this.event(executionId, "input_request", { requestId, kind, revision: previous ? previous.revision + 1 : 1 });
      return this.inputRequests(executionId).find((request) => request.requestId === requestId)!;
    });
  }

  respondToRequest(input: RequestReplyRecord): StoredTask {
    const payloadHash = replySemanticHash(input);
    return this.transaction(() => {
      const candidate = this.getExecution(input.scopeId, input.taskId, input.executionId);
      if (candidate && !["bounded-build", "bounded-inspect"].includes(candidate.profile)) throw new StoreConflict("INVALID_STATE");
      const existing = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='respond' AND idempotency_key=?")
        .get(input.scopeId, input.idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
        const original = JSON.parse(existing.result_json) as { taskId: string; executionId: string };
        const task = this.getExecution(input.scopeId, original.taskId, original.executionId);
        if (!task) throw new Error("request response execution missing");
        return task;
      }
      const task = this.get(input.scopeId, input.taskId);
      if (!task || task.executionId !== input.executionId) throw new StoreConflict("INVALID_STATE");
      if (task.revision !== input.expectedRevision) throw new StoreConflict("STALE_REVISION");
      const request = this.inputRequests(input.executionId).find((item) => item.requestId === input.requestId);
      if (!request || request.status !== "pending") throw new StoreConflict("REQUEST_EXPIRED", "request is no longer pending; observe the execution");
      if (request.revision !== input.requestRevision) throw new StoreConflict("REQUEST_EXPIRED", "request revision is stale; observe the execution");
      if (task.cancellationIntent) {
        if (task.phase !== "cancelling" || request.kind !== "permission" || input.reply !== "deny" ||
          this.cancellationEvent(task.executionId, "cancellation_recovery_intent"))
          throw new StoreConflict("INVALID_STATE", "cancellation permits only permission denial before worker termination begins");
      } else if (task.phase !== "waiting_input") throw new StoreConflict("INVALID_STATE", "execution is not waiting for input");
      const binding = request.detail as { sessionId?: unknown; type?: unknown };
      if (binding.sessionId !== task.sessionId || binding.type !== request.kind)
        throw new StoreConflict("REQUEST_EXPIRED", "request binding does not match the execution; observe the execution");
      const instant = now();
      this.db.prepare("UPDATE input_requests SET status='responding',response_json=?,authorization_basis_json=? WHERE request_id=?")
        .run(canonical(input.reply), canonical(input.authorizationBasis), input.requestId);
      this.db.prepare("UPDATE executions SET revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(instant, input.executionId);
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
        .run(`op_${randomUUID()}`, input.scopeId, "respond", input.idempotencyKey, payloadHash,
          canonical({ taskId: input.taskId, executionId: input.executionId, requestId: input.requestId }), instant);
      this.event(input.executionId, "input_response_intent", { requestId: input.requestId, requestRevision: input.requestRevision });
      return this.get(input.scopeId, input.taskId)!;
    });
  }

  findResponseByKey(scopeId: string, idempotencyKey: string, semanticInput: ReplySemanticInput): StoredTask | null {
    const row = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='respond' AND idempotency_key=?")
      .get(scopeId, idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.payload_hash !== replySemanticHash(semanticInput)) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
    const result = JSON.parse(row.result_json) as { taskId: string; executionId: string };
    const task = this.getExecution(scopeId, result.taskId, result.executionId);
    if (!task) throw new Error("stored response execution missing");
    return task;
  }

  acknowledgeInputResponse(executionId: string, requestId: string): void {
    this.transaction(() => {
      const request = this.inputRequests(executionId).find((item) => item.requestId === requestId);
      if (!request || request.status !== "responding") throw new StoreConflict("REQUEST_EXPIRED");
      this.db.prepare("UPDATE input_requests SET status='responded' WHERE request_id=?").run(requestId);
      this.event(executionId, "input_response_acknowledged", { requestId });
    });
  }

  /** The exact request vanished after a recorded reply intent, but delivery was never acknowledged. */
  resolveUnconfirmedInputResponse(executionId: string, requestId: string): void {
    this.transaction(() => {
      const request = this.inputRequests(executionId).find((item) => item.requestId === requestId);
      if (!request || request.status !== "responding") return;
      this.db.prepare("UPDATE input_requests SET status='unconfirmed' WHERE execution_id=? AND request_id=? AND status='responding'")
        .run(executionId, requestId);
      this.event(executionId, "input_response_unconfirmed", { requestId, reason: "request_absent_after_reply_intent" });
    });
  }

  expireInputRequest(executionId: string, requestId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE input_requests SET status='expired' WHERE execution_id=? AND request_id=? AND status IN ('pending','responding')")
        .run(executionId, requestId);
      this.event(executionId, "input_request_expired", { requestId });
    });
  }

  expireMissingInputRequests(executionId: string, pendingIds: string[]): string[] {
    return this.transaction(() => {
      const known = new Set(pendingIds);
      const expired = this.inputRequests(executionId, true).filter((request) => !known.has(request.requestId));
      for (const request of expired) {
        const status = request.status === "responding" ? "unconfirmed" : "expired";
        this.db.prepare("UPDATE input_requests SET status=? WHERE execution_id=? AND request_id=?")
          .run(status, executionId, request.requestId);
        this.event(executionId, status === "unconfirmed" ? "input_response_unconfirmed" : "input_request_expired",
          { requestId: request.requestId, reason: "request_absent_in_exact_session_snapshot" });
      }
      if (expired.length) this.db.prepare("UPDATE executions SET revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(now(), executionId);
      return expired.map((request) => request.requestId);
    });
  }

  artifactsForExecution(executionId: string): ArtifactRegistration[] {
    const rows = this.db.prepare("SELECT artifact_id,execution_id,sha256,byte_length,media_type,path FROM artifacts WHERE execution_id=? ORDER BY created_at,artifact_id")
      .all(executionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ artifactId: row.artifact_id as string, executionId: row.execution_id as string,
      sha256: row.sha256 as string, byteLength: row.byte_length as number, mediaType: row.media_type as string,
      path: row.path as string }));
  }

  registerArtifact(entry: ArtifactRegistration): void {
    this.transaction(() => {
      this.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)")
        .run(entry.artifactId, entry.executionId, entry.sha256, entry.byteLength, entry.mediaType, entry.path, now());
      this.event(entry.executionId, "artifact_registered", { artifactId: entry.artifactId, sha256: entry.sha256 });
    });
  }

  artifact(executionId: string, artifactId: string): ArtifactRegistration | null {
    const row = this.db.prepare("SELECT artifact_id,execution_id,sha256,byte_length,media_type,path FROM artifacts WHERE execution_id=? AND artifact_id=?")
      .get(executionId, artifactId) as Record<string, unknown> | undefined;
    return row ? {
      artifactId: row.artifact_id as string, executionId: row.execution_id as string,
      sha256: row.sha256 as string, byteLength: row.byte_length as number,
      mediaType: row.media_type as string, path: row.path as string,
    } : null;
  }

  artifactById(artifactId: string): ArtifactRegistration | null {
    const row = this.db.prepare("SELECT execution_id FROM artifacts WHERE artifact_id=?")
      .get(artifactId) as { execution_id: string } | undefined;
    return row ? this.artifact(row.execution_id, artifactId) : null;
  }

  allArtifacts(): ArtifactRegistration[] {
    const rows = this.db.prepare("SELECT execution_id,artifact_id FROM artifacts ORDER BY created_at,artifact_id")
      .all() as Array<{ execution_id: string; artifact_id: string }>;
    return rows.flatMap((row) => {
      const entry = this.artifact(row.execution_id, row.artifact_id);
      return entry ? [entry] : [];
    });
  }

  recordReview(scopeId: string, taskId: string, expectedRevision: number, idempotencyKey: string, review: Review, executionId?: string): StoredTask {
    const selectedExecutionId = executionId ?? this.get(scopeId, taskId)?.executionId;
    const payloadHash = hashPayload({ taskId, executionId: selectedExecutionId, review });
    return this.transaction(() => {
      const candidate = selectedExecutionId ? this.getExecution(scopeId, taskId, selectedExecutionId) : null;
      if (candidate && !["bounded-build", "bounded-inspect"].includes(candidate.profile)) throw new StoreConflict("INVALID_STATE");
      const existing = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='review' AND idempotency_key=?")
        .get(scopeId, idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
        const original = JSON.parse(existing.result_json) as { taskId: string; executionId: string };
        const task = this.getExecution(scopeId, original.taskId, original.executionId);
        if (!task) throw new Error("review task missing");
        return task;
      }
      const task = selectedExecutionId ? this.getExecution(scopeId, taskId, selectedExecutionId) : null;
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      if (review.disposition === "pending") throw new StoreConflict("INVALID_STATE");
      if (review.disposition === "accepted") {
        if (task.phase !== "completed" || task.reportValidity !== "valid" || !task.finalManifestHash ||
          task.finalManifestHash !== review.final_manifest_sha256 || task.baselineHash !== review.starting_state_sha256) {
          throw new StoreConflict("INVALID_STATE");
        }
        const packet = task.packet as { acceptance_criteria?: Array<{ id: string; required: boolean }> };
        const declared = new Map<string, boolean>();
        for (const criterion of packet.acceptance_criteria ?? []) {
          if (declared.has(criterion.id)) throw new StoreConflict("INVALID_STATE");
          declared.set(criterion.id, criterion.required);
        }
        const artifacts = this.artifactsForExecution(task.executionId);
        const byId = new Map(artifacts.map((entry) => [entry.artifactId, entry]));
        // A valid report is only reviewable after its frozen report, summary, and
        // final manifest registrations have been committed for this execution.
        if (!artifacts.some((entry) => entry.sha256 === task.finalManifestHash && entry.mediaType === "application/json") ||
          artifacts.filter((entry) => entry.mediaType === "application/json").length < 2 ||
          !artifacts.some((entry) => entry.mediaType === "text/markdown")) throw new StoreConflict("INVALID_STATE");
        const reviewed = new Set<string>();
        for (const criterion of review.criteria) {
          if (!declared.has(criterion.id) || reviewed.has(criterion.id)) throw new StoreConflict("INVALID_STATE");
          reviewed.add(criterion.id);
          if (criterion.result === "satisfied" && criterion.evidence.length === 0) throw new StoreConflict("INVALID_STATE");
          for (const reference of criterion.evidence) {
            const match = /^artifact:([^@\s]+)@sha256:([0-9a-f]{64})$/.exec(reference);
            if (!match || byId.get(match[1]!)?.sha256 !== match[2]) throw new StoreConflict("INVALID_STATE");
          }
        }
        for (const [id, required] of declared) {
          if (!required) continue;
          const result = review.criteria.find((item) => item.id === id);
          if (!result || result.result !== "satisfied" || result.evidence.length === 0) throw new StoreConflict("INVALID_STATE");
        }
      }
      const created = now();
      this.db.prepare("INSERT INTO reviews VALUES(?,?,?,?,?)")
        .run(`review_${randomUUID()}`, task.executionId, review.disposition, canonical(review), created);
      this.db.prepare("UPDATE executions SET review_status=?,revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(review.disposition, created, task.executionId);
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
        .run(`op_${randomUUID()}`, scopeId, "review", idempotencyKey, payloadHash, canonical({ taskId, executionId: task.executionId }), created);
      this.event(task.executionId, "review_recorded", { disposition: review.disposition });
      return this.getExecution(scopeId, taskId, task.executionId)!;
    });
  }
}
