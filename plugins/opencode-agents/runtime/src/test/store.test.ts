import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteTaskStore, StoreConflict } from "../store.js";

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
