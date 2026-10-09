import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rpcRequest, startRpcServer } from "../rpc.js";

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
