import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../artifacts.js";
import { UserConfigSchema } from "../config.js";
import { doctorWithAttached } from "../doctor.js";
import { workerPolicy } from "../managed-server.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore } from "../store.js";

test("T24: attached loopback diagnostics use only GET and dispatch remains closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-attached-"));
  const workspace = join(root, "project");
  const state = join(root, "state");
  mkdirSync(workspace);
  mkdirSync(state);
  const configPath = join(root, "config.json");
  const previousConfig = process.env.OPENCODE_AGENTS_CONFIG;
  const previousState = process.env.OPENCODE_AGENTS_STATE_DIR;
  const requests: Array<{ method: string | undefined; path: string }> = [];
  let mode: "matching" | "bad_policy" | "bad_workspace" | "bad_storage" = "matching";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method, path: url.pathname });
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/global/health") response.end(JSON.stringify({ healthy: true, version: "unverified-version" }));
    else if (url.pathname === "/path") response.end(JSON.stringify({
      directory: mode === "bad_workspace" ? "/wrong/workspace" : workspace,
      state: mode === "bad_storage" ? "/wrong/state" : state,
      worktree: workspace,
    }));
    else if (url.pathname === "/config") response.end(JSON.stringify(mode === "bad_policy"
      ? { plugin: ["unsafe-plugin"], mcp: {}, agent: {} }
      : { plugin: [], mcp: {}, agent: workerPolicy(join(state, "reports"), workspace).profiles }));
    else if (url.pathname === "/doc") response.end("{\"openapi\":\"3.1.0\"}");
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/`;
  const config = { schema_version: 1, project_roots: [root], read_roots: [], opencode_binary: "/usr/bin/false",
    attached_backend: { url: endpoint, workspace, storage_namespace: state },
    models: { local: { provider_id: "fake", model_id: "model", destination: "local" } },
    limits: { concurrency: 2, queue_timeout_seconds: 600, execution_timeout_seconds: 1800,
      finalization_timeout_seconds: 60, artifact_bytes: 50_000_000 } };
  writeFileSync(configPath, JSON.stringify(config));
  process.env.OPENCODE_AGENTS_CONFIG = configPath;
  process.env.OPENCODE_AGENTS_STATE_DIR = state;
  const store = new SqliteTaskStore(join(state, "tasks.sqlite"));
  const service = new SupervisorService(store, new ArtifactStore(join(state, "artifacts")));
  try {
    const health = await service.handle("health", {}) as { backend: { mode: string; executionTested: boolean;
      attached: { status: string; message: string; version: string } } };
    assert.equal(health.backend.mode, "attached");
    assert.equal(health.backend.attached.status, "unsupported");
    assert.equal(health.backend.attached.version, "unverified-version");
    assert.equal(health.backend.executionTested, false);
    const packet = { title: "Inspect", objective: "Read input", tier: "lightweight", authoritative_inputs: [],
      context: { verified_facts: [], rejected_assumptions: [], exclusions: [] }, allowed_writes: [],
      acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
    await assert.rejects(service.handle("start_task", { scope_id: "scope", idempotency_key: "attached-start-key-123456",
      workspace: { path: workspace, access: "exclusive" }, model: { profile: "local" }, profile: "bounded-inspect",
      limits: { queue_timeout_seconds: 60, execution_timeout_seconds: 120 }, packet }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED_BACKEND");
    assert.equal(store.unresolved().length, 0);
    mode = "bad_policy";
    assert.equal((await doctorWithAttached()).backend.attached?.status, "policy_mismatch");
    mode = "bad_workspace";
    assert.equal((await doctorWithAttached()).backend.attached?.status, "workspace_mismatch");
    mode = "bad_storage";
    assert.equal((await doctorWithAttached()).backend.attached?.status, "storage_mismatch");
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.ok(requests.every((request) => ["/global/health", "/path", "/config", "/doc"].includes(request.path)));
  } finally {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const unreachable = await doctorWithAttached();
    assert.equal(unreachable.backend.attached?.status, "unreachable");
    if (previousConfig === undefined) delete process.env.OPENCODE_AGENTS_CONFIG;
    else process.env.OPENCODE_AGENTS_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.OPENCODE_AGENTS_STATE_DIR;
    else process.env.OPENCODE_AGENTS_STATE_DIR = previousState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("attached endpoint configuration rejects non-loopback and credential-bearing URLs", () => {
  const base = { schema_version: 1, project_roots: ["/tmp"], read_roots: [], opencode_binary: "/bin/false",
    models: {}, attached_backend: { url: "http://127.0.0.1:4096/", workspace: "/tmp",
      storage_namespace: "/tmp/state" } };
  assert.doesNotThrow(() => UserConfigSchema.parse(base));
  for (const url of ["https://127.0.0.1:4096/", "http://example.com:4096/", "http://localhost:4096/",
    "http://127.0.0.1:4096/other", "http://user:pass@127.0.0.1:4096/"]) {
    assert.throws(() => UserConfigSchema.parse({ ...base, attached_backend: { ...base.attached_backend, url } }));
  }
});
