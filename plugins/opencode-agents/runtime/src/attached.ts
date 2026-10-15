import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { UserConfig } from "./config.js";
import { stateDirectory } from "./config.js";
import { assertWorkerPolicy, workerPolicy } from "./managed-server.js";
import { compatibilityPath } from "./resources.js";

export type AttachedDiagnostic = {
  status: "unreachable" | "workspace_mismatch" | "storage_mismatch" | "policy_mismatch" | "unsupported";
  endpoint: string;
  workspace: string;
  storageNamespace: string;
  version: string | null;
  openapiSha256: string | null;
  configurationSha256: string | null;
  executionSupported: false;
  message: string;
};

async function boundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error("empty HTTP response");
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error("diagnostic response exceeds size limit"); }
    parts.push(Buffer.from(next.value));
  }
  return Buffer.concat(parts);
}

/** Read-only attached endpoint probe. It never creates sessions or owns the process. */
export async function inspectAttached(config: NonNullable<UserConfig["attached_backend"]>): Promise<AttachedDiagnostic> {
  const base: AttachedDiagnostic = { status: "unreachable", endpoint: config.url,
    workspace: config.workspace, storageNamespace: config.storage_namespace,
    version: null, openapiSha256: null, configurationSha256: null,
    executionSupported: false, message: "attached endpoint has not been inspected" };
  const password = config.password_env ? process.env[config.password_env] : undefined;
  if (config.password_env && !password) return { ...base, message: `credential environment variable ${config.password_env} is not set` };
  const headers: Record<string, string> = password
    ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {};
  const get = async (path: string, maxBytes = 1024 * 1024): Promise<Buffer> => boundedBytes(await fetch(new URL(path, config.url),
    { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(2_000) }), maxBytes);
  try {
    const health = JSON.parse((await get("/global/health")).toString("utf8")) as { healthy?: unknown; version?: unknown };
    if (health.healthy !== true || typeof health.version !== "string")
      return { ...base, status: "unsupported", message: "attached health response lacks a healthy server identity" };
    base.version = health.version;
    const query = encodeURIComponent(config.workspace);
    const path = JSON.parse((await get(`/path?directory=${query}`)).toString("utf8")) as
      { directory?: unknown; state?: unknown; worktree?: unknown };
    if (path.directory !== config.workspace) return { ...base, status: "workspace_mismatch",
      message: `attached workspace routing returned ${String(path.directory)}` };
    if (path.state !== config.storage_namespace) return { ...base, status: "storage_mismatch",
      message: `attached state namespace returned ${String(path.state)}` };
    const configuration = JSON.parse((await get(`/config?directory=${query}`)).toString("utf8")) as unknown;
    base.configurationSha256 = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
    let policyMessage: string | null = null;
    try {
      if (typeof path.worktree !== "string" || !path.worktree.startsWith("/")) throw new Error("attached worktree identity is missing");
      assertWorkerPolicy(configuration, workerPolicy(`${stateDirectory()}/reports`, path.worktree).profiles);
    } catch (error) { policyMessage = String(error); }
    const openapi = await get("/doc", 5 * 1024 * 1024);
    base.openapiSha256 = createHash("sha256").update(openapi).digest("hex");
    if (policyMessage) return { ...base, status: "policy_mismatch", message: policyMessage };
    const manifest = JSON.parse(readFileSync(compatibilityPath(), "utf8")) as {
      pairs: Array<{ binary_version: string; sdk_version: string; openapi_sha256: string }> };
    const knownPair = manifest.pairs.some((pair) => pair.binary_version === base.version &&
      pair.sdk_version === "1.19.0" && pair.openapi_sha256 === base.openapiSha256);
    return { ...base, status: "unsupported", message: knownPair
      ? "attached process identity and effective config match, but plugin suppression and session ownership are not certified for dispatch"
      : "attached OpenCode version/OpenAPI pair is not in the certified manifest" };
  } catch (error) {
    return { ...base, status: "unreachable", message: `attached read-only probe failed: ${String(error)}`.slice(0, 500) };
  }
}
