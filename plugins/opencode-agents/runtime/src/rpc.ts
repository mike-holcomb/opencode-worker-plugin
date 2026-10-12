import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Request = { id: string; token: string; method: string; params: unknown };
type Response = { id: string; result?: unknown; error?: { code: string; message: string; retry?: string; details?: unknown } };
type Connection = { generation: string; socket: string; token: string };
export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function paths(stateDir: string) { return { socket: join(stateDir, "supervisor.sock"), connection: join(stateDir, "connection.json") }; }

function equalToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startRpcServer(stateDir: string, handler: RpcHandler): Promise<{ generation: string; close(): Promise<void> }> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const { socket, connection } = paths(stateDir);
  if (existsSync(socket)) throw new Error("socket already exists; reconcile the recorded supervisor before removal");
  const generation = randomUUID();
  const token = randomBytes(32).toString("hex");
  const server = createServer((client) => serveClient(client, token, handler));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => { server.off("error", reject); resolve(); });
    });
    chmodSync(socket, 0o600);
    const staged = `${connection}.${generation}.tmp`;
    writeFileSync(staged, JSON.stringify({ generation, socket, token } satisfies Connection), { mode: 0o600, flag: "wx" });
    renameSync(staged, connection);
    chmodSync(connection, 0o600);
  } catch (error) {
    server.close();
    if (existsSync(socket)) rmSync(socket);
    throw error;
  }
  return {
    generation,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = readConnection(stateDir);
      if (current?.generation === generation) {
        rmSync(connection, { force: true });
        rmSync(socket, { force: true });
      }
    },
  };
}

function serveClient(client: Socket, token: string, handler: RpcHandler): void {
  let input = "";
  client.setEncoding("utf8");
  client.on("data", (chunk: string) => {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) { client.destroy(); return; }
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const line = input.slice(0, newline);
    client.removeAllListeners("data");
    let request: Request;
    try { request = JSON.parse(line) as Request; }
    catch { client.end(`${JSON.stringify({ id: "", error: { code: "INVALID_INPUT", message: "invalid JSON" } })}\n`); return; }
    if (!request || typeof request.id !== "string" || typeof request.method !== "string" || typeof request.token !== "string") {
      client.end(`${JSON.stringify({ id: "", error: { code: "INVALID_INPUT", message: "invalid request" } })}\n`); return;
    }
    if (!equalToken(request.token, token)) {
      client.end(`${JSON.stringify({ id: request.id, error: { code: "UNAUTHORIZED", message: "invalid local token" } })}\n`); return;
    }
    handler(request.method, request.params).then((result) => {
      const response: Response = { id: request.id, result };
      client.end(`${JSON.stringify(response)}\n`);
    }).catch((error) => {
      const known = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; retry?: unknown; details?: unknown } : null;
      const response: Response = { id: request.id, error: {
        code: typeof known?.code === "string" ? known.code : "INTERNAL",
        message: typeof known?.message === "string" ? known.message : String(error),
        ...(typeof known?.retry === "string" ? { retry: known.retry } : {}),
        ...(known?.details !== undefined ? { details: known.details } : {}),
      } };
      client.end(`${JSON.stringify(response)}\n`);
    });
  });
}

function readConnection(stateDir: string): Connection | null {
  const { connection } = paths(stateDir);
  if (!existsSync(connection)) return null;
  const value = JSON.parse(readFileSync(connection, "utf8")) as Connection;
  if (!value || typeof value.generation !== "string" || typeof value.token !== "string" || value.socket !== paths(stateDir).socket) {
    throw new Error("invalid supervisor connection record");
  }
  return value;
}

export async function rpcRequest(stateDir: string, method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
  const connection = readConnection(stateDir);
  if (!connection) throw new Error("supervisor is not running");
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const client = createConnection(connection.socket);
    let response = "";
    const timer = setTimeout(() => client.destroy(new Error("supervisor request timed out")), timeoutMs);
    client.setEncoding("utf8");
    client.once("connect", () => client.write(`${JSON.stringify({ id, token: connection.token, method, params } satisfies Request)}\n`));
    client.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) client.destroy(new Error("supervisor response too large"));
    });
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
    client.once("end", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(response.trim()) as Response;
        if (parsed.id !== id) throw new Error("supervisor response ID mismatch");
        if (parsed.error) {
          const error = new Error(`${parsed.error.code}: ${parsed.error.message}`) as Error & { code: string; retry?: string; details?: unknown };
          error.code = parsed.error.code;
          if (parsed.error.retry) error.retry = parsed.error.retry;
          if (parsed.error.details !== undefined) error.details = parsed.error.details;
          throw error;
        }
        resolve(parsed.result);
      } catch (error) { reject(error); }
    });
  });
}
