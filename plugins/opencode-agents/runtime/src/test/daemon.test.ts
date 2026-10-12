import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rpcRequest } from "../rpc.js";

test("supervisor serves requests after a client disconnect and drains on stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-daemon-"));
  const executable = new URL("../cli.js", import.meta.url);
  const child = spawn(process.execPath, [executable.pathname, "daemon", "run"], {
    env: { ...process.env, OPENCODE_AGENTS_STATE_DIR: dir }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    let health: unknown;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { health = await rpcRequest(dir, "health", {}, 1000); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.ok(health, `supervisor did not start: ${stderr}`);
    const second = await rpcRequest(dir, "health", {}, 1000) as { supervisor: { state: string } };
    assert.equal(second.supervisor.state, "running");
    const exited = once(child, "exit");
    assert.deepEqual(await rpcRequest(dir, "daemon_stop", {}, 1000), { stopped: true });
    await exited;
    assert.equal(existsSync(join(dir, "supervisor.sock")), false);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T23: concurrent full supervisor startup leaves one owner and convergent clients", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-start-race-"));
  const executable = new URL("../cli.js", import.meta.url);
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, [executable.pathname, "daemon", "run"], {
      env: { ...process.env, OPENCODE_AGENTS_STATE_DIR: dir }, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    return { child, stderr: () => stderr };
  });
  try {
    let health: unknown;
    for (let attempt = 0; attempt < 75; attempt++) {
      try {
        health = await rpcRequest(dir, "health", {}, 500);
        if (children.filter(({ child }) => child.exitCode === null).length === 1) break;
      } catch { /* The connection file may not exist until one bind wins. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const detail = children.map(({ child, stderr }) => `pid=${child.pid} exit=${child.exitCode} stderr=${stderr()}`).join(" | ");
    assert.ok(health, `no reachable owner: ${detail}`);
    assert.equal(children.filter(({ child }) => child.exitCode === null).length, 1, detail);
    const clients = await Promise.all(Array.from({ length: 8 }, () => rpcRequest(dir, "health", {}, 1000)));
    assert.ok(clients.every((value) => (value as { supervisor?: { state?: string } }).supervisor?.state === "running"), detail);
    const winner = children.find(({ child }) => child.exitCode === null)!.child;
    const exited = once(winner, "exit");
    assert.deepEqual(await rpcRequest(dir, "daemon_stop", {}, 1000), { stopped: true });
    await exited;
    assert.equal(existsSync(join(dir, "supervisor.sock")), false);
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
