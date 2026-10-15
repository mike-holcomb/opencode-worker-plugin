import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../artifacts.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore } from "../store.js";
import { SdkOpenCodeBackend } from "../opencode-backend.js";
import { ProgressManager } from "../progress.js";

const checkpoint = { stage: "verifying" as const, summary: "Milestone verified", completed: ["Traced inputs"], remaining: ["Check output"], blocker: null, evidence_refs: [] };

test("progress delta reads and progress waits leave lifecycle, revision and events untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "progress-api-"));
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  try {
    const service = new SupervisorService(store, new ArtifactStore(join(root, "artifacts")));
    const task = store.start({ scopeId: "scope", idempotencyKey: "progress-api-12345678", workspace: root,
      packet: {}, model: "local/model", profile: "bounded-inspect", baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
    const before = store.get("scope", task.taskId);
    const eventsBefore = store.events(task.executionId);
    const request = { scope_id: "scope", task_id: task.taskId, execution_id: task.executionId };
    const empty = await service.handle("get_progress", request) as any;
    assert.equal(empty.availability, "not_enabled");
    assert.deepEqual(empty.updates, []);
    assert.equal(empty.runtime.observed_at, null);
    service.progress.register(task.executionId, "supported");
    const cursor = service.progress.hint(task.executionId).progress_cursor;
    const waiting = service.handle("wait_tasks", { scope_id: "scope", targets: [{ task_id: task.taskId,
      execution_id: task.executionId, after_cursor: eventsBefore.at(-1)!.cursor, after_progress_cursor: cursor }], timeout_ms: 500 });
    service.progress.append(task.executionId, "part_one", checkpoint);
    const waited = await waiting as any;
    assert.equal(waited.timed_out, false);
    assert.deepEqual(waited.changed[0].events, []);
    assert.ok(waited.changed[0].progress_cursor);
    assert.equal(waited.changed[0].updates, undefined);
    const delta = await service.handle("get_progress", { ...request, after_cursor: cursor }) as any;
    assert.equal(delta.scope_id, "scope");
    assert.equal(delta.execution_id, task.executionId);
    assert.equal(delta.updates[0].summary, checkpoint.summary);
    const after = await service.handle("get_progress", { ...request, after_cursor: delta.next_cursor }) as any;
    assert.deepEqual(after.updates, []);
    assert.equal(after.snapshot, null);
    assert.equal(after.next_cursor, delta.next_cursor);
    assert.deepEqual(store.get("scope", task.taskId), before);
    assert.deepEqual(store.events(task.executionId), eventsBefore);
    await assert.rejects(service.handle("get_progress", { ...request, execution_id: "unrelated" }), { code: "INVALID_INPUT" });
    await assert.rejects(service.handle("get_progress", { ...request, after_cursor: "malformed" }), { code: "INVALID_INPUT" });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("SDK accepts only completed checkpoint parts attributed to the exact originating turn", async () => {
  const backend = new SdkOpenCodeBackend("http://127.0.0.1:1", "/tmp", "backend");
  const part = { id: "part_one", sessionID: "session", messageID: "assistant", type: "tool", tool: "report_progress",
    state: { status: "completed", metadata: { opencode_agents_progress: checkpoint }, output: "Never exposed raw output" } };
  let messageReads = 0;
  const info = { id: "assistant", sessionID: "session", role: "assistant", parentID: "origin" };
  Object.assign(backend, { client: { session: { message: async () => { messageReads++; return { data: { info, parts: [part] } }; } } } });
  const event = { type: "message.part.updated", sessionId: "session", data: { properties: { part } } };
  assert.deepEqual(await backend.readCheckpoint(event, "session", "origin"), { sourceId: "part_one", checkpoint });
  assert.equal(await backend.readCheckpoint(event, "session", "predecessor"), null);
  assert.equal(await backend.readCheckpoint(event, "other", "origin"), null);
  const reads = messageReads;
  for (const changed of [{ tool: "bash" }, { type: "text" }, { state: { status: "running" } },
    { state: { status: "completed", metadata: { opencode_agents_progress: { ...checkpoint, summary: "x".repeat(601) } } } }]) {
    assert.equal(await backend.readCheckpoint({ ...event, data: { properties: { part: { ...part, ...changed } } } }, "session", "origin"), null);
  }
  assert.equal(messageReads, reads, "unrelated/invalid events do not trigger SDK message reads");
});

test("progress-aware waits do not repeatedly wake after eviction recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "progress-wait-recovery-"));
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  try {
    let now = 0;
    const service = new SupervisorService(store, new ArtifactStore(join(root, "artifacts")));
    const progress = new ProgressManager({ now: () => now, terminalTtlMs: 100 });
    Object.assign(service, { progress });
    const task = store.start({ scopeId: "scope", idempotencyKey: "progress-wait-12345678", workspace: root,
      packet: {}, model: "local/model", profile: "bounded-inspect", baselineHash: "a", promptHash: "b" });
    progress.register(task.executionId, "supported"); progress.append(task.executionId, "before", checkpoint);
    const expired = progress.hint(task.executionId).progress_cursor;
    progress.markTerminal(task.executionId); now += 100; progress.maintain();
    const target = { task_id: task.taskId, execution_id: task.executionId,
      after_cursor: store.events(task.executionId).at(-1)!.cursor, after_progress_cursor: expired };
    const changed = await service.handle("wait_tasks", { scope_id: "scope", targets: [target], timeout_ms: 50 }) as any;
    assert.equal(changed.timed_out, false);
    const gap = progress.read(task.executionId, { after_cursor: expired });
    assert.equal(changed.changed[0].progress_cursor, gap.next_cursor);
    const before = store.get("scope", task.taskId);
    const waiting = { scope_id: "scope", targets: [{ ...target, after_progress_cursor: gap.next_cursor }], timeout_ms: 50 };
    assert.deepEqual(await service.handle("wait_tasks", waiting), { timed_out: true, changed: [] });
    assert.deepEqual(store.get("scope", task.taskId), before);
    progress.register(task.executionId, "supported"); progress.append(task.executionId, "after", checkpoint);
    assert.equal((await service.handle("wait_tasks", waiting) as any).timed_out, false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
