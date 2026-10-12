#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { once } from "node:events";
import { doctorWithAttached } from "./doctor.js";
import { runMcp } from "./mcp.js";
import { daemonStatus, runDaemon, startDaemon, stopDaemon } from "./daemon.js";
import { rpcRequest } from "./rpc.js";
import { stateDirectory } from "./config.js";

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "doctor") {
    process.stdout.write(`${JSON.stringify(await doctorWithAttached(), null, 2)}\n`);
    return 0;
  }
  if (args.length === 1 && args[0] === "mcp") {
    await runMcp();
    return 0;
  }
  if (args[0] === "daemon" && args.length === 2) {
    if (args[1] === "run") { await runDaemon(); return 0; }
    const value = args[1] === "start" ? await startDaemon(process.argv[1]) : args[1] === "status" ? await daemonStatus()
      : args[1] === "stop" ? await stopDaemon() : null;
    if (value !== null) { process.stdout.write(`${JSON.stringify(value)}\n`); return 0; }
  }
  if (args[0] === "tasks" && args[1] === "list" && args.length === 3) {
    process.stdout.write(`${JSON.stringify(await rpcRequest(stateDirectory(), "list_tasks", { scope_id: args[2] }), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "tasks" && args[1] === "get" && args.length === 4) {
    process.stdout.write(`${JSON.stringify(await rpcRequest(stateDirectory(), "get_task", { scope_id: args[2], task_id: args[3] }), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "tasks" && args[1] === "diagnostics" && (args.length === 4 || args.length === 5)) {
    process.stdout.write(`${JSON.stringify(await rpcRequest(stateDirectory(), "get_task", { scope_id: args[2],
      task_id: args[3], diagnostic_cursor: args[4] ?? "start" }), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "tasks" && args[1] === "wait" && args.length === 5) {
    const timeout = Number(args[4]);
    process.stdout.write(`${JSON.stringify(await rpcRequest(stateDirectory(), "wait_tasks", {
      scope_id: args[2], targets: [{ task_id: args[3] }], timeout_ms: timeout,
    }, timeout + 1_500), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "tasks" && args[1] === "cancel" && args.length === 8) {
    const revision = Number(args[5]);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("expected_revision must be a positive integer");
    const result = await rpcRequest(stateDirectory(), "cancel_task", { scope_id: args[2], task_id: args[3],
      execution_id: args[4], expected_revision: revision, reason: args[6], idempotency_key: args[7] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (args[0] === "artifacts" && args[1] === "read" && (args.length === 6 || args.length === 8)) {
    const result = await rpcRequest(stateDirectory(), "read_artifact", { scope_id: args[2], task_id: args[3],
      execution_id: args[4], artifact_id: args[5], ...(args[6] ? { byte_offset: Number(args[6]) } : {}),
      ...(args[7] ? { max_bytes: Number(args[7]) } : {}) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (args[0] === "artifacts" && args[1] === "export" && args.length === 7) {
    const output = createWriteStream(args[6]!, { flags: "wx", mode: 0o600 });
    const hash = createHash("sha256");
    try {
      let offset = 0;
      let digest: string | null = null;
      while (true) {
        const result = await rpcRequest(stateDirectory(), "read_artifact", { scope_id: args[2], task_id: args[3],
          execution_id: args[4], artifact_id: args[5], byte_offset: offset, max_bytes: 65_536 }) as
          { sha256: string; content_base64: string; next_offset: number | null };
        if (digest && result.sha256 !== digest) throw new Error("artifact changed during export");
        digest = result.sha256;
        const bytes = Buffer.from(result.content_base64, "base64");
        hash.update(bytes);
        if (!output.write(bytes)) await once(output, "drain");
        if (result.next_offset === null) break;
        offset = result.next_offset;
      }
      output.end();
      await once(output, "finish");
      if (hash.digest("hex") !== digest) throw new Error("exported bytes do not match artifact hash");
      process.stdout.write(`${JSON.stringify({ path: args[6], sha256: digest })}\n`);
    } catch (error) { output.destroy(); rmSync(args[6]!, { force: true }); throw error; }
    return 0;
  }
  process.stderr.write("Usage: opencode-agents doctor|mcp|daemon start|status|stop|tasks list|get|diagnostics|wait|cancel|artifacts read|export\n");
  return 2;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
