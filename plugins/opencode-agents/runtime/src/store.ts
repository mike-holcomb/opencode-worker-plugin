import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Review } from "./contracts.js";
import type { ArtifactRegistration } from "./artifacts.js";

export type ExecutionPhase = "queued" | "dispatching" | "running" | "waiting_input" | "cancelling" | "finalizing" | "completed" | "failed" | "cancelled" | "timed_out";
export type Observation = "current" | "reconciling" | "unknown";

export type StoredTask = {
  taskId: string;
  executionId: string;
  scopeId: string;
  revision: number;
  phase: ExecutionPhase;
  observation: Observation;
  workspace: string;
  packet: unknown;
  model: string;
  profile: string;
  sessionId: string | null;
  userMessageId: string | null;
  reportValidity: "pending" | "valid" | "missing" | "invalid";
  finalManifestHash: string | null;
  reviewStatus: "pending" | "accepted" | "needs_correction" | "rejected" | "awaiting_evidence";
};

export type StartRecord = {
  scopeId: string;
  idempotencyKey: string;
  workspace: string;
  packet: unknown;
  model: string;
  profile: string;
  baselineHash: string;
  promptHash: string;
};

export class StoreConflict extends Error {
  constructor(readonly code: "IDEMPOTENCY_CONFLICT" | "STALE_REVISION" | "SESSION_BUSY" | "INVALID_STATE") {
    super(code);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function now(): string { return new Date().toISOString(); }

export class SqliteTaskStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS scopes(scope_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(
        task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
        workspace TEXT NOT NULL, packet_json TEXT NOT NULL, model TEXT NOT NULL, profile TEXT NOT NULL,
        current_execution_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions(
        execution_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
        predecessor_execution_id TEXT REFERENCES executions(execution_id),
        revision INTEGER NOT NULL, phase TEXT NOT NULL, observation TEXT NOT NULL,
        backend_id TEXT, session_id TEXT, user_message_id TEXT,
        baseline_hash TEXT NOT NULL, prompt_hash TEXT NOT NULL,
        report_validity TEXT NOT NULL DEFAULT 'pending', review_status TEXT NOT NULL DEFAULT 'pending',
        final_manifest_hash TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS resource_reservations(
        resource_key TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        acquired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS input_requests(
        request_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        kind TEXT NOT NULL, revision INTEGER NOT NULL, detail_json TEXT NOT NULL, status TEXT NOT NULL
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
    `);
  }

  close(): void { this.db.close(); }

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
    const payloadHash = hashPayload(input);
    return this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO scopes(scope_id,created_at) VALUES(?,?)").run(input.scopeId, now());
      const existing = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='start' AND idempotency_key=?")
        .get(input.scopeId, input.idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
        const result = JSON.parse(existing.result_json) as { taskId: string };
        const task = this.get(input.scopeId, result.taskId);
        if (!task) throw new Error("stored idempotency result is missing");
        return task;
      }
      const taskId = `task_${randomUUID()}`;
      const executionId = `exec_${randomUUID()}`;
      const created = now();
      this.db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)")
        .run(taskId, input.scopeId, input.workspace, canonical(input.packet), input.model, input.profile, executionId, created);
      this.db.prepare("INSERT INTO executions(execution_id,task_id,revision,phase,observation,baseline_hash,prompt_hash,created_at,updated_at) VALUES(?,?,1,'queued','current',?,?,?,?)")
        .run(executionId, taskId, input.baselineHash, input.promptHash, created, created);
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
        .run(`op_${randomUUID()}`, input.scopeId, "start", input.idempotencyKey, payloadHash, canonical({ taskId, executionId }), created);
      this.event(executionId, "queued", { taskId });
      const task = this.get(input.scopeId, taskId);
      if (!task) throw new Error("new task missing");
      return task;
    });
  }

  get(scopeId: string, taskId: string): StoredTask | null {
    const row = this.db.prepare(`SELECT t.task_id,t.scope_id,t.workspace,t.packet_json,t.model,t.profile,
      e.execution_id,e.revision,e.phase,e.observation,e.session_id,e.user_message_id,e.report_validity,e.review_status,e.final_manifest_hash
      FROM tasks t JOIN executions e ON e.execution_id=t.current_execution_id
      WHERE t.scope_id=? AND t.task_id=?`).get(scopeId, taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id as string, executionId: row.execution_id as string, scopeId: row.scope_id as string,
      revision: row.revision as number, phase: row.phase as ExecutionPhase, observation: row.observation as Observation,
      workspace: row.workspace as string, packet: JSON.parse(row.packet_json as string),
      model: row.model as string, profile: row.profile as string,
      sessionId: row.session_id as string | null, userMessageId: row.user_message_id as string | null,
      reportValidity: row.report_validity as StoredTask["reportValidity"],
      finalManifestHash: row.final_manifest_hash as string | null,
      reviewStatus: row.review_status as StoredTask["reviewStatus"],
    };
  }

  list(scopeId: string, limit = 20): StoredTask[] {
    const rows = this.db.prepare("SELECT task_id FROM tasks WHERE scope_id=? ORDER BY created_at DESC LIMIT ?")
      .all(scopeId, limit) as Array<{ task_id: string }>;
    return rows.flatMap(({ task_id }) => { const task = this.get(scopeId, task_id); return task ? [task] : []; });
  }

  unresolved(): StoredTask[] {
    const rows = this.db.prepare(`SELECT t.scope_id,t.task_id FROM tasks t JOIN executions e ON e.execution_id=t.current_execution_id
      WHERE e.phase NOT IN ('completed','failed','cancelled','timed_out') ORDER BY t.created_at`)
      .all() as Array<{ scope_id: string; task_id: string }>;
    return rows.flatMap((row) => { const task = this.get(row.scope_id, row.task_id); return task ? [task] : []; });
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
    this.transaction(() => { this.db.prepare("DELETE FROM resource_reservations WHERE execution_id=?").run(executionId); });
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

  transition(scopeId: string, taskId: string, expectedRevision: number, phase: ExecutionPhase, observation: Observation, detail: unknown = {}): StoredTask {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      this.db.prepare("UPDATE executions SET phase=?,observation=?,revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(phase, observation, now(), task.executionId);
      this.event(task.executionId, phase, detail);
      return this.get(scopeId, taskId)!;
    });
  }

  bindSession(scopeId: string, taskId: string, expectedRevision: number, backendId: string, sessionId: string): StoredTask {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      try {
        this.db.prepare("UPDATE executions SET backend_id=?,session_id=?,revision=revision+1,updated_at=? WHERE execution_id=?")
          .run(backendId, sessionId, now(), task.executionId);
      } catch (error) {
        if (String(error).includes("UNIQUE")) throw new StoreConflict("SESSION_BUSY");
        throw error;
      }
      this.event(task.executionId, "session_bound", { backendId, sessionId });
      return this.get(scopeId, taskId)!;
    });
  }

  recordDispatchIntent(scopeId: string, taskId: string, expectedRevision: number, backendId: string, sessionId: string, messageId: string): StoredTask {
    return this.transaction(() => {
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      const execution = this.db.prepare("SELECT prompt_hash FROM executions WHERE execution_id=?")
        .get(task.executionId) as { prompt_hash: string };
      this.db.prepare("INSERT INTO dispatch_intents VALUES(?,?,?,?,?,0,?)")
        .run(task.executionId, backendId, sessionId, messageId, execution.prompt_hash, now());
      this.db.prepare("UPDATE executions SET user_message_id=?,phase='dispatching',revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(messageId, now(), task.executionId);
      this.event(task.executionId, "dispatch_intent", { messageId });
      return this.get(scopeId, taskId)!;
    });
  }

  acknowledgeDispatch(executionId: string): void {
    this.transaction(() => {
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
      this.db.prepare("UPDATE executions SET phase=?,report_validity=?,final_manifest_hash=?,revision=revision+1,updated_at=? WHERE execution_id=?")
        .run(outcome, reportValidity, finalManifestHash, now(), task.executionId);
      this.event(task.executionId, "finalized", { outcome, reportValidity, finalManifestHash });
      return this.get(scopeId, taskId)!;
    });
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

  recordReview(scopeId: string, taskId: string, expectedRevision: number, idempotencyKey: string, review: Review): StoredTask {
    const payloadHash = hashPayload({ taskId, review });
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT payload_hash,result_json FROM operations WHERE scope_id=? AND operation='review' AND idempotency_key=?")
        .get(scopeId, idempotencyKey) as { payload_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new StoreConflict("IDEMPOTENCY_CONFLICT");
        const original = JSON.parse(existing.result_json) as { taskId: string };
        const task = this.get(scopeId, original.taskId);
        if (!task) throw new Error("review task missing");
        return task;
      }
      const task = this.get(scopeId, taskId);
      if (!task) throw new Error("task not found");
      if (task.revision !== expectedRevision) throw new StoreConflict("STALE_REVISION");
      if (review.disposition === "pending") throw new StoreConflict("INVALID_STATE");
      if (review.disposition === "accepted") {
        if (task.phase !== "completed" || task.reportValidity !== "valid" || !task.finalManifestHash || task.finalManifestHash !== review.final_manifest_sha256) {
          throw new StoreConflict("INVALID_STATE");
        }
        const packet = task.packet as { acceptance_criteria?: Array<{ id: string; required: boolean }> };
        for (const criterion of packet.acceptance_criteria ?? []) {
          if (!criterion.required) continue;
          const result = review.criteria.find((item) => item.id === criterion.id);
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
      return this.get(scopeId, taskId)!;
    });
  }
}
