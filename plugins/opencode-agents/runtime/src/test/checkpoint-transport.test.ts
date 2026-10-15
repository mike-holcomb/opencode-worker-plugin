import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedCheckpointFetch } from "../opencode-backend.js";

test("checkpoint attribution enforces declared and streamed response byte bounds", async () => {
  const original = globalThis.fetch;
  const endpoint = "http://127.0.0.1:1/session/session/message/assistant";
  try {
    globalThis.fetch = async () => new Response("large", { headers: { "content-length": String(256 * 1024 + 1) } });
    await assert.rejects(boundedCheckpointFetch(endpoint), /exceeds 256 KiB/);
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(128 * 1024)); },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(boundedCheckpointFetch(endpoint), /exceeds 256 KiB/);
    assert.equal(cancelled, true);
    globalThis.fetch = async () => new Response(JSON.stringify({ info: { parentID: "origin" }, parts: [] }), { headers: { "content-type": "application/json" } });
    assert.deepEqual(await (await boundedCheckpointFetch(endpoint)).json(), { info: { parentID: "origin" }, parts: [] });
  } finally { globalThis.fetch = original; }
});
