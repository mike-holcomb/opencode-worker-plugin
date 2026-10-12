import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteTaskStore, StoreConflict } from "../store.js";
import { DatabaseSync } from "node:sqlite";

test("a lost start response is recovered by the same key after reopening the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-store-"));
  const filename = join(dir, "state.sqlite");
  const input = {
    scopeId: "coord_test", idempotencyKey: "start-test-00000001", workspace: "/tmp/project",
    packet: { title: "Check behavior", objective: "Inspect" }, model: "llama.cpp/laguna-s-21",
    profile: "bounded-inspect", baselineHash: "a".repeat(64), promptHash: "b".repeat(64),
  };
  try {
    const firstStore = new SqliteTaskStore(filename);
    const first = firstStore.start(input);
    firstStore.close();
    const recoveredStore = new SqliteTaskStore(filename);
    const recovered = recoveredStore.start({ ...input, packet: { objective: "Inspect", title: "Check behavior" } });
    assert.equal(recovered.taskId, first.taskId);
    assert.equal(recovered.executionId, first.executionId);
    assert.equal(recoveredStore.list(input.scopeId).length, 1);
    assert.equal(recoveredStore.findStartByKey(input.scopeId, input.idempotencyKey, {
      workspace: input.workspace, packet: input.packet, model: input.model, profile: input.profile,
    })?.executionId, first.executionId);
    assert.equal(recoveredStore.start({ ...input, baselineHash: "changed", promptHash: "changed" }).executionId, first.executionId);
    assert.deepEqual(recoveredStore.events(first.executionId).map((event) => event.kind), ["queued"]);
    assert.throws(() => recoveredStore.start({ ...input, model: "another/model" }), (error) =>
      error instanceof StoreConflict && error.code === "IDEMPOTENCY_CONFLICT");
    assert.equal(recoveredStore.list(input.scopeId).length, 1);
    recoveredStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dispatch intent and exact session survive a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-store-"));
  const filename = join(dir, "state.sqlite");
  try {
    let store = new SqliteTaskStore(filename);
    let task = store.start({
      scopeId: "coord_test", idempotencyKey: "start-test-00000002", workspace: "/tmp/project",
      packet: { title: "Probe" }, model: "llama.cpp/laguna-s-21", profile: "bounded-inspect",
      baselineHash: "a".repeat(64), promptHash: "b".repeat(64),
    });
    task = store.bindSession(task.scopeId, task.taskId, task.revision, "backend-1", "session-1");
    task = store.recordDispatchIntent(task.scopeId, task.taskId, task.revision, "backend-1", "session-1", "message-1");
    store.close();
    store = new SqliteTaskStore(filename);
    const recovered = store.get(task.scopeId, task.taskId);
    assert.equal(recovered?.phase, "dispatching");
    assert.equal(recovered?.sessionId, "session-1");
    assert.equal(recovered?.userMessageId, "message-1");
    assert.deepEqual(store.events(task.executionId).map((event) => event.kind), ["queued", "session_bound", "dispatch_intent"]);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("accepted review requires valid frozen evidence and every required criterion", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-store-"));
  try {
    const store = new SqliteTaskStore(join(dir, "state.sqlite"));
    let task = store.start({
      scopeId: "coord_review", idempotencyKey: "start-review-000001", workspace: "/tmp/project",
      packet: { acceptance_criteria: [{ id: "criterion-1", required: true }] },
      model: "llama.cpp/laguna-s-21", profile: "bounded-build", baselineHash: "a".repeat(64), promptHash: "b".repeat(64),
    });
    task = store.transition(task.scopeId, task.taskId, task.revision, "finalizing", "current");
    task = store.finalize(task.scopeId, task.taskId, task.revision, "completed", "valid", "c".repeat(64));
    assert.throws(() => store.recordReview(task.scopeId, task.taskId, task.revision, "review-no-artifacts-0001", {
      disposition: "accepted", rationale: "Unsupported", criteria: [{ id: "criterion-1", result: "satisfied", evidence: ["artifact:missing@sha256:" + "d".repeat(64)] }],
      starting_state_sha256: "a".repeat(64), final_manifest_sha256: "c".repeat(64), freshness: "current",
      integration_checks: [], coverage_limits: [], unresolved_issues: [], next_action: "Inspect evidence",
    }), (error) => error instanceof StoreConflict && error.code === "INVALID_STATE");
    const reportHash = "d".repeat(64);
    const summaryHash = "e".repeat(64);
    store.registerArtifact({ artifactId: "artifact_report", executionId: task.executionId, sha256: reportHash,
      byteLength: 1, mediaType: "application/json", path: join(dir, "report") });
    store.registerArtifact({ artifactId: "artifact_summary", executionId: task.executionId, sha256: summaryHash,
      byteLength: 1, mediaType: "text/markdown", path: join(dir, "summary") });
    store.registerArtifact({ artifactId: "artifact_manifest", executionId: task.executionId, sha256: "c".repeat(64),
      byteLength: 1, mediaType: "application/json", path: join(dir, "manifest") });
    const evidence = `artifact:artifact_report@sha256:${reportHash}`;
    const review = {
      disposition: "accepted" as const, rationale: "Checked", criteria: [{ id: "criterion-1", result: "satisfied" as const, evidence: [evidence] }],
      starting_state_sha256: "a".repeat(64), final_manifest_sha256: "c".repeat(64), freshness: "current",
      integration_checks: [], coverage_limits: [], unresolved_issues: [], next_action: "Integrate",
    };
    assert.throws(() => store.recordReview(task.scopeId, task.taskId, task.revision, "review-key-0000001", {
      ...review, criteria: [{ id: "criterion-1", result: "not_checked", evidence: [] }],
    }), (error) => error instanceof StoreConflict && error.code === "INVALID_STATE");
    const invalidCriteria = [
      [{ id: "criterion-1", result: "satisfied" as const, evidence: ["artifact:123"] }],
      [{ id: "criterion-1", result: "satisfied" as const, evidence: [`artifact:artifact_report@sha256:${"f".repeat(64)}`] }],
      [{ id: "criterion-1", result: "satisfied" as const, evidence: [`artifact:artifact_unknown@sha256:${reportHash}`] }],
      [{ id: "criterion-1", result: "satisfied" as const, evidence: [evidence] },
        { id: "criterion-1", result: "satisfied" as const, evidence: [evidence] }],
      [{ id: "criterion-1", result: "satisfied" as const, evidence: [evidence] },
        { id: "not-declared", result: "satisfied" as const, evidence: [evidence] }],
    ];
    for (const [index, criteria] of invalidCriteria.entries()) {
      assert.throws(() => store.recordReview(task.scopeId, task.taskId, task.revision,
        `review-invalid-${index}-000001`, { ...review, criteria }),
      (error) => error instanceof StoreConflict && error.code === "INVALID_STATE");
    }
    const other = store.start({ scopeId: task.scopeId, idempotencyKey: "start-other-review-0001",
      workspace: "/tmp/elsewhere", packet: { acceptance_criteria: [] }, model: "local/model",
      profile: "bounded-inspect", baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
    store.registerArtifact({ artifactId: "artifact_other", executionId: other.executionId, sha256: reportHash,
      byteLength: 1, mediaType: "application/json", path: join(dir, "other") });
    assert.throws(() => store.recordReview(task.scopeId, task.taskId, task.revision, "review-wrong-exec-0001", {
      ...review, criteria: [{ id: "criterion-1", result: "satisfied", evidence: [`artifact:artifact_other@sha256:${reportHash}`] }],
    }), (error) => error instanceof StoreConflict && error.code === "INVALID_STATE");
    assert.equal(store.get(task.scopeId, task.taskId)?.reviewStatus, "pending");
    const reviewed = store.recordReview(task.scopeId, task.taskId, task.revision, "review-key-0000002", review);
    assert.equal(reviewed.reviewStatus, "accepted");
    assert.equal(store.recordReview(task.scopeId, task.taskId, task.revision, "review-key-0000002", review).revision, reviewed.revision);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resource reservations are atomic and unrelated work remains eligible", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-store-"));
  try {
    const store = new SqliteTaskStore(join(dir, "state.sqlite"));
    const make = (key: string) => store.start({
      scopeId: "coord_resources", idempotencyKey: key, workspace: "/tmp/project",
      packet: {}, model: "llama.cpp/laguna-s-21", profile: "bounded-build",
      baselineHash: "a".repeat(64), promptHash: "b".repeat(64),
    });
    const first = make("reserve-first-0001");
    const blocked = make("reserve-block-0001");
    const unrelated = make("reserve-other-0001");
    assert.equal(store.reserve(first.executionId, ["workspace:A", "port:1234"]), true);
    assert.equal(store.reserve(blocked.executionId, ["workspace:A", "service:db"]), false);
    assert.equal(store.reserve(unrelated.executionId, ["service:db"]), true);
    assert.throws(() => store.release(first.executionId),
      (error) => error instanceof StoreConflict && error.code === "INVALID_STATE");
    store.transition(first.scopeId, first.taskId, first.revision, "failed", "current");
    store.transition(unrelated.scopeId, unrelated.taskId, unrelated.revision, "failed", "current");
    store.release(first.executionId);
    store.release(unrelated.executionId);
    assert.equal(store.reserve(blocked.executionId, ["workspace:A", "service:db"]), true);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("admission freezes deadlines and creation intent before a lost session acknowledgement", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-store-"));
  const filename = join(dir, "state.sqlite");
  try {
    let store = new SqliteTaskStore(filename);
    let task = store.start({ taskId: "task_fixed", executionId: "exec_fixed", scopeId: "coord_recovery",
      idempotencyKey: "start-recovery-00001", workspace: "/tmp/project", packet: { objective: "Inspect" },
      model: "local/model", profile: "bounded-inspect", baselineHash: "a".repeat(64), promptHash: "b".repeat(64),
      frozenPrompt: "Exact frozen prompt", frozenBaseline: { tree: "a" }, queueTimeoutSeconds: 60, executionTimeoutSeconds: 120 });
    assert.equal(task.taskId, "task_fixed");
    assert.equal(task.executionId, "exec_fixed");
    assert.equal(task.frozenPrompt, "Exact frozen prompt");
    assert.deepEqual(task.frozenBaseline, { tree: "a" });
    task = store.admit(task.scopeId, task.taskId, task.revision, ["workspace:/tmp/project"], 120)!;
    assert.equal(Date.parse(task.executionDeadlineAt!) - Date.parse(task.admittedAt!), 120_000);
    task = store.recordCreationIntent(task.scopeId, task.taskId, task.revision, "backend-fixed", "marker-fixed");
    store.close();
    store = new SqliteTaskStore(filename);
    const recovered = store.get(task.scopeId, task.taskId)!;
    assert.deepEqual(recovered.creationIntent, { backendId: "backend-fixed", marker: "marker-fixed", sessionId: null,
      createdAt: task.creationIntent!.createdAt });
    assert.equal(recovered.executionDeadlineAt, task.executionDeadlineAt);
    assert.throws(() => store.admit(recovered.scopeId, recovered.taskId, recovered.revision, []),
      (error) => error instanceof StoreConflict && error.code === "INVALID_STATE");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pagination filters before limiting and historical executions survive a follow-up", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-store-"));
  try {
    const store = new SqliteTaskStore(join(dir, "state.sqlite"));
    const start = (id: string) => store.start({ taskId: id, executionId: `exec_${id}`, scopeId: "coord_page",
      idempotencyKey: `start-${id}-000000000000`, workspace: "/tmp/project", packet: { objective: "Inspect" },
      model: "local/model", profile: "bounded-inspect", baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
    const first = start("first");
    const second = start("second");
    const third = start("third");
    const failed = store.transition(second.scopeId, second.taskId, second.revision, "failed", "current");
    const page1 = store.listPage("coord_page", { limit: 1, states: ["queued"] });
    assert.equal(page1.tasks.length, 1);
    assert.ok(page1.nextCursor);
    const page2 = store.listPage("coord_page", { limit: 1, states: ["queued"], cursor: page1.nextCursor! });
    assert.equal(page2.tasks.length, 1);
    assert.notEqual(page1.tasks[0]!.taskId, page2.tasks[0]!.taskId);
    assert.deepEqual(new Set([page1.tasks[0]!.taskId, page2.tasks[0]!.taskId]), new Set([first.taskId, third.taskId]));
    assert.equal(page2.nextCursor, null);
    assert.throws(() => store.listPage("coord_page", { limit: 1, states: ["failed"], cursor: page1.nextCursor! }),
      (error) => error instanceof StoreConflict && error.code === "INVALID_STATE");
    const follow = store.continueTask({ scopeId: failed.scopeId, taskId: failed.taskId,
      predecessorExecutionId: failed.executionId, expectedRevision: failed.revision,
      idempotencyKey: "continue-second-0000001", executionId: "exec_second_follow", packet: { objective: "Inspect" },
      contextMode: "fresh", baselineHash: "c".repeat(64), promptHash: "d".repeat(64), frozenPrompt: "Follow-up" });
    assert.equal(follow.executionId, "exec_second_follow");
    assert.equal(store.getExecution(failed.scopeId, failed.taskId, failed.executionId)?.phase, "failed");
    assert.equal(store.continueTask({ scopeId: failed.scopeId, taskId: failed.taskId,
      predecessorExecutionId: failed.executionId, expectedRevision: failed.revision,
      idempotencyKey: "continue-second-0000001", packet: { objective: "Inspect" },
      contextMode: "fresh", baselineHash: "c".repeat(64), promptHash: "d".repeat(64), frozenPrompt: "Follow-up" }).executionId,
    follow.executionId);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resume follow-up keeps the exact session but binds a new execution-scoped backend after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-resume-policy-"));
  const filename = join(dir, "state.sqlite");
  try {
    let store = new SqliteTaskStore(filename);
    const firstPath = join(dir, "reports", "exec_first");
    const nextPath = join(dir, "reports", "exec_next");
    let first = store.start({ taskId: "task_resume", executionId: "exec_first", scopeId: "scope_resume",
      idempotencyKey: "start-resume-policy-0001", workspace: dir, packet: { objective: "Inspect" },
      model: "local/model", profile: "bounded-inspect", baselineHash: "a", promptHash: "b",
      reportPath: firstPath, launchContract: { configContent: "{}", effectiveConfigSha256: "first", reportPath: firstPath } });
    first = store.bindSession(first.scopeId, first.taskId, first.revision, "backend_first", "ses_exact");
    first = store.recordDispatchIntent(first.scopeId, first.taskId, first.revision,
      "backend_first", "ses_exact", "msg_exact");
    first = store.transition(first.scopeId, first.taskId, first.revision, "completed", "current");
    const next = store.continueTask({ scopeId: first.scopeId, taskId: first.taskId,
      predecessorExecutionId: first.executionId, expectedRevision: first.revision,
      idempotencyKey: "continue-resume-policy-0001", executionId: "exec_next",
      packet: { objective: "Inspect" }, contextMode: "resume", baselineHash: "c", promptHash: "d",
      frozenPrompt: "Follow-up", reportPath: nextPath,
      launchContract: { configContent: "{}", effectiveConfigSha256: "next", reportPath: nextPath } });
    assert.equal(next.sessionId, "ses_exact");
    assert.equal(next.backendId, null);
    assert.equal(next.launchContract?.reportPath, nextPath);
    store.close();
    store = new SqliteTaskStore(filename);
    const recovered = store.get("scope_resume", "task_resume")!;
    const rebound = store.bindSession(recovered.scopeId, recovered.taskId, recovered.revision,
      "backend_next", "ses_exact");
    assert.equal(rebound.backendId, "backend_next");
    assert.equal(store.getExecution(first.scopeId, first.taskId, first.executionId)?.backendId, "backend_first");
    assert.throws(() => store.bindSession(rebound.scopeId, rebound.taskId, rebound.revision,
      "backend_other", "ses_exact"), (error) => error instanceof StoreConflict && error.code === "SESSION_BUSY");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cancellation and request response intents survive restart without releasing ownership", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-store-"));
  const filename = join(dir, "state.sqlite");
  try {
    let store = new SqliteTaskStore(filename);
    let task = store.start({ scopeId: "coord_cancel", idempotencyKey: "start-cancel-0000001",
      workspace: "/tmp/project", packet: { objective: "Inspect" }, model: "local/model", profile: "bounded-inspect",
      baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
    task = store.admit(task.scopeId, task.taskId, task.revision, ["workspace:project"])!;
    task = store.transition(task.scopeId, task.taskId, task.revision, "running", "current");
    const request = store.upsertInputRequest(task.scopeId, task.taskId, task.executionId, "permission-1", "permission", { action: "read" });
    task = store.get(task.scopeId, task.taskId)!;
    task = store.respondToRequest({ scopeId: task.scopeId, taskId: task.taskId, executionId: task.executionId,
      expectedRevision: task.revision, idempotencyKey: "response-test-0000001", requestId: request.requestId,
      requestRevision: request.revision, reply: "allow_once", authorizationBasis: { source: "task" } });
    assert.equal(task.pendingRequests[0]?.status, "responding");
    assert.equal(store.upsertInputRequest(task.scopeId, task.taskId, task.executionId,
      "permission-1", "permission", { action: "read" }).status, "responding");
    assert.equal(store.findResponseByKey(task.scopeId, "response-test-0000001", { taskId: task.taskId,
      executionId: task.executionId, requestId: request.requestId, requestRevision: request.revision,
      reply: "allow_once", authorizationBasis: { source: "task" } })?.executionId, task.executionId);
    task = store.cancelTask({ scopeId: task.scopeId, taskId: task.taskId, executionId: task.executionId,
      expectedRevision: task.revision, idempotencyKey: "cancel-test-00000001", reason: "stop", requester: "parent" });
    assert.equal(task.phase, "cancelling");
    store.close();
    store = new SqliteTaskStore(filename);
    const another = store.start({ scopeId: "coord_cancel", idempotencyKey: "start-other-00000001",
      workspace: "/tmp/project", packet: { objective: "Inspect" }, model: "local/model", profile: "bounded-inspect",
      baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
    assert.equal(store.admit(another.scopeId, another.taskId, another.revision, ["workspace:project"]), null);
    assert.equal(store.get(task.scopeId, task.taskId)?.cancellationIntent?.reason, "stop");
    assert.equal(store.get(task.scopeId, task.taskId)?.cancellationIntent?.abortAcknowledged, false);
    store.acknowledgeAbort(task.executionId);
    store.acknowledgeAbort(task.executionId);
    assert.equal(store.get(task.scopeId, task.taskId)?.cancellationIntent?.abortAcknowledged, true);
    assert.equal(store.findCancelByKey(task.scopeId, "cancel-test-00000001", { taskId: task.taskId,
      executionId: task.executionId, reason: "stop", requester: "parent" })?.phase, "cancelling");
    assert.equal(store.inputRequests(task.executionId)[0]?.status, "responding");
    task = store.beginFinalization(task.scopeId, task.taskId, task.revision, "cancelled");
    assert.equal(task.intendedOutcome, "cancelled");
    assert.equal(store.admit(another.scopeId, another.taskId, another.revision, ["workspace:project"]), null);
    assert.throws(() => store.finalize(task.scopeId, task.taskId, task.revision, "completed", "missing", null),
      (error) => error instanceof StoreConflict && error.code === "INVALID_STATE");
    task = store.finalize(task.scopeId, task.taskId, task.revision, "cancelled", "missing", null);
    assert.equal(task.phase, "cancelled");
    assert.equal(store.admit(another.scopeId, another.taskId, another.revision, ["workspace:project"])?.phase, "dispatching");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("old v2 database is backed up before schema changes and retains its data", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-store-"));
  const filename = join(dir, "state.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE executions(execution_id TEXT PRIMARY KEY,task_id TEXT,predecessor_execution_id TEXT,revision INTEGER,phase TEXT,observation TEXT,backend_id TEXT,session_id TEXT,user_message_id TEXT,baseline_hash TEXT,prompt_hash TEXT,report_validity TEXT,review_status TEXT,final_manifest_hash TEXT,created_at TEXT,updated_at TEXT)");
    db.exec("CREATE TABLE input_requests(request_id TEXT PRIMARY KEY,execution_id TEXT,kind TEXT,revision INTEGER,detail_json TEXT,status TEXT)");
    db.exec("CREATE TABLE migration_marker(value TEXT); INSERT INTO migration_marker VALUES('committed in WAL')");
    const store = new SqliteTaskStore(filename);
    const backups = readdirSync(join(dir, "backups"));
    assert.equal(backups.length, 1);
    const backupPath = join(dir, "backups", backups[0]!);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal((backup.prepare("SELECT value FROM migration_marker").get() as { value: string }).value, "committed in WAL");
    assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='schema_version'").get(), undefined);
    assert.equal((backup.prepare("PRAGMA table_info(executions)").all() as Array<{ name: string }>).some((column) => column.name === "frozen_prompt"), false);
    backup.close();
    db.close();
    const upgraded = new DatabaseSync(filename, { readOnly: true });
    assert.equal((upgraded.prepare("SELECT value FROM migration_marker").get() as { value: string }).value, "committed in WAL");
    assert.equal((upgraded.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number }).version, 3);
    upgraded.close();
    const task = store.start({ scopeId: "coord_migrate", idempotencyKey: "start-migrate-000001", workspace: "/tmp/project",
      packet: { objective: "Inspect" }, model: "local/model", profile: "bounded-inspect",
      baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
    assert.equal(task.phase, "queued");
    store.close();
    const reopenedStore = new SqliteTaskStore(filename);
    reopenedStore.close();
    assert.equal(readdirSync(join(dir, "backups")).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("version 3 database with missing v2 objects receives a backup before repair", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-store-"));
  const filename = join(dir, "state.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(3)");
    db.close();
    const store = new SqliteTaskStore(filename);
    store.close();
    const backupPath = join(dir, "backups", readdirSync(join(dir, "backups"))[0]!);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get(), undefined);
    backup.close();
    const upgraded = new DatabaseSync(filename, { readOnly: true });
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get());
    upgraded.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed pre-migration backup leaves an existing schema untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-store-"));
  const filename = join(dir, "state.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE migration_marker(value TEXT); INSERT INTO migration_marker VALUES('before')");
    db.close();
    writeFileSync(join(dir, "backups"), "not a directory");
    assert.throws(() => new SqliteTaskStore(filename), /pre-migration database backup failed/);
    const reopened = new DatabaseSync(filename, { readOnly: true });
    assert.equal((reopened.prepare("SELECT value FROM migration_marker").get() as { value: string }).value, "before");
    assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE name='schema_version'").get(), undefined);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
