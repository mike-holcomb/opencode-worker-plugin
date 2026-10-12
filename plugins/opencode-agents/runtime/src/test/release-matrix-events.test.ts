import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../artifacts.js";
import type { BackendEvent, OpenCodeBackend, PendingRequest, RequestControl, TurnObservation } from "../backend.js";
import { loadConfiguration } from "../config.js";
import { ExecutionCoordinator } from "../coordinator.js";
import type { TaskPacket } from "../contracts.js";
import { assertWorkerPolicy, workerPolicy } from "../managed-server.js";
import { renderPrompt } from "../prompt.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore } from "../store.js";
import { captureBaseline } from "../workspace.js";

class EventBackend implements OpenCodeBackend {
  backendId = "backend_initial";
  readonly sessionId = "session_exact";
  status: "idle" | "busy" = "idle";
  finished = false;
  submitCount = 0;
  messageId = "";
  events: BackendEvent[] = [];
  requests: PendingRequest[] = [];
  constructor(readonly workspace: string) {}
  async inspectBackend() { return { version: "fake", openapiDigest: "fake", backendId: this.backendId,
    workspace: this.workspace, configurationDigest: "fake", supportedForExecution: true,
    capabilities: { callerAssignedMessageId: true, permissionRequests: true, questionRequests: false,
      structuredOutput: false, sessionRecovery: true } }; }
  async createSession() { return { id: this.sessionId, backendId: this.backendId, workspace: this.workspace }; }
  async findCreatedSession() { return null; }
  async submitTurn(input: { messageId: string }) { this.submitCount++; this.messageId = input.messageId; }
  async inspectTurn(sessionId: string, messageId: string): Promise<TurnObservation> {
    assert.equal(sessionId, this.sessionId);
    assert.equal(messageId, this.messageId);
    return { submitted: this.submitCount > 0, assistantMessageIds: this.finished ? ["assistant_exact"] : [],
      activeTools: 0, status: this.status, pendingRequests: this.requests, finished: this.finished, error: null };
  }
  async *subscribeEvents(control?: RequestControl): AsyncIterable<BackendEvent> {
    while (!control?.signal?.aborted) {
      const event = this.events.shift();
      if (event?.type === "_disconnect") throw new Error("injected SSE disconnect");
      if (event) yield event;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async replyToRequest() { throw new Error("no native request expected"); }
  async abortSession() { return true; }
  async readResult() { return { text: "", structured: null }; }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-release-events-"));
  mkdirSync(join(root, "project"));
  const workspace = realpathSync(join(root, "project"));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ schema_version: 1, project_roots: [root], read_roots: [],
    opencode_binary: "/usr/bin/false", models: { local: { provider_id: "fake", model_id: "model", destination: "local" } },
    development_execution: { enabled: true, trusted_workspaces: [workspace] },
    limits: { concurrency: 2, queue_timeout_seconds: 600, execution_timeout_seconds: 1800,
      finalization_timeout_seconds: 60, artifact_bytes: 50_000_000 } }));
  const previous = process.env.OPENCODE_AGENTS_CONFIG;
  process.env.OPENCODE_AGENTS_CONFIG = configPath;
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const backend = new EventBackend(workspace);
  const coordinator = new ExecutionCoordinator(store, artifacts, async ({ backendId }) => {
    backend.backendId = backendId;
    return { backendId, backend, close: async () => {} };
  });
  const service = new SupervisorService(store, artifacts, coordinator, async (_binary, _workspace, reportPath) => ({
    configContent: JSON.stringify({ provider: { fake: { options: { baseURL: "http://127.0.0.1:8124/v1" } } } }),
    effectiveConfigSha256: "fake-fixture-config",
    reportPath,
  }));
  const packet: TaskPacket = { title: "Inspect", objective: "Inspect the workspace", tier: "lightweight",
    authoritative_inputs: [], context: { verified_facts: [], rejected_assumptions: [], exclusions: [] },
    allowed_writes: [], acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
  const taskId = `task_${randomUUID()}`;
  const executionId = `exec_${randomUUID()}`;
  const baseline = captureBaseline({ workspace, projectRoots: [root], packet });
  const reportPath = join(root, "reports", executionId);
  const prompt = renderPrompt({ taskId, executionId, profile: "bounded-inspect", packet, baseline, outputDirectory: reportPath });
  const task = store.start({ taskId, executionId, scopeId: "scope", idempotencyKey: "event-start-123456789",
    workspace, packet, model: "fake/model", profile: "bounded-inspect", baselineHash: baseline.sha256,
    promptHash: prompt.sha256, frozenPrompt: prompt.text, frozenBaseline: baseline, reportPath,
    backendConfig: loadConfiguration(), launchContract: {
      configContent: JSON.stringify({ provider: { fake: { options: { baseURL: "http://127.0.0.1:8124/v1" } } } }),
      effectiveConfigSha256: "fake-fixture-config", reportPath } });
  return { root, workspace, store, artifacts, backend, coordinator, service, packet, task, async close() {
    await coordinator.close();
    store.close();
    if (previous === undefined) delete process.env.OPENCODE_AGENTS_CONFIG;
    else process.env.OPENCODE_AGENTS_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  } };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("expected state was not reached");
}

