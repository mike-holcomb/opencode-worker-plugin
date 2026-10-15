import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckpointInputSchema, ProgressManager, ProgressReadSchema } from "../progress.js";
const checkpoint = { stage: "investigating" as const, summary: "Inputs traced", completed: ["Traced input"], remaining: ["Verify outputs"], blocker: null, evidence_refs: [] };

// Glimmer proposed these positive scenarios; independent boundary cases below
// enforce the public contract rather than its initial simplified implementation.
test("checkpoint schema and progress request bounds reject invalid or oversized submissions", () => {
  assert.deepEqual(CheckpointInputSchema.parse(checkpoint), checkpoint);
  for (const changed of [{ summary: "x".repeat(601) }, { stage: "done" }, { completed: Array(6).fill("step") }, { evidence_refs: ["x".repeat(129)] }, { execution_id: "other" }])
    assert.equal(CheckpointInputSchema.safeParse({ ...checkpoint, ...changed }).success, false);
  assert.equal(CheckpointInputSchema.safeParse({ ...checkpoint, summary: "界".repeat(600), completed: Array(5).fill("界".repeat(200)) }).success, false);
  const input = { scope_id: "scope", task_id: "task", execution_id: "exec" };
  assert.equal(ProgressReadSchema.parse(input).max_updates, 5);
  for (const changed of [{ max_bytes: 8191 }, { max_bytes: 32769 }, { max_updates: 21 }, { execution_id: "" }])
    assert.equal(ProgressReadSchema.safeParse({ ...input, ...changed }).success, false);
});

test("exclusive pagination, retry, empty delta and explicit snapshot", () => {
  const manager = new ProgressManager(); manager.register("exec", "supported");
  const initial = manager.hint("exec").progress_cursor;
  assert.deepEqual(manager.append("exec", "part1", checkpoint), { accepted: true, duplicate: false });
  assert.deepEqual(manager.append("exec", "part1", checkpoint), { accepted: true, duplicate: true });
  manager.append("exec", "part2", { ...checkpoint, summary: "Second milestone" });
  const page = manager.read("exec", { after_cursor: initial, max_updates: 1 });
  assert.equal(page.updates.length, 1); assert.equal(page.has_more, true);
  assert.deepEqual(manager.read("exec", { after_cursor: initial, max_updates: 1 }), page);
  const second = manager.read("exec", { after_cursor: page.next_cursor });
  assert.equal(second.updates[0]!.summary, "Second milestone");
  const empty = manager.read("exec", { after_cursor: second.next_cursor });
  assert.deepEqual(empty.updates, []); assert.equal(empty.next_cursor, second.next_cursor); assert.equal(empty.snapshot, null);
  assert.equal(manager.read("exec", { after_cursor: second.next_cursor, include_snapshot: true }).snapshot?.summary, "Second milestone");
  assert.equal(empty.runtime.last_worker_checkpoint_at, second.updates[0]!.recorded_at);
});

test("conflicting retries and malformed, future, event and cross-execution cursors are rejected", () => {
  const manager = new ProgressManager(); manager.register("exec", "supported");
  manager.append("exec", "part", checkpoint);
  assert.throws(() => manager.append("exec", "part", { ...checkpoint, summary: "Conflict" }), /conflicting/);
  const cursor = manager.hint("exec").progress_cursor;
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()); decoded.s += 1;
  assert.throws(() => manager.read("exec", { after_cursor: Buffer.from(JSON.stringify(decoded)).toString("base64url") }), /ahead/);
  for (const bad of ["abc!", "123", "", Buffer.from('{}').toString('base64url')]) assert.throws(() => manager.read("exec", { after_cursor: bad }));
  assert.throws(() => manager.read("continuation", { after_cursor: cursor }), /another execution/);
});

test("retention keeps absolute stream sequence, reports gaps and skips backlog on recovery", () => {
  let now = 1; const manager = new ProgressManager({ maxCount: 2, now: () => now++ }); manager.register("exec", "supported");
  const initial = manager.hint("exec").progress_cursor;
  for (let i = 0; i < 4; i++) manager.append("exec", "part" + i, { ...checkpoint, summary: "Milestone " + i });
  assert.equal(manager.read("exec").updates.length, 2);
  const gap = manager.read("exec", { after_cursor: initial });
  assert.equal(gap.gap?.reason, "retention"); assert.deepEqual(gap.updates, []); assert.equal(gap.snapshot?.summary, "Milestone 3");
  assert.deepEqual(manager.read("exec", { after_cursor: gap.next_cursor }).updates, []);
  manager.append("exec", "future", checkpoint);
  assert.equal(manager.read("exec", { after_cursor: gap.next_cursor }).updates.length, 1);
});

