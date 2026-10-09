import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { SdkOpenCodeBackend } from "./opencode-backend.js";

export type ManagedServer = {
  backendId: string;
  baseUrl: string;
  backend: SdkOpenCodeBackend;
  close(): Promise<void>;
};

export type ManagedServerOptions = {
  binary: string;
  workspace: string;
  startupTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

const LISTENING = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/;
type OwnedChild = ChildProcessByStdio<null, Readable, Readable>;

export async function startManagedServer(options: ManagedServerOptions): Promise<ManagedServer> {
  const password = randomBytes(32).toString("hex");
  const child = spawn(options.binary, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: options.workspace,
    env: { ...process.env, ...options.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let baseUrl: string;
  try { baseUrl = await waitForServerUrl(child, options.startupTimeoutMs ?? 15_000); }
  catch (error) { await stopOwnedChild(child); throw error; }
  const backendId = `backend_${randomUUID()}`;
  const token = Buffer.from(`opencode:${password}`).toString("base64");
  const backend = new SdkOpenCodeBackend(baseUrl, options.workspace, backendId, { Authorization: `Basic ${token}` });
  try {
    const inspected = await backend.inspectBackend({ timeoutMs: 5_000 });
    if (!inspected.supportedForExecution) throw new Error(`OpenCode ${inspected.version} is not certified for execution`);
  } catch (error) {
    await stopOwnedChild(child);
    throw error;
  }
  return { backendId, baseUrl, backend, close: () => stopOwnedChild(child) };
}

function waitForServerUrl(child: OwnedChild, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(url!);
    };
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4096);
      const match = LISTENING.exec(output);
      if (match?.[1]) finish(undefined, match[1]);
    };
    const onExit = (code: number | null) => finish(new Error(`OpenCode server exited during startup (${code ?? "signal"})`));
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error("OpenCode server startup timed out")), timeoutMs);
    child.stdout.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

async function stopOwnedChild(child: OwnedChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
