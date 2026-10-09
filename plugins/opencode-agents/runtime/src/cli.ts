#!/usr/bin/env node
import { doctor } from "./doctor.js";
import { runMcp } from "./mcp.js";
import { daemonStatus, runDaemon, startDaemon, stopDaemon } from "./daemon.js";
import { inspectLegacyJob } from "./legacy.js";
import { rpcRequest } from "./rpc.js";
import { stateDirectory } from "./config.js";

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "doctor") {
    process.stdout.write(`${JSON.stringify(doctor(), null, 2)}\n`);
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
  if (args[0] === "legacy" && args[1] === "inspect" && args.length === 3) {
    process.stdout.write(`${JSON.stringify(inspectLegacyJob(args[2]!), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "tasks" && args[1] === "list" && args.length === 3) {
    process.stdout.write(`${JSON.stringify(await rpcRequest(stateDirectory(), "list_tasks", { scope_id: args[2] }), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "tasks" && args[1] === "get" && args.length === 4) {
    process.stdout.write(`${JSON.stringify(await rpcRequest(stateDirectory(), "get_task", { scope_id: args[2], task_id: args[3] }), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "tasks" && args[1] === "wait" && args.length === 5) {
    const timeout = Number(args[4]);
    process.stdout.write(`${JSON.stringify(await rpcRequest(stateDirectory(), "wait_tasks", {
      scope_id: args[2], targets: [{ task_id: args[3] }], timeout_ms: timeout,
    }), null, 2)}\n`);
    return 0;
  }
  process.stderr.write("Usage: opencode-agents doctor|mcp|daemon start|status|stop|tasks list|get|wait|legacy inspect\n");
  return 2;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