test("restart and disconnect have honest generation gaps, stable empty reads and reconnect dedup", () => {
  const manager = new ProgressManager(); manager.register("exec", "supported"); manager.append("exec", "part", checkpoint);
  const cursor = manager.hint("exec").progress_cursor;
  manager.reset("exec", "disconnect");
  const reset = manager.read("exec", { after_cursor: cursor });
  assert.equal(reset.gap?.reason, "disconnect"); assert.equal(reset.snapshot?.summary, checkpoint.summary);
  assert.equal(manager.append("exec", "part", checkpoint).duplicate, true);
  assert.deepEqual(manager.read("exec", { after_cursor: reset.next_cursor }).updates, []);
  const restarted = new ProgressManager();
  const gap = restarted.read("exec", { after_cursor: cursor });
  assert.equal(gap.gap?.reason, "restart"); assert.equal(gap.snapshot, null);
  assert.deepEqual(restarted.read("exec", { after_cursor: gap.next_cursor }).updates, []);
  assert.equal(restarted.hint("exec").progress_cursor, restarted.hint("exec").progress_cursor);
});

test("publication loss exposes repeatable gaps, preserves snapshots and dedup, and resumes at the head", () => {
  const manager = new ProgressManager(); manager.register("exec", "supported");
  const initial = manager.hint("exec").progress_cursor;
  manager.recordLoss("exec");
  const first = manager.read("exec", { after_cursor: initial });
  assert.equal(first.gap?.reason, "attribution_failure"); assert.equal(first.dropped_count, 1);
  assert.equal(first.gap.snapshot_available, false); assert.equal(first.snapshot, null);
  manager.append("exec", "before", checkpoint);
  const expired = manager.hint("exec").progress_cursor;
  manager.recordLoss("exec");
  const gap = manager.read("exec", { after_cursor: expired });
  assert.equal(gap.gap?.reason, "attribution_failure"); assert.equal(gap.dropped_count, 2);
  assert.deepEqual(gap.updates, []); assert.equal(gap.snapshot?.summary, checkpoint.summary);
  assert.equal(gap.snapshot?.cursor, expired);
  assert.deepEqual(manager.read("exec", { after_cursor: expired }), gap);
  manager.maintain();
  const empty = manager.read("exec", { after_cursor: gap.next_cursor });
  assert.equal(empty.gap, null); assert.equal(empty.next_cursor, gap.next_cursor);
  assert.equal(manager.append("exec", "before", checkpoint).duplicate, true);
  assert.throws(() => manager.append("exec", "before", { ...checkpoint, summary: "Conflicting retry" }), /conflicting/);
  manager.append("exec", "after", { ...checkpoint, summary: "After failure" });
  assert.deepEqual(manager.read("exec", { after_cursor: gap.next_cursor }).updates.map((item) => item.summary), ["After failure"]);
  const unknown = manager.read("unknown"); manager.recordLoss("unknown");
  assert.deepEqual(manager.read("unknown"), unknown, "loss recording never registers an unknown buffer");
});

test("item and whole-response UTF-8 budgets preserve complete records", () => {
  const manager = new ProgressManager(); manager.register("exec", "supported");
  const large = { ...checkpoint, summary: "界".repeat(500), completed: ["界".repeat(200), "界".repeat(200)], remaining: ["界".repeat(200)] };
  for (let i = 0; i < 10; i++) manager.append("exec", "part" + i, large);
  let cursor: string | undefined; let count = 0;
  do {
    const page = manager.read("exec", { ...(cursor ? { after_cursor: cursor } : {}), max_updates: 20, max_bytes: 8192 }, { observation: "current", observed_at: null }, { execution_id: "exec" });
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 8192);
    for (const update of page.updates) assert.equal(update.summary, large.summary);
    count += page.updates.length; cursor = page.next_cursor;
    if (!page.has_more) break;
  } while (count < 20);
  assert.equal(count, 10);
});

