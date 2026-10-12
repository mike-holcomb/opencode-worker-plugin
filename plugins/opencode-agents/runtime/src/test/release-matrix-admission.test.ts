import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../artifacts.js";
import type { OpenCodeBackend, PendingRequest, RequestControl, TurnObservation } from "../backend.js";
import { loadConfiguration } from "../config.js";
import { ExecutionCoordinator } from "../coordinator.js";
import type { TaskPacket } from "../contracts.js";
import { renderPrompt } from "../prompt.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore, StoreConflict, type StartRecord } from "../store.js";
import { captureBaseline } from "../workspace.js";

class MatrixBackend implements OpenCodeBackend {
  backendId = "";
  readonly sessions = new Map<string, string>();
  readonly turns = new Map<string, string>();
  readonly finished = new Set<string>();
  createCount = 0;
  submitCount = 0;
  ambiguousCreation = false;
  constructor(readonly workspace: string) {}
  async inspectBackend() { return { version: "fake", openapiDigest: "fake", backendId: this.backendId,
    workspace: this.workspace, configurationDigest: "fake", supportedForExecution: true,
    capabilities: { callerAssignedMessageId: true, permissionRequests: true, questionRequests: false,
      structuredOutput: false, sessionRecovery: true } }; }
  async createSession(marker: string) {
    this.createCount++;
    if (this.ambiguousCreation) throw new Error("session create acknowledgement lost");
    const id = `ses_${randomUUID()}`;
    this.sessions.set(marker, id);
    return { id, backendId: this.backendId, workspace: this.workspace };
  }
  async findCreatedSession(marker: string) {
    const id = this.sessions.get(marker);
    return id ? { id, backendId: this.backendId, workspace: this.workspace } : null;
  }
  async submitTurn(input: { sessionId: string; messageId: string }) {
    this.submitCount++;
    this.turns.set(input.sessionId, input.messageId);
  }
  async inspectTurn(sessionId: string, messageId: string): Promise<TurnObservation> {
    assert.equal(this.turns.get(sessionId), messageId);
    const finished = this.finished.has(sessionId);
    return { submitted: true, assistantMessageIds: finished ? ["assistant"] : [],
      activeTools: finished ? 0 : 1, status: finished ? "idle" : "busy",
      pendingRequests: [], finished, error: null };
  }
  async *subscribeEvents(_control?: RequestControl) { await new Promise(() => {}); }
  async replyToRequest(_request: PendingRequest, _reply: "allow_once" | "deny" | string[][]) {}
  async abortSession() { return true; }
  async readResult() { return { text: "", structured: null }; }
}

