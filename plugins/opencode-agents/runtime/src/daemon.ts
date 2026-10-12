import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "./artifacts.js";
import { ExecutionCoordinator } from "./coordinator.js";
import { stateDirectory } from "./config.js";
import { rpcRequest, startRpcServer } from "./rpc.js";
import { SupervisorService } from "./service.js";
import { SqliteTaskStore } from "./store.js";

export async function runDaemon(): Promise<void> {
  const stateDir = stateDirectory();
  const store = new SqliteTaskStore(join(stateDir, "state.sqlite"));
  const artifacts = new ArtifactStore(join(stateDir, "artifacts"));
  const coordinator = new ExecutionCoordinator(store, artifacts);
  const service = new SupervisorService(store, artifacts, coordinator);
  try {
    artifacts.reconcile((artifactId) => store.artifactById(artifactId), store.allArtifacts());
    await coordinator.start();
  } catch (error) { await coordinator.close(); store.close(); throw error; }
  let lastRequest = Date.now();
  let closing = false;
  let server: Awaited<ReturnType<typeof startRpcServer>>;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(idleTimer);
    await server.close();
    await coordinator.close();
    store.close();
  };
  try {
    server = await startRpcServer(stateDir, async (method, params) => {
      lastRequest = Date.now();
      if (method === "daemon_stop") {
        const unresolved = store.unresolved();
        if (unresolved.length) return { stopped: false, unresolved: unresolved.length };
        setTimeout(() => { void close(); }, 20);
        return { stopped: true };
      }
      return service.handle(method, params);
    });
  } catch (error) { await coordinator.close(); store.close(); throw error; }
  const idleTimer = setInterval(() => {
    if (Date.now() - lastRequest >= 15 * 60_000 && store.unresolved().length === 0) void close();
  }, 60_000);
  process.once("SIGTERM", () => { if (store.unresolved().length === 0) void close(); });
  process.once("SIGINT", () => { if (store.unresolved().length === 0) void close(); });
}

export async function startDaemon(executable = fileURLToPath(new URL("./cli.js", import.meta.url))): Promise<{ running: boolean; started: boolean }> {
  const stateDir = stateDirectory();
  try { await rpcRequest(stateDir, "health", {}, 1000); return { running: true, started: false }; }
  catch (error) {
    if (!String(error).includes("not running")) throw error;
  }
  const child = spawn(process.execPath, [executable, "daemon", "run"], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { await rpcRequest(stateDir, "health", {}, 1000); return { running: true, started: true }; }
    catch (error) { if (!String(error).includes("not running") && !String(error).includes("ECONNREFUSED")) throw error; }
  }
  throw new Error("supervisor did not become ready");
}

export async function daemonStatus(): Promise<unknown> {
  return rpcRequest(stateDirectory(), "health", {});
}

export async function stopDaemon(): Promise<unknown> {
  return rpcRequest(stateDirectory(), "daemon_stop", {});
}
