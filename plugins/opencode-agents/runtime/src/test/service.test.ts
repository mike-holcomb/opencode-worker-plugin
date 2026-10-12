import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../artifacts.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore } from "../store.js";

test("dry-run checks configured model and baseline without admitting a task", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-plan-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "input.txt"), "original\n");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ schema_version: 1, project_roots: [root], read_roots: [],
    opencode_binary: "/usr/bin/false", models: { laguna: { provider_id: "llama.cpp", model_id: "laguna-s-21", destination: "local" } },
    limits: { concurrency: 2, queue_timeout_seconds: 600, execution_timeout_seconds: 1800, artifact_bytes: 1000000 } }));
  const previous = process.env.OPENCODE_AGENTS_CONFIG;
  process.env.OPENCODE_AGENTS_CONFIG = configPath;
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  try {
    const service = new SupervisorService(store, new ArtifactStore(join(root, "artifacts")));
    const packet = { title: "Inspect", objective: "Read input", tier: "lightweight", authoritative_inputs: [
      { reference: "input.txt", kind: "file", purpose: "Source" } ], context: { verified_facts: [], rejected_assumptions: [], exclusions: [] },
      allowed_writes: [], acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
    const input = { scope_id: "scope", workspace: { path: workspace, access: "exclusive" }, model: { profile: "laguna" },
      profile: "bounded-inspect", limits: { queue_timeout_seconds: 60, execution_timeout_seconds: 120 }, packet, dry_run: true };
    const result = await service.handle("start_task", input) as { checks: Record<string, string>; starting_state_sha256: string };
    assert.equal(result.checks.workspace, "valid");
    assert.equal(result.checks.backend, "unchecked");
    assert.match(result.starting_state_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(store.list("scope"), []);
    writeFileSync(join(workspace, "input.txt"), "changed\n");
    const changed = await service.handle("start_task", input) as { starting_state_sha256: string };
    assert.notEqual(changed.starting_state_sha256, result.starting_state_sha256);
    await assert.rejects(service.handle("start_task", { ...input, dry_run: false, idempotency_key: "test-key-123456789" }),
      { code: "UNSUPPORTED_BACKEND" });
    assert.deepEqual(store.list("scope"), []);
  } finally {
    store.close();
    if (previous === undefined) delete process.env.OPENCODE_AGENTS_CONFIG;
    else process.env.OPENCODE_AGENTS_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalizing is ineligible for follow-up", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-service-"));
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  try {
    const service = new SupervisorService(store, new ArtifactStore(join(root, "artifacts")));
    const task = store.start({ scopeId: "scope", idempotencyKey: "finalizing-key-12345", workspace: root,
      packet: {}, model: "old/model", profile: "bounded-inspect", baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
    const cursor = store.events(task.executionId).at(-1)!.cursor;
    const wait = await service.handle("wait_tasks", { scope_id: "scope", targets: [{ task_id: task.taskId,
      after_cursor: cursor }], timeout_ms: 15 }) as { timed_out: boolean };
    assert.equal(wait.timed_out, true);
    assert.equal(store.get("scope", task.taskId)?.phase, "queued");
    store.transition("scope", task.taskId, task.revision, "finalizing", "current");
    const projected = await service.handle("get_task", { scope_id: "scope", task_id: task.taskId }) as
      { phase: string; terminal: boolean; operationally_resolved: boolean };
    assert.equal(projected.phase, "finalizing");
    assert.equal(projected.terminal, false);
    assert.equal(projected.operationally_resolved, false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
