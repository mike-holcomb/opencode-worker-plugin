import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../artifacts.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore } from "../store.js";

test("oversized event details are explicitly truncated while cursors retain every blocker", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-events-"));
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  const service = new SupervisorService(store, new ArtifactStore(join(root, "artifacts")));
  try {
    let task = store.start({ scopeId: "scope", idempotencyKey: "events-key-123456789", workspace: root,
      packet: { objective: "Inspect" }, model: "local/model", profile: "bounded-inspect",
      baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
    const initialCursor = store.events(task.executionId).at(-1)!.cursor;
    const largeBlocker = `critical policy blocker ${"!".repeat(100_000)}`;
    task = store.transition(task.scopeId, task.taskId, task.revision, "queued", "current",
      { blocker: largeBlocker });
    for (let i = 0; i < 110; i++) task = store.transition(task.scopeId, task.taskId, task.revision,
      "queued", "current", { blocker: `blocker_${i}` });
    const waited = await service.handle("wait_tasks", { scope_id: "scope", targets: [{ task_id: task.taskId,
      after_cursor: initialCursor }], timeout_ms: 0 }) as { changed: Array<{ events: Array<{ detail: { blocker?: string } }> }> };
    assert.ok(waited.changed[0]?.events[0]?.detail.blocker?.startsWith("critical policy blocker"));

    let cursor = initialCursor;
    const seen = new Set<number>();
    let lastBlocker = "";
    let truncated = false;
    let detailCursor: string | null = null;
    for (let pageNo = 0; pageNo < 20; pageNo++) {
      const page = await service.handle("get_task", { scope_id: "scope", task_id: task.taskId,
        after_cursor: cursor }) as { events: Array<{ cursor: number; detail: { blocker?: string };
          detailTruncated?: { originalBytes: number; sha256: string; cursor: string } }>;
        cursor: number; has_more_events: boolean; backendConfig?: unknown };
      assert.ok(Buffer.byteLength(JSON.stringify(page.events)) <= 4_096);
      assert.equal(page.backendConfig, undefined);
      if (pageNo === 0) {
        assert.ok(page.events[0]?.detail.blocker?.startsWith("critical policy blocker"));
        assert.ok(page.events[0]?.detailTruncated?.originalBytes! > 100_000);
        detailCursor = page.events[0]?.detailTruncated?.cursor ?? null;
        truncated = true;
      }
      for (const event of page.events) {
        assert.equal(seen.has(event.cursor), false);
        seen.add(event.cursor);
        if (event.detail.blocker) lastBlocker = event.detail.blocker;
      }
      assert.ok(page.cursor > cursor);
      cursor = page.cursor;
      if (!page.has_more_events) break;
    }
    assert.equal(truncated, true);
    assert.equal(seen.size, 111);
    assert.equal(lastBlocker, "blocker_109");
    assert.ok(detailCursor);
    const unrelated = store.start({ scopeId: "scope", idempotencyKey: "other-events-key-123456",
      workspace: root, packet: {}, model: "local/model", profile: "bounded-inspect",
      baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
    await assert.rejects(service.handle("get_task", { scope_id: "scope", task_id: unrelated.taskId,
      event_detail_cursor: detailCursor }));
    const chunks: Buffer[] = [];
    for (let part = 0; detailCursor && part < 60; part++) {
      const response = await service.handle("get_task", { scope_id: "scope", task_id: task.taskId,
        event_detail_cursor: detailCursor }) as { event_detail: { contentBase64: string; nextDetailCursor: string | null } };
      chunks.push(Buffer.from(response.event_detail.contentBase64, "base64"));
      detailCursor = response.event_detail.nextDetailCursor;
    }
    assert.equal(detailCursor, null);
    assert.equal((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { blocker: string }).blocker, largeBlocker);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