test("T06: initial idle snapshot after prompt acceptance is not completion", async () => {
  const fx = fixture();
  try {
    await fx.coordinator.start();
    assert.equal(fx.backend.submitCount, 1);
    fx.backend.events.push({ type: "session.idle", sessionId: fx.backend.sessionId, data: {} });
    fx.coordinator.kick();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const task = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(task.phase, "running");
    assert.equal(task.reportValidity, "pending");
    assert.equal(task.reviewStatus, "pending");
    assert.equal(fx.store.events(task.executionId).some((event) => event.kind === "finalized"), false);
  } finally { await fx.close(); }
});

test("T07: duplicate and late event notifications cannot reverse completion or duplicate evidence", async () => {
  const fx = fixture();
  try {
    await fx.coordinator.start();
    const active = fx.store.get("scope", fx.task.taskId)!;
    writeFileSync(join(active.reportPath!, "result.json"), JSON.stringify({ schema_version: 2,
      task_id: active.taskId, execution_id: active.executionId, outcome: "completed", summary: "Inspected workspace.",
      coverage: ["workspace"], gaps: [], findings: [], changes: [], checks: [], blockers: [], next_action: "Review" }));
    writeFileSync(join(active.reportPath!, "summary.md"), "Inspected workspace.\n");
    fx.backend.finished = true;
    fx.backend.events.push({ type: "message.updated", sessionId: fx.backend.sessionId, data: { sequence: 2 } },
      { type: "message.updated", sessionId: fx.backend.sessionId, data: { sequence: 2 } },
      { type: "session.idle", sessionId: fx.backend.sessionId, data: { sequence: 1 } });
    fx.coordinator.kick();
    await eventually(() => fx.store.get("scope", fx.task.taskId)?.phase === "completed");
    const done = fx.store.get("scope", fx.task.taskId)!;
    const artifactIds = fx.store.artifactsForExecution(done.executionId).map((entry) => entry.artifactId);
    assert.equal(done.reportValidity, "valid");
    assert.equal(fx.store.events(done.executionId).filter((event) => event.kind === "finalized").length, 1);
    fx.backend.events.push({ type: "session.busy", sessionId: fx.backend.sessionId, data: { sequence: 0 } },
      { type: "session.idle", sessionId: fx.backend.sessionId, data: { sequence: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "completed");
    assert.deepEqual(fx.store.artifactsForExecution(done.executionId).map((entry) => entry.artifactId), artifactIds);
    assert.equal(fx.backend.submitCount, 1);
  } finally { await fx.close(); }
});

test("T08: an SSE disconnect during a permission request recovers the exact request by snapshot", async () => {
  const fx = fixture();
  try {
    await fx.coordinator.start();
    fx.backend.requests = [{ id: "permission_exact", sessionId: fx.backend.sessionId,
      type: "permission", api: "legacy", detail: { permission: "bash", patterns: ["pwd"] } }];
    fx.backend.events.push({ type: "_disconnect", sessionId: fx.backend.sessionId, data: null });
    await eventually(() => fx.store.get("scope", fx.task.taskId)?.pendingRequests.some((request) =>
      request.requestId === "permission_exact") ?? false);
    const blocked = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(blocked.phase, "waiting_input");
    assert.equal(blocked.pendingRequests[0]?.detail &&
      (blocked.pendingRequests[0].detail as { sessionId: string }).sessionId, fx.backend.sessionId);
    assert.equal(fx.store.events(blocked.executionId).filter((event) => event.kind === "input_request").length, 1);
    assert.ok(fx.store.events(blocked.executionId).some((event) =>
      (event.detail as { reason?: string }).reason?.includes("event stream disconnected")));
  } finally { await fx.close(); }
});

test("T15: a symlink workspace alias resolves to the same reservation key", async () => {
  const fx = fixture();
  try {
    const alias = join(fx.root, "alias");
    symlinkSync(fx.workspace, alias, "dir");
    const aliasedBaseline = captureBaseline({ workspace: alias, projectRoots: [fx.root], packet: fx.packet });
    assert.equal(aliasedBaseline.workspace, fx.workspace);
    const aliasTask = fx.store.start({ scopeId: "scope", idempotencyKey: "alias-task-123456789",
      workspace: aliasedBaseline.workspace, packet: fx.packet, model: "fake/model", profile: "bounded-inspect",
      baselineHash: aliasedBaseline.sha256, promptHash: "c".repeat(64) });
    const first = fx.store.admit(fx.task.scopeId, fx.task.taskId, fx.task.revision,
      [`workspace:${fx.task.workspace}`]);
    assert.equal(first?.phase, "dispatching");
    assert.equal(fx.store.admit(aliasTask.scopeId, aliasTask.taskId, aliasTask.revision,
      [`workspace:${aliasedBaseline.workspace}`]), null);
  } finally { await fx.close(); }
});

test("T20: worker policy excludes the parent review channel and rejects an enabled inherited MCP", () => {
  const { profiles } = workerPolicy("/tmp/opencode-agents-state/reports", "/tmp/project");
  const inherited = { opencode_agents: { enabled: false } };
  assert.equal(profiles["bounded-inspect"]?.permission.task, "deny");
  assert.equal(profiles["bounded-build"]?.permission.task, "deny");
  assertWorkerPolicy({ plugin: [], mcp: inherited, agent: profiles }, profiles);
  assert.throws(() => assertWorkerPolicy({ plugin: [], mcp: { opencode_agents: { enabled: true } },
    agent: profiles }, profiles), /MCP server opencode_agents is enabled/);
});

test("T30: native question capability is absent; a blocked report can be followed in a new execution", async () => {
  const fx = fixture();
  try {
    const { profiles } = workerPolicy(join(fx.root, "reports"), fx.workspace);
    assert.equal(profiles["bounded-inspect"]?.permission.question, "deny");
    assert.equal((await fx.backend.inspectBackend()).capabilities.questionRequests, false);
    await fx.coordinator.start();
    const active = fx.store.get("scope", fx.task.taskId)!;
    writeFileSync(join(active.reportPath!, "result.json"), JSON.stringify({ schema_version: 2,
      task_id: active.taskId, execution_id: active.executionId, outcome: "blocked", summary: "Need a user answer.",
      coverage: ["workspace"], gaps: ["question unavailable"], findings: [], changes: [], checks: [],
      blockers: ["Which interpretation should I use?"], next_action: "Parent supplies an explicit follow-up" }));
    writeFileSync(join(active.reportPath!, "summary.md"), "Blocked: Which interpretation should I use?\n");
    fx.backend.finished = true;
    fx.coordinator.kick();
    await eventually(() => fx.store.get("scope", fx.task.taskId)?.phase === "completed");
    const predecessor = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(predecessor.reportValidity, "valid");
    const follow = await fx.service.handle("continue_task", { scope_id: "scope", task_id: predecessor.taskId,
      predecessor_execution_id: predecessor.executionId, expected_revision: predecessor.revision,
      idempotency_key: "blocked-follow-123456789", context_mode: "fresh",
      packet: { ...fx.packet, context: { ...fx.packet.context,
        verified_facts: ["The parent selected the first interpretation."] } } }) as { executionId: string; phase: string };
    assert.notEqual(follow.executionId, predecessor.executionId);
    assert.equal(follow.phase, "queued");
    assert.equal(fx.store.getExecution("scope", predecessor.taskId, predecessor.executionId)?.reportValidity, "valid");
  } finally { await fx.close(); }
});

test("T31: delayed evidence capture holds the reservation and follow-up gate until publication", async () => {
  const fx = fixture();
  const register = fx.store.registerArtifact.bind(fx.store);
  try {
    await fx.coordinator.start();
    const active = fx.store.get("scope", fx.task.taskId)!;
    writeFileSync(join(active.reportPath!, "result.json"), JSON.stringify({ schema_version: 2,
      task_id: active.taskId, execution_id: active.executionId, outcome: "completed", summary: "Work completed.",
      coverage: ["workspace"], gaps: [], findings: [], changes: [], checks: [], blockers: [], next_action: "Review" }));
    writeFileSync(join(active.reportPath!, "summary.md"), "Work completed.\n");
    fx.store.registerArtifact = () => { throw new Error("transient publication delay"); };
    fx.backend.finished = true;
    fx.coordinator.kick();
    await eventually(() => {
      const task = fx.store.get("scope", fx.task.taskId);
      return task?.phase === "finalizing" && task.observation === "unknown";
    });
    const pending = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(pending.reportValidity, "pending");
    assert.equal(fx.store.reserve("competing_writer", [`workspace:${pending.workspace}`]), false);
    await assert.rejects(fx.service.handle("continue_task", { scope_id: "scope", task_id: pending.taskId,
      predecessor_execution_id: pending.executionId, expected_revision: pending.revision,
      idempotency_key: "too-early-follow-123456789", context_mode: "fresh", packet: fx.packet }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_STATE");
    fx.store.registerArtifact = register;
    fx.coordinator.kick();
    await eventually(() => fx.store.get("scope", fx.task.taskId)?.phase === "completed");
    const done = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(done.reportValidity, "valid");
    assert.equal(done.phase, "completed");
  } finally { fx.store.registerArtifact = register; await fx.close(); }
});
