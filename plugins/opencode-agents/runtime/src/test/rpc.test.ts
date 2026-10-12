import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { rpcRequest, startRpcServer } from "../rpc.js";

test("timed-out RPC caller does not cancel its handler or crash the owner on late response", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-rpc-disconnect-"));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let runs = 0;
  const server = await startRpcServer(dir, async (method) => {
    if (method !== "slow") return { healthy: true, runs };
    runs++; entered.resolve(); await release.promise;
    completed.resolve(); return { data: "x".repeat(1024 * 1024) };
  });
  try {
    const timedOut = assert.rejects(rpcRequest(dir, "slow", {}, 100), /timed out/);
    await entered.promise; await timedOut;
    release.resolve(); await completed.promise;
    await nextTurn(); await nextTurn();
    assert.deepEqual(await rpcRequest(dir, "health", {}), { healthy: true, runs: 1 });
  } finally { release.resolve(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("client reconnects to the same supervisor and concurrent bind is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-rpc-"));
  try {
    const server = await startRpcServer(dir, async (method, params) => ({ method, params }));
    assert.deepEqual(await rpcRequest(dir, "ping", { n: 1 }), { method: "ping", params: { n: 1 } });
    assert.deepEqual(await rpcRequest(dir, "ping", { n: 2 }), { method: "ping", params: { n: 2 } });
    await assert.rejects(startRpcServer(dir, async () => null), /socket already exists/);
    await server.close();
    await assert.rejects(rpcRequest(dir, "ping", {}), /not running/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("simultaneous RPC bind loser leaves the winning socket reachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-rpc-race-"));
  let winner: Awaited<ReturnType<typeof startRpcServer>> | undefined;
  try {
    const results = await Promise.allSettled([
      startRpcServer(dir, async () => ({ owner: "first" })),
      startRpcServer(dir, async () => ({ owner: "second" })),
    ]);
    const successes = results.filter((r) => r.status === "fulfilled");
    assert.equal(successes.length, 1);
    winner = successes[0]!.value;
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const response = await rpcRequest(dir, "ping", {}) as { owner: string };
    assert.ok(["first", "second"].includes(response.owner));
  } finally { await winner?.close(); rmSync(dir, { recursive: true, force: true }); }
});
