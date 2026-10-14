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
import { SqliteTaskStore, type CancellationDiagnostic } from "../store.js";
import { captureBaseline } from "../workspace.js";

class FakeBackend implements OpenCodeBackend {
  readonly backendId = "backend_fake";
  readonly workspace: string;
  submitted = false;
  finished = false;
  aborted = false;
  abortCount = 0;
  stopped = false;
  submitCount = 0;
  created = false;
  createAckLost = false;
  submitAckLost = false;
  sessionId = "ses_fake";
  messageId = "";
  requests: PendingRequest[] = [];
  replyCount = 0;
  replyFailure: "pending" | "gone" | null = null;
  inspectionCount = 0;
  error: string | null = null;
  constructor(workspace: string) { this.workspace = workspace; }
  async inspectBackend() { return { version: "fake", openapiDigest: "fake", backendId: this.backendId,
    workspace: this.workspace, configurationDigest: "fake", supportedForExecution: true,
    capabilities: { callerAssignedMessageId: true, permissionRequests: true, questionRequests: false,
      structuredOutput: false, sessionRecovery: true } }; }
  async createSession() {
    this.created = true;
    if (this.createAckLost) { this.createAckLost = false; throw new Error("lost session acknowledgement"); }
    return { id: this.sessionId, backendId: this.backendId, workspace: this.workspace };
  }
  async findCreatedSession() { return this.created ? { id: this.sessionId, backendId: this.backendId, workspace: this.workspace } : null; }
  async submitTurn(input: { messageId: string }) {
    this.submitCount++; this.submitted = true; this.messageId = input.messageId;
    if (this.submitAckLost) { this.submitAckLost = false; throw new Error("lost prompt acknowledgement"); }
  }
  async inspectTurn(_sessionId: string, messageId: string): Promise<TurnObservation> {
    assert.equal(messageId, this.messageId);
    this.inspectionCount++;
    return { submitted: this.submitted, assistantMessageIds: this.finished ? ["assistant"] : [],
      activeTools: this.stopped ? 0 : 1, status: this.stopped ? "idle" : "busy", pendingRequests: this.requests,
      statusOmitted: this.stopped, finished: this.finished, error: this.error };
  }
  async *subscribeEvents(_control?: RequestControl) { await new Promise(() => {}); }
  async replyToRequest(request: PendingRequest, _reply: "allow_once" | "deny" | string[][]) {
    this.replyCount++;
    if (this.replyFailure !== "pending") this.requests = this.requests.filter((item) => item.id !== request.id);
    if (this.replyFailure) throw new Error("lost reply acknowledgement");
  }
  async abortSession() { this.abortCount++; this.aborted = true; return true; }
  async readResult() { return { text: "", structured: null }; }
}

function setup(executionTimeoutSeconds?: number, finalizationTimeoutSeconds?: number, managedStopProof = false) {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-coordinator-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "input.txt"), "original\n");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ schema_version: 1, project_roots: [root], read_roots: [],
    opencode_binary: "/usr/bin/false", models: { local: { provider_id: "fake", model_id: "model", destination: "local" } },
    limits: { concurrency: 2, queue_timeout_seconds: 600, execution_timeout_seconds: 1800,
      ...(finalizationTimeoutSeconds ? { finalization_timeout_seconds: finalizationTimeoutSeconds } : {}),
      artifact_bytes: 50_000_000 } }));
  const previous = process.env.OPENCODE_AGENTS_CONFIG;
  process.env.OPENCODE_AGENTS_CONFIG = configPath;
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const backend = new FakeBackend(workspace);
  const lifecycle = { opens: 0, closes: 0, alive: true, terminations: 0, terminationSucceeds: true };
  const opener = async ({ backendId }: { backendId: string }) => {
    lifecycle.opens++;
    lifecycle.alive = true;
    assert.notEqual(backendId, "");
    // The fake endpoint adopts the coordinator's stable storage identity.
    Object.assign(backend, { backendId });
    return { backendId, backend, instanceId: `process_${lifecycle.opens}`, isAlive: () => lifecycle.alive,
      close: async () => { lifecycle.closes++; },
      ...(managedStopProof ? { terminateOwned: async () => {
        lifecycle.terminations++;
        if (lifecycle.terminationSucceeds) lifecycle.alive = false;
        return lifecycle.terminationSucceeds;
      }, confirmAbortStopped: async (sessionId: string, messageId: string) => {
        assert.equal(sessionId, backend.sessionId);
        const observed = await backend.inspectTurn(sessionId, messageId);
        return { observation: observed, stopped: observed.submitted && !observed.finished && observed.statusOmitted === true && observed.activeTools === 0 &&
          observed.pendingRequests.length === 0 };
      } } : {}) };
  };
  const coordinator = new ExecutionCoordinator(store, artifacts, opener);
  const packet: TaskPacket = { title: "Inspect", objective: "Read input", tier: "lightweight",
    authoritative_inputs: [{ reference: "input.txt", kind: "file", purpose: "Source" }],
    context: { verified_facts: [], rejected_assumptions: [], exclusions: [] }, allowed_writes: [],
    acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
  const baseline = captureBaseline({ workspace, projectRoots: [root], packet });
  const taskId = `task_${randomUUID()}`;
  const executionId = `exec_${randomUUID()}`;
  const reportPath = join(root, "reports", executionId);
  const prompt = renderPrompt({ taskId, executionId, profile: "bounded-inspect", packet, baseline, outputDirectory: reportPath });
  const task = store.start({ taskId, executionId, scopeId: "scope", idempotencyKey: "start-key-123456789",
    workspace, packet, model: "fake/model", profile: "bounded-inspect", baselineHash: baseline.sha256,
    promptHash: prompt.sha256, frozenPrompt: prompt.text, frozenBaseline: baseline, reportPath,
    backendConfig: loadConfiguration(),
    launchContract: { configContent: "{}", effectiveConfigSha256: "fixture", reportPath },
    ...(executionTimeoutSeconds ? { executionTimeoutSeconds } : {}) });
  return { root, store, artifacts, coordinator, lifecycle,
    restart: () => new ExecutionCoordinator(store, artifacts, opener), backend, task, restore: () => {
    if (previous === undefined) delete process.env.OPENCODE_AGENTS_CONFIG;
    else process.env.OPENCODE_AGENTS_CONFIG = previous;
    store.close(); rmSync(root, { recursive: true, force: true });
  } };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "expected reconciliation did not finish");
}