test("rate limits reserve blocker transitions and disclose drops without rewriting history", () => {
  let now = 1000; const manager = new ProgressManager({ now: () => now }); manager.register("exec", "supported");
  for (let i = 0; i < 48; i++) assert.equal(manager.append("exec", "routine" + i, checkpoint).accepted, true);
  assert.equal(manager.append("exec", "overflow", checkpoint).accepted, false);
  for (let i = 0; i < 12; i++) assert.equal(manager.append("exec", "blocker" + i, { ...checkpoint, stage: "blocked", blocker: { summary: "Blocker " + i } }).accepted, true);
  assert.equal(manager.append("exec", "cap", { ...checkpoint, blocker: { summary: "Extra" } }).accepted, false);
  assert.equal(manager.read("exec").dropped_count, 2);
  now += 60000; assert.equal(manager.append("exec", "future", checkpoint).accepted, true);
});

test("aggregate and terminal eviction are finite, explicit and never caused by reads", () => {
  let now = 0; const manager = new ProgressManager({ now: () => now, maxAggregateBytes: 6000, terminalTtlMs: 100 });
  manager.register("first", "supported"); manager.append("first", "part", checkpoint); const cursor = manager.hint("first").progress_cursor;
  for (let i = 0; i < 10; i++) { now++; manager.register("exec" + i, "supported"); }
  assert.equal(manager.read("first", { after_cursor: cursor }).gap?.reason, "aggregate");
  manager.register("terminal", "supported"); manager.append("terminal", "part", checkpoint); const terminal = manager.hint("terminal").progress_cursor;
  manager.markTerminal("terminal"); now += 101;
  assert.equal(manager.read("terminal", { after_cursor: terminal, include_snapshot: true }).snapshot?.summary, checkpoint.summary, "read does not sweep");
  manager.maintain(); assert.equal(manager.read("terminal", { after_cursor: terminal }).gap?.reason, "terminal");
});

for (const reason of ["aggregate", "terminal"] as const) {
  test(`${reason} recovery cursors stabilize and follow a re-registered stream`, () => {
    let now = 0;
    const manager = new ProgressManager({ now: () => now, maxAggregateBytes: 2000, terminalTtlMs: 100 });
    manager.register("exec", "supported");
    const initial = manager.hint("exec").progress_cursor;
    manager.append("exec", "before", checkpoint);
    const expired = manager.hint("exec").progress_cursor;
    if (reason === "terminal") {
      manager.markTerminal("exec"); now += 100; manager.maintain();
    } else {
      now++; manager.register("pressure", "supported"); manager.append("pressure", "pressure", checkpoint);
    }
    const gap = manager.read("exec", { after_cursor: expired });
    assert.equal(gap.gap?.reason, reason);
    assert.notEqual(gap.next_cursor, initial, "even the pre-eviction sequence-zero cursor is expired");
    assert.deepEqual(manager.read("exec", { after_cursor: expired }), gap, "reading does not acknowledge the gap");
    assert.equal(manager.read("exec", { after_cursor: initial }).gap?.reason, reason);
    assert.equal(manager.hint("exec").progress_cursor, gap.next_cursor);
    const recovered = manager.read("exec", { after_cursor: gap.next_cursor });
    assert.equal(recovered.gap, null); assert.deepEqual(recovered.updates, []);
    assert.equal(recovered.next_cursor, gap.next_cursor);
    manager.maintain();
    assert.deepEqual(manager.read("exec", { after_cursor: gap.next_cursor }), recovered);
    now++; manager.register("exec", "supported");
    assert.equal(manager.hint("exec").progress_cursor, gap.next_cursor);
    assert.equal(manager.read("exec", { after_cursor: expired }).gap?.reason, reason);
    manager.append("exec", "after", { ...checkpoint, summary: "New milestone" });
    const resumed = manager.read("exec", { after_cursor: gap.next_cursor });
    assert.equal(resumed.gap, null); assert.deepEqual(resumed.updates.map((item) => item.summary), ["New milestone"]);
  });
}

test("pruned eviction tombstones disclose unavailable history and issue a usable fallback cursor", () => {
  const manager = new ProgressManager({ maxAggregateBytes: 1024 });
  manager.register("exec", "supported");
  const initial = manager.hint("exec").progress_cursor;
  manager.register("pressure", "supported");
  const recovery = manager.read("exec", { after_cursor: initial }).next_cursor;
  assert.notEqual(recovery, initial);
  for (let i = 0; i < 10; i++) manager.register(`pressure${i}`, "supported");
  const gap = manager.read("exec", { after_cursor: recovery });
  assert.equal(gap.gap?.reason, "buffer_unavailable");
  assert.equal(manager.read("exec", { after_cursor: gap.next_cursor }).gap, null);
});