function environment() {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-matrix-admission-"));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ schema_version: 1, project_roots: [root], read_roots: [],
    opencode_binary: "/usr/bin/false", models: { local: { provider_id: "fake", model_id: "model", destination: "local" } },
    limits: { concurrency: 2, queue_timeout_seconds: 600, execution_timeout_seconds: 1800,
      finalization_timeout_seconds: 60, artifact_bytes: 50_000_000 } }));
  const previous = process.env.OPENCODE_AGENTS_CONFIG;
  process.env.OPENCODE_AGENTS_CONFIG = configPath;
  const statePath = join(root, "state.sqlite");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const backends = new Map<string, MatrixBackend>();
  const workspace = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "input.txt"), "source\n");
    return path;
  };
  const packet: TaskPacket = { title: "Inspect", objective: "Inspect input", tier: "lightweight",
    authoritative_inputs: [{ reference: "input.txt", kind: "file", purpose: "Source" }],
    context: { verified_facts: [], rejected_assumptions: [], exclusions: [] }, allowed_writes: [],
    acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
  const startInput = (path: string, key: string): StartRecord => {
    const baseline = captureBaseline({ workspace: path, projectRoots: [root], packet });
    const taskId = `task_${randomUUID()}`;
    const executionId = `exec_${randomUUID()}`;
    const reportPath = join(root, "reports", executionId);
    const prompt = renderPrompt({ taskId, executionId, profile: "bounded-inspect", packet,
      baseline, outputDirectory: reportPath });
    return { taskId, executionId, scopeId: "scope", idempotencyKey: key, workspace: path,
      packet, model: "fake/model", profile: "bounded-inspect", baselineHash: baseline.sha256,
      promptHash: prompt.sha256, frozenPrompt: prompt.text, frozenBaseline: baseline,
      reportPath, backendConfig: loadConfiguration(),
      launchContract: { configContent: "{}", effectiveConfigSha256: "fixture", reportPath } };
  };
  const coordinator = (store: SqliteTaskStore) => new ExecutionCoordinator(store, artifacts,
    async ({ backendId, workspace: path }) => {
      let backend = backends.get(path);
      if (!backend) { backend = new MatrixBackend(path); backends.set(path, backend); }
      backend.backendId = backendId;
      return { backendId, backend, close: async () => {} };
    });
  return { root, statePath, artifacts, backends, workspace, startInput, coordinator,
    close() { if (previous === undefined) delete process.env.OPENCODE_AGENTS_CONFIG;
      else process.env.OPENCODE_AGENTS_CONFIG = previous;
      rmSync(root, { recursive: true, force: true }); } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("expected state was not reached");
}

test("T01/T02/T03: lost start response recovers one execution and changed payload cannot dispatch", async () => {
  const fx = environment();
  let store = new SqliteTaskStore(fx.statePath);
  const path = fx.workspace("project");
  const input = fx.startInput(path, "matrix-start-key-123456");
  const accepted = store.start(input);
  store.close(); // Simulate transport loss immediately after the durable start commit.
  store = new SqliteTaskStore(fx.statePath);
  const coordinator = fx.coordinator(store);
  try {
    const repeated = store.start(input);
    assert.equal(repeated.executionId, accepted.executionId);
    assert.equal(repeated.taskId, accepted.taskId);
    assert.throws(() => store.start({ ...input, packet: { ...(input.packet as TaskPacket),
      objective: "Changed objective" } }), (error) => error instanceof StoreConflict && error.code === "IDEMPOTENCY_CONFLICT");
    assert.throws(() => store.start({ ...input, model: "fake/another" }),
      (error) => error instanceof StoreConflict && error.code === "IDEMPOTENCY_CONFLICT");
    assert.equal(store.unresolved().length, 1);
    await coordinator.start();
    const backend = fx.backends.get(path)!;
    assert.equal(backend.createCount, 1);
    assert.equal(backend.submitCount, 1);
    assert.equal(store.dispatchIntent(accepted.executionId)?.messageId,
      backend.turns.get(store.get("scope", accepted.taskId)!.sessionId!));
    assert.equal(store.get("scope", accepted.taskId)?.phase, "running");
  } finally { await coordinator.close(); store.close(); fx.close(); }
});

test("T05: ambiguous create retains ownership until the exact marker is recovered", async () => {
  const fx = environment();
  const path = fx.workspace("project");
  const store = new SqliteTaskStore(fx.statePath);
  const task = store.start(fx.startInput(path, "matrix-create-key-123456"));
  const backend = new MatrixBackend(path);
  backend.ambiguousCreation = true;
  backend.sessions.set("unrelated-marker", "ses_unrelated");
  fx.backends.set(path, backend);
  const coordinator = fx.coordinator(store);
  try {
    await coordinator.start();
    const uncertain = store.get("scope", task.taskId)!;
    assert.equal(uncertain.phase, "dispatching");
    assert.equal(uncertain.observation, "unknown");
    assert.equal(uncertain.sessionId, null);
    assert.equal(backend.submitCount, 0);
    assert.equal(store.reserve("another_execution", [`workspace:${path}`]), false);
    coordinator.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(backend.createCount, 1);
    assert.equal(backend.submitCount, 0);
    backend.sessions.set(uncertain.creationIntent!.marker, "ses_exact");
    coordinator.kick();
    await waitFor(() => store.get("scope", task.taskId)?.phase === "running");
    assert.equal(store.get("scope", task.taskId)?.sessionId, "ses_exact");
    assert.equal(backend.submitCount, 1);
    assert.equal(backend.turns.has("ses_unrelated"), false);
  } finally { await coordinator.close(); store.close(); fx.close(); }
});

test("T13: conflicting workspace stays queued while unrelated workspace dispatches", async () => {
  const fx = environment();
  const a = fx.workspace("project-a");
  const b = fx.workspace("project-b");
  const store = new SqliteTaskStore(fx.statePath);
  const first = store.start(fx.startInput(a, "matrix-first-key-123456"));
  await new Promise((resolve) => setTimeout(resolve, 2));
  const conflict = store.start(fx.startInput(a, "matrix-conflict-key-123456"));
  await new Promise((resolve) => setTimeout(resolve, 2));
  const unrelated = store.start(fx.startInput(b, "matrix-unrelated-key-123456"));
  const coordinator = fx.coordinator(store);
  try {
    await coordinator.start();
    assert.equal(store.get("scope", first.taskId)?.phase, "running");
    assert.equal(store.get("scope", conflict.taskId)?.phase, "queued");
    assert.equal(store.get("scope", unrelated.taskId)?.phase, "running");
    assert.equal(fx.backends.get(a)?.submitCount, 1);
    assert.equal(fx.backends.get(b)?.submitCount, 1);
    fx.backends.get(a)!.finished.add(store.get("scope", first.taskId)!.sessionId!);
    coordinator.kick();
    await waitFor(() => store.get("scope", conflict.taskId)?.phase === "running");
    assert.equal(store.get("scope", first.taskId)?.phase, "completed");
    assert.equal(fx.backends.get(a)?.submitCount, 2);
  } finally { await coordinator.close(); store.close(); fx.close(); }
});

test("T16: missing and malformed reports preserve operational completion but refuse acceptance", async () => {
  const fx = environment();
  const a = fx.workspace("project-a");
  const b = fx.workspace("project-b");
  const store = new SqliteTaskStore(fx.statePath);
  const missing = store.start(fx.startInput(a, "matrix-missing-key-123456"));
  const malformed = store.start(fx.startInput(b, "matrix-malformed-key-123456"));
  const coordinator = fx.coordinator(store);
  const service = new SupervisorService(store, fx.artifacts, coordinator);
  try {
    await coordinator.start();
    for (const task of [missing, malformed]) {
      const path = task.workspace;
      fx.backends.get(path)!.finished.add(store.get("scope", task.taskId)!.sessionId!);
    }
    const reportPath = store.get("scope", malformed.taskId)!.reportPath!;
    writeFileSync(join(reportPath, "result.json"), "{broken json");
    writeFileSync(join(reportPath, "summary.md"), "Summary\n");
    coordinator.kick();
    await waitFor(() => [missing, malformed].every((task) => store.get("scope", task.taskId)?.phase === "completed"));
    for (const [task, validity] of [[missing, "missing"], [malformed, "invalid"]] as const) {
      const done = store.get("scope", task.taskId)!;
      assert.equal(done.reportValidity, validity);
      assert.equal(done.reviewStatus, "pending");
      await assert.rejects(service.handle("record_review", { scope_id: "scope", task_id: task.taskId,
        execution_id: task.executionId, expected_revision: done.revision,
        idempotency_key: `review-${validity}-123456789`, review: {
          disposition: "accepted", rationale: "Attempted acceptance", criteria: [],
          starting_state_sha256: done.baselineHash, final_manifest_sha256: done.finalManifestHash,
          freshness: "current", integration_checks: [], coverage_limits: [], unresolved_issues: [], next_action: "none",
        } }), (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_STATE");
    }
  } finally { await coordinator.close(); store.close(); fx.close(); }
});