function cancelFixture(fx: ReturnType<typeof setup>, deadline = false) {
  const task = fx.store.get("scope", fx.task.taskId)!;
  return fx.store.cancelTask({ scopeId: task.scopeId, taskId: task.taskId, executionId: task.executionId,
    expectedRevision: task.revision, idempotencyKey: "issue-four-cancel-123456", reason: "stop", requester: "parent",
    ...(deadline ? { deadlineOrigin: task.executionDeadlineAt! } : {}) });
}

function permission(fx: ReturnType<typeof setup>, id = "per_cancel"): PendingRequest {
  return { id, sessionId: fx.backend.sessionId, type: "permission", api: "legacy",
    detail: { permission: "bash", patterns: ["private-request-content"] } };
}

test("cancellation reconciles new and vanished permissions without restoring waiting_input", async () => {
  const fx = setup(undefined, undefined, true);
  try {
    await fx.coordinator.start();
    fx.backend.requests = [permission(fx)];
    cancelFixture(fx);
    fx.coordinator.kick();
    await until(() => fx.store.get("scope", fx.task.taskId)?.pendingRequests.length === 1);
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "cancelling");
    fx.backend.requests = [];
    fx.backend.stopped = true;
    fx.coordinator.kick();
    await until(() => fx.store.get("scope", fx.task.taskId)?.phase === "cancelled");
    assert.equal(fx.store.get("scope", fx.task.taskId)?.pendingRequests.length, 0);
    assert.equal(fx.store.inputRequests(fx.task.executionId)[0]?.status, "expired");
  } finally { await fx.coordinator.close(); fx.restore(); }
});

for (const lostReply of [false, true]) {
  test(`permission denial during cancellation is at most once (lost reply: ${lostReply})`, async () => {
    const fx = setup();
    try {
      await fx.coordinator.start();
      fx.backend.requests = [permission(fx)];
      cancelFixture(fx);
      fx.coordinator.kick();
      await until(() => fx.store.get("scope", fx.task.taskId)?.pendingRequests.length === 1);
      const service = new SupervisorService(fx.store, fx.artifacts, fx.coordinator);
      const input = { scope_id: "scope", task_id: fx.task.taskId, execution_id: fx.task.executionId,
        request_id: "per_cancel", request_revision: 1, reply: "deny", authorization_basis: "parent cancellation",
        idempotency_key: "cancel-deny-request-12345" };
      await assert.rejects(service.handle("respond_to_request", { ...input, reply: "allow_once" }), /only permission denial/);
      await assert.rejects(service.handle("respond_to_request", { ...input, request_revision: 2 }), /revision is stale/);
      if (lostReply) fx.backend.replyFailure = "pending";
      await service.handle("respond_to_request", input);
      await service.handle("respond_to_request", input);
      assert.equal(fx.backend.replyCount, 1);
      assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "cancelling");
      fx.backend.requests = [];
      fx.coordinator.kick();
      await until(() => fx.store.get("scope", fx.task.taskId)?.pendingRequests.length === 0);
      assert.equal(fx.store.inputRequests(fx.task.executionId)[0]?.status, lostReply ? "unconfirmed" : "responded");
    } finally { await fx.coordinator.close(); fx.restore(); }
  });
}

