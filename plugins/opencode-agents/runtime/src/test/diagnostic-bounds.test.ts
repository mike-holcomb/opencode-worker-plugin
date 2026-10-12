import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../artifacts.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore, StoreConflict } from "../store.js";

test("T26: oversized private diagnostics use bounded cursors without hiding material blockers", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-diagnostic-bounds-"));
  try {
    const store = new SqliteTaskStore(join(root, "state.sqlite"));
    const service = new SupervisorService(store, new ArtifactStore(join(root, "artifacts")));
    let task = store.start({ scopeId: "scope", idempotencyKey: "diagnostic-bounds-123456", workspace: root,
      packet: { objective: "Inspect" }, model: "local/model", profile: "bounded-inspect",
      baselineHash: "a", promptHash: "b" });
    task = store.transition(task.scopeId, task.taskId, task.revision, "running", "current",
      { blocker: "permission required", verbose: "z".repeat(10_000) });
    store.appendDiagnostic(task.executionId, Buffer.alloc(100_000, 0x78));

    const parameters = { scope_id: task.scopeId, task_id: task.taskId };
    const ordinary = await service.handle("get_task", parameters) as Record<string, unknown>;
    assert.equal(Object.hasOwn(ordinary, "diagnostic"), false);
    assert.ok((ordinary.events as Array<{ detail: { blocker?: string } }>).some((event) =>
      event.detail.blocker === "permission required"));

    let cursor: string | null = "start";
    let captured = 0;
    let pages = 0;
    while (cursor) {
      const response = await service.handle("get_task", { ...parameters, diagnostic_cursor: cursor }) as
        { events: Array<{ detail: { blocker?: string } }>; diagnostic: {
          originalBytes: number; capturedBytes: number; truncated: boolean; contentBase64: string;
          nextDiagnosticCursor: string | null } };
      assert.ok(response.events.some((event) => event.detail.blocker === "permission required"));
      assert.equal(response.diagnostic.originalBytes, 100_000);
      assert.equal(response.diagnostic.capturedBytes, 65_536);
      assert.equal(response.diagnostic.truncated, true);
      const chunk = Buffer.from(response.diagnostic.contentBase64, "base64");
      assert.ok(chunk.byteLength > 0 && chunk.byteLength <= 2_048);
      captured += chunk.byteLength;
      cursor = response.diagnostic.nextDiagnosticCursor;
      pages++;
    }
    assert.equal(captured, 65_536);
    assert.equal(pages, 32);

    const observer = new DatabaseSync(join(root, "state.sqlite"));
    const beforeBurst = observer.prepare("SELECT original_bytes FROM diagnostic_logs WHERE execution_id=?")
      .get(task.executionId) as { original_bytes: number };
    for (let index = 0; index < 1_000; index++) store.appendDiagnostic(task.executionId, Buffer.from("more stderr"));
    const beforeFlush = observer.prepare("SELECT original_bytes FROM diagnostic_logs WHERE execution_id=?")
      .get(task.executionId) as { original_bytes: number };
    assert.equal(beforeFlush.original_bytes, beforeBurst.original_bytes,
      "saturated capture must not synchronously write the database for every stderr chunk");
    const flushed = store.diagnosticChunk(task.executionId, "start")!;
    assert.equal(flushed.originalBytes, 100_000 + 1_000 * Buffer.byteLength("more stderr"));
    observer.close();

    const first = store.diagnosticChunk(task.executionId, "start")!;
    store.appendDiagnostic(task.executionId, Buffer.from("late stderr"));
    const resumed = store.diagnosticChunk(task.executionId, first.nextDiagnosticCursor!)!;
    assert.equal(resumed.byteOffset, 2_048);
    assert.equal(resumed.sha256, first.sha256);
    assert.equal(resumed.originalBytes, first.originalBytes + Buffer.byteLength("late stderr"));
    assert.equal(resumed.truncated, true);
    assert.equal(store.purgeExpiredDiagnostics(new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000)), 1);
    assert.equal(store.diagnosticChunk(task.executionId, "start"), null);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("diagnostic cursor rejects changed captured bytes before the cap", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-diagnostic-drift-"));
  try {
    const store = new SqliteTaskStore(join(root, "state.sqlite"));
    const task = store.start({ scopeId: "scope", idempotencyKey: "diagnostic-drift-123456", workspace: root,
      packet: { objective: "Inspect" }, model: "local/model", profile: "bounded-inspect",
      baselineHash: "a", promptHash: "b" });
    store.appendDiagnostic(task.executionId, Buffer.alloc(4_096, 0x61));
    const first = store.diagnosticChunk(task.executionId, "start")!;
    store.appendDiagnostic(task.executionId, Buffer.from("new captured bytes"));
    assert.throws(() => store.diagnosticChunk(task.executionId, first.nextDiagnosticCursor!),
      (error) => error instanceof StoreConflict && error.code === "INVALID_STATE");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("idle diagnostic retention runs without a read or new stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-diagnostic-retention-"));
  try {
    const filename = join(root, "state.sqlite");
    const store = new SqliteTaskStore(filename, { diagnosticMaintenanceIntervalMs: 10 });
    const task = store.start({ scopeId: "scope", idempotencyKey: "diagnostic-retention-1234", workspace: root,
      packet: { objective: "Inspect" }, model: "local/model", profile: "bounded-inspect",
      baselineHash: "a", promptHash: "b" });
    store.appendDiagnostic(task.executionId, Buffer.from("old stderr"));
    const observer = new DatabaseSync(filename);
    observer.prepare("UPDATE diagnostic_logs SET updated_at=? WHERE execution_id=?")
      .run("2000-01-01T00:00:00.000Z", task.executionId);
    let retained = true;
    for (let attempt = 0; attempt < 50; attempt++) {
      retained = Boolean(observer.prepare("SELECT 1 FROM diagnostic_logs WHERE execution_id=?")
        .get(task.executionId));
      if (!retained) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(retained, false, "idle maintenance should purge expired private logs");
    observer.close();
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