test("initial cursors stay expired after default terminal eviction tombstones are pruned", () => {
  let now = 0;
  const manager = new ProgressManager({ now: () => now });
  manager.register("exec", "supported");
  const initial = manager.hint("exec").progress_cursor;
  manager.append("exec", "before", checkpoint);
  manager.markTerminal("exec");
  now += 30 * 60_000; manager.maintain();
  assert.equal(manager.read("exec", { after_cursor: initial }).gap?.reason, "terminal");
  for (let i = 0; i < 257; i++) {
    const id = `terminal${i}`;
    manager.register(id, "supported"); manager.markTerminal(id);
  }
  now += 30 * 60_000; manager.maintain();
  const gap = manager.read("exec", { after_cursor: initial });
  assert.equal(gap.gap?.reason, "buffer_unavailable");
  assert.equal(gap.snapshot, null); assert.deepEqual(gap.updates, []);
  assert.deepEqual(manager.read("exec", { after_cursor: initial }), gap);
  const recovered = manager.read("exec", { after_cursor: gap.next_cursor });
  assert.equal(recovered.gap, null); assert.equal(recovered.next_cursor, gap.next_cursor);
  manager.register("exec", "supported");
  assert.equal(manager.read("exec", { after_cursor: initial }).gap?.reason, "buffer_evicted");
  assert.equal(manager.read("exec", { after_cursor: gap.next_cursor }).gap, null);
  manager.append("exec", "after", { ...checkpoint, summary: "After expiry" });
  assert.deepEqual(manager.read("exec", { after_cursor: gap.next_cursor }).updates.map((item) => item.summary), ["After expiry"]);
});

test("empty unknown streams have stable cursors that follow initial registration", () => {
  const manager = new ProgressManager();
  const initial = manager.hint("exec").progress_cursor;
  const empty = manager.read("exec", { after_cursor: initial });
  assert.equal(empty.gap, null); assert.equal(empty.next_cursor, initial);
  manager.maintain();
  assert.deepEqual(manager.read("exec", { after_cursor: initial }), empty);
  manager.register("exec", "supported");
  const registered = manager.hint("exec").progress_cursor;
  assert.equal(manager.read("exec", { after_cursor: registered }).gap, null);
  assert.equal(manager.read("exec", { after_cursor: initial }).gap, null);
  manager.append("exec", "first", checkpoint);
  assert.equal(manager.read("exec", { after_cursor: initial }).updates.length, 1);
  manager.reset("exec", "disconnect");
  assert.equal(manager.read("exec", { after_cursor: initial }).gap?.reason, "disconnect");
});

test("published input and response mutations cannot change retained checkpoints", () => {
  const manager = new ProgressManager(); manager.register("exec", "supported");
  const mutable = { ...checkpoint, completed: ["Original"] }; manager.append("exec", "part", mutable); mutable.completed[0] = "Changed";
  const response = manager.read("exec"); response.updates[0]!.completed[0] = "Changed again";
  assert.equal(manager.read("exec").updates[0]!.completed[0], "Original");
});

test("per-execution byte and dedup metadata caps disclose drops and preserve admitted hashes", () => {
  let now = 1;
  const manager = new ProgressManager({ maxExecutionBytes: 6000, now: () => now }); manager.register("exec", "supported");
  let admitted = 0;
  for (let i = 0; i < 100; i++) { now += 60000; if (manager.append("exec", "source" + i, checkpoint).accepted) admitted++; }
  assert.ok(admitted > 0 && admitted < 100);
  assert.equal(manager.read("exec").dropped_count, 100 - admitted);
  const page = manager.read("exec", { max_updates: 20, max_bytes: 32768 });
  assert.ok(Buffer.byteLength(JSON.stringify(page.updates)) <= 6000);
  assert.equal(manager.append("exec", "source0", checkpoint).duplicate, true);
  assert.throws(() => manager.append("exec", "source0", { ...checkpoint, summary: "Changed claim" }), /conflicting/);
});