for (const deadline of [false, true]) {
  test(`retained permissions trigger owned-worker recovery after the grace period (deadline: ${deadline})`, async (t) => {
    const fx = setup(undefined, undefined, true);
    try {
      await fx.coordinator.start();
      fx.backend.requests = [permission(fx)];
      fx.backend.stopped = true;
      const task = cancelFixture(fx, deadline);
      let clock = Date.parse(task.cancellationIntent!.createdAt) + 29_999;
      t.mock.method(Date, "now", () => clock);
      fx.coordinator.kick();
      await until(() => fx.store.get("scope", fx.task.taskId)?.observation === "unknown");
      assert.equal(fx.lifecycle.terminations, 0);
      assert.equal(fx.store.ownsResource(task.executionId, `workspace:${task.workspace}`), true);
      clock++;
      fx.coordinator.kick();
      await until(() => fx.store.get("scope", fx.task.taskId)?.phase === (deadline ? "timed_out" : "cancelled"));
      assert.equal(fx.lifecycle.terminations, 1);
      assert.equal(fx.lifecycle.opens, 1, "finalization must not reopen the terminated backend");
      assert.equal(fx.backend.submitCount, 1);
      assert.equal(fx.store.get("scope", fx.task.taskId)?.pendingRequests.length, 0);
      assert.equal(fx.store.ownsResource(task.executionId, `workspace:${task.workspace}`), false);
      assert.ok(fx.store.cancellationEvent(task.executionId, "cancellation_stop_confirmed"));
    } finally { await fx.coordinator.close(); fx.restore(); }
  });
}

test("failed termination retains ownership and retries the original process handle", async (t) => {
  const fx = setup(undefined, undefined, true);
  try {
    await fx.coordinator.start();
    fx.lifecycle.terminationSucceeds = false;
    const task = cancelFixture(fx);
    t.mock.method(Date, "now", () => Date.parse(task.cancellationIntent!.createdAt) + 30_001);
    fx.coordinator.kick();
    await until(() => fx.lifecycle.terminations > 0);
    assert.equal(fx.store.get("scope", task.taskId)?.phase, "cancelling");
    assert.equal(fx.store.ownsResource(task.executionId, `workspace:${task.workspace}`), true);
    assert.equal(fx.store.cancellationEvent(task.executionId, "cancellation_stop_confirmed"), null);
    fx.lifecycle.terminationSucceeds = true;
    fx.coordinator.kick();
    await until(() => fx.store.get("scope", task.taskId)?.phase === "cancelled");
    assert.equal(fx.lifecycle.opens, 1);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("an unavailable authenticated endpoint still permits recovery through the owned handle", async (t) => {
  const fx = setup(undefined, undefined, true);
  try {
    await fx.coordinator.start();
    const task = cancelFixture(fx);
    fx.backend.inspectTurn = async () => { throw new Error("private credential must not appear in diagnostics"); };
    t.mock.method(Date, "now", () => Date.parse(task.cancellationIntent!.createdAt) + 30_001);
    fx.coordinator.kick();
    await until(() => fx.store.get("scope", task.taskId)?.phase === "cancelled");
    assert.equal(fx.lifecycle.terminations, 1);
    assert.equal(JSON.stringify(fx.store.events(task.executionId)).includes("private credential"), false);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("restart after termination intent cannot substitute a new handle for unconfirmed exit", async (t) => {
  const fx = setup(undefined, undefined, true);
  let resumed: ExecutionCoordinator | null = null;
  try {
    await fx.coordinator.start();
    fx.lifecycle.terminationSucceeds = false;
    const task = cancelFixture(fx);
    t.mock.method(Date, "now", () => Date.parse(task.cancellationIntent!.createdAt) + 30_001);
    fx.coordinator.kick();
    await until(() => fx.lifecycle.terminations > 0);
    await fx.coordinator.close();
    resumed = fx.restart();
    await resumed.start();
    assert.equal(fx.lifecycle.opens, 1);
    assert.equal(fx.store.get("scope", task.taskId)?.phase, "cancelling");
    assert.equal(fx.store.ownsResource(task.executionId, `workspace:${task.workspace}`), true);
    assert.equal(fx.store.cancellationEvent(task.executionId, "cancellation_diagnostic")?.detail.reason, "owned_process_handle_unavailable");
  } finally { await resumed?.close(); await fx.coordinator.close(); fx.restore(); }
});

test("confirmed exit survives restart and finalizes without opening a backend", async () => {
  const fx = setup(undefined, undefined, true);
  let resumed: ExecutionCoordinator | null = null;
  try {
    await fx.coordinator.start();
    const task = cancelFixture(fx);
    await fx.coordinator.close();
    const proof = { backendId: task.backendId!, instanceId: "process_1" };
    fx.store.recordCancellationEvent(task.executionId, "cancellation_recovery_intent", proof);
    fx.store.recordCancellationEvent(task.executionId, "cancellation_stop_confirmed", proof);
    resumed = fx.restart();
    await resumed.start();
    await until(() => fx.store.get("scope", task.taskId)?.phase === "cancelled");
    assert.equal(fx.lifecycle.opens, 1);
  } finally { await resumed?.close(); await fx.coordinator.close(); fx.restore(); }
});

test("recovery refuses a lease without exclusive workspace ownership", async (t) => {
  const fx = setup(undefined, undefined, true);
  try {
    await fx.coordinator.start();
    const task = cancelFixture(fx);
    t.mock.method(fx.store, "ownsResource", () => false);
    t.mock.method(Date, "now", () => Date.parse(task.cancellationIntent!.createdAt) + 30_001);
    fx.coordinator.kick();
    await until(() => fx.store.cancellationEvent(task.executionId, "cancellation_diagnostic")?.detail.reason === "exclusive_worker_ownership_unproven");
    assert.equal(fx.lifecycle.terminations, 0);
    assert.equal(fx.store.get("scope", task.taskId)?.phase, "cancelling");
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("cancellation diagnostics retain counts, deduplicate repeats and emit a heartbeat", async (t) => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    fx.backend.requests = [permission(fx)];
    const task = cancelFixture(fx);
    fx.coordinator.kick();
    await until(() => Boolean(fx.store.cancellationEvent(task.executionId, "cancellation_diagnostic")));
    const first = fx.store.cancellationEvent(task.executionId, "cancellation_diagnostic")!;
    const count = () => fx.store.events(task.executionId).filter((event) => event.kind === "cancellation_diagnostic").length;
    const initial = count();
    fx.coordinator.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(count(), initial);
    assert.equal(first.detail.pendingRequests, 1);
    assert.equal(first.detail.activeTools, 1);
    assert.equal(JSON.stringify(first).includes("private-request-content"), false);
    t.mock.method(Date, "now", () => Date.parse(first.createdAt) + 30_000);
    // Exercise durable heartbeat storage independently of recovery's changed reason.
    fx.store.recordCancellationEvent(task.executionId, "cancellation_diagnostic", first.detail as CancellationDiagnostic);
    assert.equal(count(), initial + 1);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("durable admission dispatches one exact message and a finished turn with no report remains unaccepted", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    assert.equal(fx.backend.submitCount, 1);
    const running = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(running.phase, "running");
    assert.equal(fx.store.dispatchIntent(running.executionId)?.messageId, fx.backend.messageId);
    fx.backend.finished = true;
    fx.backend.stopped = true;
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "completed"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const done = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(done.phase, "completed");
    assert.equal(done.reportValidity, "missing");
    assert.equal(done.reviewStatus, "pending");
    assert.equal(fx.backend.submitCount, 1);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("terminal executions release backend leases while unresolved work retains them", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    assert.equal(fx.lifecycle.opens, 1);
    assert.equal(fx.lifecycle.closes, 0);
    fx.coordinator.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fx.lifecycle.closes, 0);
    fx.backend.finished = true;
    fx.backend.stopped = true;
    for (let i = 0; i < 100 && fx.lifecycle.closes === 0; i++) {
      fx.coordinator.kick(); await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "completed");
    assert.equal(fx.lifecycle.closes, 1);
    assert.equal(fx.backend.submitCount, 1);
    await fx.coordinator.close();
    assert.equal(fx.lifecycle.closes, 1);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("a proven dead owned backend reopens and reconciles the exact turn without replay", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    const before = fx.store.get("scope", fx.task.taskId)!;
    fx.lifecycle.alive = false;
    for (let i = 0; i < 100 && fx.lifecycle.opens < 2; i++) {
      fx.coordinator.kick(); await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const after = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(fx.lifecycle.opens, 2);
    assert.equal(fx.lifecycle.closes, 1);
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.userMessageId, before.userMessageId);
    assert.equal(after.executionId, before.executionId);
    assert.equal(fx.backend.submitCount, 1);
    assert.equal(after.phase, "running");
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("generic backend abort acknowledgement and idle snapshot retain ownership", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    const active = fx.store.get("scope", fx.task.taskId)!;
    fx.store.cancelTask({ scopeId: "scope", taskId: active.taskId, executionId: active.executionId,
      expectedRevision: active.revision, idempotencyKey: "cancel-key-12345678", reason: "stop", requester: "parent" });
    fx.coordinator.kick();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const pending = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(pending.phase, "cancelling");
    assert.equal(pending.observation, "unknown");
    assert.equal(fx.backend.aborted, true);
    assert.equal(fx.store.reserve(`other_${randomUUID()}`, [`workspace:${pending.workspace}`]), false);
    fx.backend.stopped = true;
    fx.coordinator.kick();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "cancelling");
    assert.equal(fx.store.reserve(`other_${randomUUID()}`, [`workspace:${pending.workspace}`]), false);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

for (const scenario of ["no pending requests", "a pending request", "normal completion"]) {
  test(`an in-flight observation preserves cancellation with ${scenario}`, async (t) => {
    const fx = setup();
    let resumed: ExecutionCoordinator | null = null;
    const entered = Promise.withResolvers<void>();
    const inspection = Promise.withResolvers<TurnObservation>();
    try {
      await fx.coordinator.start();
      const active = fx.store.get("scope", fx.task.taskId)!;
      assert.equal(active.phase, "running");
      const inspectTurn = fx.backend.inspectTurn.bind(fx.backend);
      fx.backend.inspectTurn = async () => {
        entered.resolve();
        return inspection.promise;
      };
      fx.coordinator.kick();
      await entered.promise;
      const current = fx.store.get("scope", active.taskId)!;
      const cancelled = fx.store.cancelTask({ scopeId: "scope", taskId: current.taskId, executionId: current.executionId,
        expectedRevision: current.revision, idempotencyKey: "observe-cancel-123456", reason: "stop", requester: "parent" });
      assert.equal(cancelled.phase, "cancelling");
      assert.ok(cancelled.cancellationIntent);
      const requests: PendingRequest[] = scenario === "a pending request" ? [{ id: "per_race", sessionId: fx.backend.sessionId,
        type: "permission", api: "legacy", detail: { permission: "bash", patterns: ["pwd"] } }] : [];
      // Stop scheduling before releasing inspection so the assertion sees the
      // raced observation's write, without a later tick masking the regression.
      const closing = fx.coordinator.close();
      fx.backend.finished = scenario === "normal completion";
      inspection.resolve({ ...await inspectTurn(fx.backend.sessionId, fx.backend.messageId), pendingRequests: requests });
      await closing;
      fx.backend.inspectTurn = inspectTurn;
      const after = fx.store.get("scope", active.taskId)!;
      assert.equal(after.phase, "cancelling");
      assert.equal(after.observation, cancelled.observation);
      assert.deepEqual(after.cancellationIntent, cancelled.cancellationIntent);
      assert.equal(fx.store.reserve("other-observation", [`workspace:${active.workspace}`]), false);

      // An existing parent cancellation must still be actionable after the
      // execution deadline, rather than being skipped or replaced by a timeout.
      t.mock.method(Date, "now", () => Date.parse(active.executionDeadlineAt!) + 1);
      resumed = fx.restart();
      await resumed.start();
      await resumed.close();
      assert.equal(fx.backend.aborted, scenario !== "normal completion");
      if (scenario !== "normal completion") {
        assert.equal(fx.store.get("scope", active.taskId)?.phase, "cancelling");
        assert.equal(fx.store.reserve("other-observation", [`workspace:${active.workspace}`]), false);
        fx.backend.finished = true;
        fx.backend.error = JSON.stringify({ name: "MessageAbortedError", data: { message: "Aborted" } });
        resumed = fx.restart();
        await resumed.start();
        await resumed.close();
      } else {
        assert.ok(fx.store.events(active.executionId).some((event) => event.kind === "finalizing" &&
          (event.detail as { detail?: { cancelEffect?: string } }).detail?.cancelEffect === "not_applied"));
      }
      assert.equal(fx.store.get("scope", active.taskId)?.phase, "finalizing");
      resumed = fx.restart();
      await resumed.start();
      assert.equal(fx.store.get("scope", active.taskId)?.phase, scenario === "normal completion" ? "completed" : "cancelled");
      const followup = fx.store.start({ scopeId: "scope", idempotencyKey: "after-cancel-12345678", workspace: active.workspace,
        packet: active.packet, model: active.model, profile: active.profile,
        baselineHash: active.baselineHash, promptHash: active.promptHash });
      assert.ok(fx.store.admit("scope", followup.taskId, followup.revision, [`workspace:${active.workspace}`]));
      assert.equal(fx.backend.submitCount, 1);
    } finally {
      inspection.resolve({ submitted: true, assistantMessageIds: [], activeTools: 1, status: "busy",
        pendingRequests: [], finished: false, error: null });
      await resumed?.close(); await fx.coordinator.close(); fx.restore();
    }
  });
}

for (const phase of ["dispatching", "running", "waiting_input"] as const) {
  test(`reconciliation recovers durable cancellation intent stranded in ${phase}`, async (t) => {
    const fx = setup();
    let resumed: ExecutionCoordinator | null = null;
    try {
      await fx.coordinator.start();
      await fx.coordinator.close();
      const active = fx.store.get("scope", fx.task.taskId)!;
      const cancelled = fx.store.cancelTask({ scopeId: "scope", taskId: active.taskId, executionId: active.executionId,
        expectedRevision: active.revision, idempotencyKey: "stranded-cancel-12345", reason: "stop", requester: "parent" });
      fx.store.transition("scope", active.taskId, cancelled.revision, phase, "current");
      t.mock.method(Date, "now", () => Date.parse(active.executionDeadlineAt!) + 1);
      resumed = fx.restart();
      await resumed.start();
      assert.equal(fx.backend.aborted, true);
      assert.equal(fx.store.get("scope", active.taskId)?.phase, "cancelling");
      assert.ok(fx.store.get("scope", active.taskId)?.cancellationIntent?.abortAcknowledged);
      assert.equal(fx.store.reserve("other-stranded", [`workspace:${active.workspace}`]), false);
      assert.equal(fx.backend.submitCount, 1);
    } finally { await resumed?.close(); await fx.coordinator.close(); fx.restore(); }
  });
}

test("a fresh managed abort acknowledgement and independent exact-turn stop snapshot release ownership", async () => {
  const fx = setup(undefined, undefined, true);
  try {
    await fx.coordinator.start();
    const active = fx.store.get("scope", fx.task.taskId)!;
    fx.store.cancelTask({ scopeId: "scope", taskId: active.taskId, executionId: active.executionId,
      expectedRevision: active.revision, idempotencyKey: "managed-stop-123456", reason: "stop", requester: "parent" });
    fx.coordinator.kick();
    for (let i = 0; i < 50 && !fx.store.get("scope", fx.task.taskId)?.cancellationIntent?.abortAcknowledged; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "cancelling");
    const inspectionsBeforeStop = fx.backend.inspectionCount;
    fx.backend.stopped = true;
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "cancelled"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "cancelled");
    assert.ok(fx.backend.inspectionCount >= inspectionsBeforeStop + 2);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("restart obtains a fresh abort acknowledgement before confirming stop", async () => {
  const fx = setup(undefined, undefined, true);
  let resumed: ExecutionCoordinator | null = null;
  try {
    await fx.coordinator.start();
    const active = fx.store.get("scope", fx.task.taskId)!;
    fx.store.cancelTask({ scopeId: "scope", taskId: active.taskId, executionId: active.executionId,
      expectedRevision: active.revision, idempotencyKey: "restart-stop-123456", reason: "stop", requester: "parent" });
    fx.coordinator.kick();
    for (let i = 0; i < 50 && !fx.store.get("scope", fx.task.taskId)?.cancellationIntent?.abortAcknowledged; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "cancelling");
    await fx.coordinator.close();
    fx.backend.stopped = true;
    resumed = fx.restart();
    await resumed.start();
    await until(() => fx.store.get("scope", fx.task.taskId)?.phase === "cancelled");
    assert.equal(fx.backend.abortCount, 2);
    assert.equal(fx.backend.submitCount, 1);
    assert.equal(fx.store.ownsResource(active.executionId, `workspace:${active.workspace}`), false);
  } finally { await resumed?.close(); await fx.coordinator.close(); fx.restore(); }
});

test("a replacement backend lease obtains fresh abort proof without replaying the turn", async () => {
  const fx = setup(undefined, undefined, true);
  try {
    await fx.coordinator.start();
    cancelFixture(fx);
    fx.coordinator.kick();
    await until(() => fx.backend.abortCount === 1);
    fx.lifecycle.alive = false;
    fx.backend.stopped = true;
    fx.coordinator.kick();
    await until(() => fx.store.get("scope", fx.task.taskId)?.phase === "cancelled");
    assert.equal(fx.lifecycle.opens, 2);
    assert.equal(fx.backend.abortCount, 2);
    assert.equal(fx.backend.submitCount, 1);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("normal completion in the independent stop-proof snapshot retains its outcome", async () => {
  const fx = setup(undefined, undefined, true);
  try {
    await fx.coordinator.start();
    const inspect = fx.backend.inspectTurn.bind(fx.backend);
    let snapshots = 0;
    fx.backend.inspectTurn = async (sessionId, messageId) => {
      if (++snapshots === 3) { fx.backend.finished = true; fx.backend.stopped = true; }
      return inspect(sessionId, messageId);
    };
    cancelFixture(fx);
    fx.coordinator.kick();
    await until(() => fx.store.get("scope", fx.task.taskId)?.phase === "completed");
    assert.equal(fx.lifecycle.terminations, 0);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("a correlated abort error after deadline acknowledgement resolves as timed out", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    const active = fx.store.get("scope", fx.task.taskId)!;
    fx.store.cancelTask({ scopeId: "scope", taskId: active.taskId, executionId: active.executionId,
      expectedRevision: active.revision, idempotencyKey: "deadline-abort-123456", reason: "execution deadline",
      requester: "supervisor", deadlineOrigin: new Date().toISOString() });
    fx.coordinator.kick();
    for (let i = 0; i < 50 && !fx.store.get("scope", fx.task.taskId)?.cancellationIntent?.abortAcknowledged; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "cancelling");
    fx.backend.error = JSON.stringify({ name: "MessageAbortedError", data: { message: "Aborted" } });
    fx.backend.finished = true;
    fx.backend.stopped = true;
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "timed_out"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "timed_out");
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("lost prompt acknowledgement reconciles the exact recorded message without resubmission", async () => {
  const fx = setup();
  fx.backend.submitAckLost = true;
  try {
    await fx.coordinator.start();
    const uncertain = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(uncertain.phase, "dispatching");
    assert.equal(uncertain.observation, "unknown");
    assert.equal(fx.backend.submitCount, 1);
    assert.equal(fx.store.dispatchIntent(uncertain.executionId)?.messageId, fx.backend.messageId);
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "running");
    assert.equal(fx.backend.submitCount, 1);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("lost session creation acknowledgement uses the exact marker before dispatch", async () => {
  const fx = setup();
  fx.backend.createAckLost = true;
  try {
    await fx.coordinator.start();
    const uncertain = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(uncertain.phase, "dispatching");
    assert.equal(uncertain.observation, "unknown");
    assert.ok(uncertain.creationIntent?.marker.includes(uncertain.executionId));
    assert.equal(fx.backend.submitCount, 0);
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.sessionId, fx.backend.sessionId);
    assert.equal(fx.backend.submitCount, 1);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("cancellation before any session or prompt finalizes without upstream submission", async () => {
  const fx = setup();
  try {
    const admitted = fx.store.admit("scope", fx.task.taskId, fx.task.revision,
      [`workspace:${fx.task.workspace}`])!;
    fx.store.cancelTask({ scopeId: "scope", taskId: admitted.taskId, executionId: admitted.executionId,
      expectedRevision: admitted.revision, idempotencyKey: "cancel-before-123456", reason: "stop", requester: "parent" });
    await fx.coordinator.start();
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "cancelled"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "cancelled");
    assert.equal(fx.backend.submitCount, 0);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("an admitted dispatching task times out before session creation", async () => {
  const fx = setup(1);
  try {
    const admitted = fx.store.admit("scope", fx.task.taskId, fx.task.revision,
      [`workspace:${fx.task.workspace}`]);
    assert.equal(admitted?.phase, "dispatching");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await fx.coordinator.start();
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "timed_out"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "timed_out");
    assert.equal(fx.backend.created, false);
    assert.equal(fx.backend.submitCount, 0);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("file report and readable summary are frozen as valid evidence before acceptance", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    const active = fx.store.get("scope", fx.task.taskId)!;
    assert.ok(active.reportPath);
    writeFileSync(join(active.reportPath!, "result.json"), JSON.stringify({ schema_version: 2,
      task_id: active.taskId, execution_id: active.executionId, outcome: "completed", summary: "Inspected the input.",
      coverage: ["input.txt"], gaps: [], findings: [], changes: [], checks: [], blockers: [], next_action: "Review" }));
    writeFileSync(join(active.reportPath!, "summary.md"), "Inspected input.txt.\n");
    fx.backend.finished = true;
    fx.backend.stopped = true;
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "completed"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const done = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(done.reportValidity, "valid");
    assert.ok(done.finalManifestHash);
    assert.ok(fx.store.artifactsForExecution(done.executionId).length >= 3);
    assert.equal(done.reviewStatus, "pending");
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("capture failure expires the configured finalization deadline with invalid evidence", async () => {
  const fx = setup(undefined, 1);
  try {
    await fx.coordinator.start();
    fx.store.registerArtifact = () => { throw new Error("simulated artifact disk failure"); };
    fx.backend.finished = true;
    fx.backend.stopped = true;
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.observation !== "unknown"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(pending.phase, "finalizing");
    assert.equal(pending.observation, "unknown");
    assert.ok(pending.finalizationDeadlineAt);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "completed"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const done = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(done.phase, "completed");
    assert.equal(done.reportValidity, "invalid");
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("a normal completion racing with cancellation retains the completed outcome", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    const active = fx.store.get("scope", fx.task.taskId)!;
    fx.store.cancelTask({ scopeId: "scope", taskId: active.taskId, executionId: active.executionId,
      expectedRevision: active.revision, idempotencyKey: "cancel-race-1234567", reason: "stop", requester: "parent" });
    fx.backend.finished = true;
    fx.backend.stopped = true;
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "completed"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "completed");
    assert.equal(fx.backend.aborted, false);
    assert.ok(fx.store.events(active.executionId).some((event) => event.kind === "finalizing" &&
      (event.detail as { detail?: { cancelEffect?: string } }).detail?.cancelEffect === "not_applied"));
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("stale queued input fails before session creation or inference", async () => {
  const fx = setup();
  try {
    writeFileSync(join(fx.task.workspace, "input.txt"), "changed\n");
    await fx.coordinator.start();
    assert.equal(fx.store.get("scope", fx.task.taskId)?.phase, "failed");
    assert.equal(fx.backend.created, false);
    assert.equal(fx.backend.submitCount, 0);
    assert.ok(fx.store.events(fx.task.executionId).some((event) =>
      (event.detail as { code?: string }).code === "STALE_INPUT"));
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("a pending permission is recovered by snapshot after a lost event stream", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    fx.backend.requests = [{ id: "per_1", sessionId: fx.backend.sessionId, type: "permission",
      api: "legacy", detail: { permission: "bash", patterns: ["pwd"] } }];
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "waiting_input"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const blocked = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(blocked.phase, "waiting_input");
    assert.equal(blocked.pendingRequests[0]?.requestId, "per_1");
    fx.backend.requests = [];
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.get("scope", fx.task.taskId)?.pendingRequests.length, 0);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("a durable reply intent left before network send is observed without resubmission", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    fx.backend.requests = [{ id: "per_crash", sessionId: fx.backend.sessionId, type: "permission",
      api: "legacy", detail: { permission: "bash", patterns: ["pwd"] } }];
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "waiting_input"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = fx.store.get("scope", fx.task.taskId)!;
    const request = pending.pendingRequests[0]!;
    fx.store.respondToRequest({ scopeId: "scope", taskId: pending.taskId, executionId: pending.executionId,
      expectedRevision: pending.revision, idempotencyKey: "reply-crash-window-123", requestId: request.requestId,
      requestRevision: request.revision, reply: "allow_once", authorizationBasis: "task authorization" });
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.observation !== "unknown"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const uncertain = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(uncertain.phase, "waiting_input");
    assert.equal(uncertain.observation, "unknown");
    assert.equal(uncertain.pendingRequests[0]?.status, "responding");
    assert.equal(fx.backend.replyCount, 0);
    const service = new SupervisorService(fx.store, fx.artifacts, fx.coordinator);
    const repeated = await service.handle("respond_to_request", { scope_id: "scope", task_id: pending.taskId,
      execution_id: pending.executionId, request_id: request.requestId, request_revision: request.revision,
      reply: "allow_once", authorization_basis: "task authorization", idempotency_key: "reply-crash-window-123" }) as { observation: string };
    assert.equal(repeated.observation, "unknown");
    assert.equal(fx.backend.replyCount, 0);
    fx.backend.requests = [];
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.inputRequests(pending.executionId)[0]?.status !== "unconfirmed"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.inputRequests(pending.executionId)[0]?.status, "unconfirmed");
    assert.equal(fx.backend.replyCount, 0);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("a lost reply acknowledgement never resends the same intent", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    fx.backend.requests = [{ id: "per_lost", sessionId: fx.backend.sessionId, type: "permission",
      api: "legacy", detail: { permission: "bash", patterns: ["pwd"] } }];
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "waiting_input"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = fx.store.get("scope", fx.task.taskId)!;
    const request = pending.pendingRequests[0]!;
    fx.backend.replyFailure = "pending";
    const service = new SupervisorService(fx.store, fx.artifacts, fx.coordinator);
    const input = { scope_id: "scope", task_id: pending.taskId, execution_id: pending.executionId,
      request_id: request.requestId, request_revision: request.revision, reply: "allow_once",
      authorization_basis: "task authorization", idempotency_key: "reply-ack-lost-12345" };
    const result = await service.handle("respond_to_request", input) as { observation: string };
    assert.equal(result.observation, "unknown");
    assert.equal(fx.backend.replyCount, 1);
    assert.equal(fx.store.inputRequests(pending.executionId)[0]?.status, "responding");
    await service.handle("respond_to_request", input);
    assert.equal(fx.backend.replyCount, 1);
    fx.backend.requests = [];
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.inputRequests(pending.executionId)[0]?.status !== "unconfirmed"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fx.store.inputRequests(pending.executionId)[0]?.status, "unconfirmed");
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("a lost acknowledgement after the request disappears is recorded as unconfirmed", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    fx.backend.requests = [{ id: "per_absent", sessionId: fx.backend.sessionId, type: "permission",
      api: "legacy", detail: { permission: "bash", patterns: ["pwd"] } }];
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.phase !== "waiting_input"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = fx.store.get("scope", fx.task.taskId)!;
    const request = pending.pendingRequests[0]!;
    fx.backend.replyFailure = "gone";
    const service = new SupervisorService(fx.store, fx.artifacts, fx.coordinator);
    const input = { scope_id: "scope", task_id: pending.taskId, execution_id: pending.executionId,
      request_id: request.requestId, request_revision: request.revision, reply: "allow_once",
      authorization_basis: "task authorization", idempotency_key: "reply-gone-ack-12345" };
    await service.handle("respond_to_request", input);
    assert.equal(fx.store.inputRequests(pending.executionId)[0]?.status, "unconfirmed");
    await service.handle("respond_to_request", input);
    assert.equal(fx.backend.replyCount, 1);
    assert.ok(fx.store.events(pending.executionId).some((event) => event.kind === "input_response_unconfirmed"));
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("a wrong-session permission is rejected without exposing a replyable request", async () => {
  const fx = setup();
  try {
    await fx.coordinator.start();
    fx.backend.requests = [{ id: "per_wrong", sessionId: "ses_other", type: "permission",
      api: "legacy", detail: { permission: "bash" } }];
    fx.coordinator.kick();
    for (let i = 0; i < 50 && fx.store.get("scope", fx.task.taskId)?.observation !== "unknown"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const task = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(task.observation, "unknown");
    assert.equal(task.pendingRequests.length, 0);
  } finally { await fx.coordinator.close(); fx.restore(); }
});

test("storage failure before dispatch intent prevents any prompt submission", async () => {
  const fx = setup();
  try {
    fx.store.recordDispatchIntent = () => { throw new Error("simulated disk failure"); };
    await fx.coordinator.start();
    const task = fx.store.get("scope", fx.task.taskId)!;
    assert.equal(task.phase, "dispatching");
    assert.equal(task.observation, "unknown");
    assert.equal(fx.store.dispatchIntent(task.executionId), null);
    assert.equal(fx.backend.submitCount, 0);
    assert.equal(fx.store.reserve(`other_${randomUUID()}`, [`workspace:${task.workspace}`]), false);
  } finally { await fx.coordinator.close(); fx.restore(); }
});
