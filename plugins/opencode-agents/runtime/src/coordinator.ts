import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { executionPairAllowed, type OpenCodeBackend, type PendingRequest, type TurnObservation } from "./backend.js";
import { loadConfiguration, trustedDevelopmentWorkspace, type UserConfig } from "./config.js";
import { captureEvidence } from "./evidence.js";
import { startManagedServer } from "./managed-server.js";
import type { ManagedLaunchContract } from "./launch-config.js";
import { SqliteTaskStore, type StoredTask } from "./store.js";
import { ArtifactStore } from "./artifacts.js";
import { compareBaseline, type WorkspaceBaseline } from "./workspace.js";
import type { TaskPacket } from "./contracts.js";

type BackendLease = { backendId: string; backend: OpenCodeBackend;
  confirmAbortStopped?: (sessionId: string, messageId: string) => Promise<boolean>; close(): Promise<void> };
export type BackendOpener = (input: { backendId: string; workspace: string; config: UserConfig;
  launchContract: ManagedLaunchContract | null; onDiagnostic?: (bytes: Buffer) => void }) => Promise<BackendLease>;

const defaultOpener: BackendOpener = async ({ backendId, workspace, config, launchContract, onDiagnostic }) => {
  if (config.attached_backend) throw new Error("attached backend dispatch is not certified");
  if (!launchContract) throw new Error("frozen OpenCode launch configuration is missing");
  return startManagedServer({ binary: config.opencode_binary, workspace, backendId, launchContract,
    ...(config.development_execution ? { developmentExecution: config.development_execution } : {}),
    ...(onDiagnostic ? { onDiagnostic } : {}) });
};

function backendIdentity(task: StoredTask, config: UserConfig): string {
  return `backend_${createHash("sha256").update(JSON.stringify({ workspace: task.workspace,
    binary: config.opencode_binary, models: config.models, attachedBackend: config.attached_backend ?? null,
    developmentExecution: config.development_execution ?? null,
    effectiveConfigSha256: task.launchContract?.effectiveConfigSha256 ?? null })).digest("hex").slice(0, 32)}`;
}

function expired(value: string | null): boolean { return Boolean(value && Date.now() >= Date.parse(value)); }
function isCorrelatedAbort(error: string | null): boolean {
  if (!error) return false;
  try { return (JSON.parse(error) as { name?: unknown }).name === "MessageAbortedError"; }
  catch { return false; }
}
function resourceKeys(task: StoredTask): string[] {
  const keys = [`workspace:${task.workspace}`];
  const packet = task.packet as TaskPacket;
  for (const resource of packet.shared_resources ?? []) if (resource.access === "write") keys.push(`shared:${resource.key}`);
  return keys;
}

/** Single-writer reconciler. All upstream side effects follow committed intents. */
export class ExecutionCoordinator {
  private readonly backends = new Map<string, BackendLease>();
  private readonly streams = new Map<string, AbortController>();
  private readonly freshAbortAcks = new Map<string, { lease: BackendLease; sessionId: string; messageId: string }>();
  private timer: NodeJS.Timeout | null = null;
  private working = false;
  private again = false;
  private stopping = false;

  constructor(readonly store: SqliteTaskStore, readonly artifacts: ArtifactStore,
    readonly opener: BackendOpener = defaultOpener) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.run();
    this.timer = setInterval(() => this.kick(), 500);
  }

  kick(): void {
    if (this.stopping) return;
    if (this.working) { this.again = true; return; }
    void this.run();
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const stream of this.streams.values()) stream.abort();
    this.streams.clear();
    this.freshAbortAcks.clear();
    while (this.working) await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.allSettled([...this.backends.values()].map((lease) => lease.close()));
    this.backends.clear();
  }

  async replyToRequest(task: StoredTask, request: PendingRequest, reply: "allow_once" | "deny" | string[][]): Promise<void> {
    if (!task.sessionId || !task.userMessageId || request.sessionId !== task.sessionId) {
      throw new Error("input request is not bound to the recorded session");
    }
    try {
      const { backend } = await this.backendFor(task);
      await backend.replyToRequest(request, reply, { timeoutMs: 5_000 });
      this.store.acknowledgeInputResponse(task.executionId, request.id);
    } catch (error) {
      // A timeout, process death, or local write error can follow an upstream reply.
      // Observe the exact turn; never submit this intent a second time.
      try {
        const { backend } = await this.backendFor(task);
        const observed = await backend.inspectTurn(task.sessionId, task.userMessageId, { timeoutMs: 5_000 });
        this.updateRequests(task, observed);
        if (observed.pendingRequests.some((item) => item.id === request.id))
          this.markUnknown(task, `reply delivery is uncertain: ${String(error)}`);
        else this.store.resolveUnconfirmedInputResponse(task.executionId, request.id);
      } catch (inspectionError) {
        this.markUnknown(task, `reply and exact-request observation are uncertain: ${String(inspectionError)}`);
      }
    }
    this.kick();
  }

  private async run(): Promise<void> {
    this.working = true;
    try {
      do {
        this.again = false;
        for (const task of this.store.unresolved()) {
          if (this.stopping) break;
          try { await this.reconcile(task); }
          catch (error) { this.handleFailure(task, error); }
        }
      } while (this.again && !this.stopping);
    } finally { this.working = false; }
  }

  private async backendFor(task: StoredTask): Promise<BackendLease> {
    // The launch contract belongs to the execution, not the mutable user config.
    // Earlier in-flight rows without a frozen contract need operator recovery.
    const config = task.backendConfig;
    if (!config) throw new Error("recorded backend launch configuration is missing");
    if (!task.reportPath || task.launchContract?.reportPath !== task.reportPath)
      throw new Error("frozen execution report path differs from recorded launch policy");
    const id = backendIdentity(task, config);
    if (task.backendId && task.backendId !== id) throw new Error("recorded backend identity differs from frozen launch configuration");
    const cached = this.backends.get(id);
    if (cached) return cached;
    const lease = await this.opener({ backendId: id, workspace: task.workspace, config,
      launchContract: task.launchContract,
      ...(process.env.OPENCODE_AGENTS_CAPTURE_DIAGNOSTICS === "1"
        ? { onDiagnostic: (bytes: Buffer) => this.store.appendDiagnostic(task.executionId, bytes) } : {}) });
    const inspection = await lease.backend.inspectBackend({ timeoutMs: 5_000 });
    if (!executionPairAllowed(inspection, trustedDevelopmentWorkspace(config, task.workspace)) ||
      !inspection.capabilities.callerAssignedMessageId ||
      !inspection.capabilities.permissionRequests || !inspection.capabilities.sessionRecovery ||
      inspection.workspace !== task.workspace) {
      await lease.close();
      throw new Error("backend version, workspace, or required capabilities are not certified");
    }
    this.store.registerBackendInstance(id, task.workspace, inspection.configurationDigest, {
      version: inspection.version, openapiDigest: inspection.openapiDigest, workspace: inspection.workspace,
    });
    this.backends.set(id, lease);
    this.watchEvents(lease);
    return lease;
  }

  private watchEvents(lease: BackendLease): void {
    if (this.streams.has(lease.backendId)) return;
    const controller = new AbortController();
    this.streams.set(lease.backendId, controller);
    void (async () => {
      let delay = 1_000;
      while (!controller.signal.aborted && !this.stopping) {
        try {
          for await (const _event of lease.backend.subscribeEvents({ signal: controller.signal })) {
            if (controller.signal.aborted) break;
            this.kick();
          }
        } catch { /* snapshots are authoritative after an SSE gap */ }
        if (controller.signal.aborted || this.stopping) break;
        for (const task of this.store.unresolved()) {
          if (task.backendId !== lease.backendId || task.observation !== "current") continue;
          try { this.store.transition(task.scopeId, task.taskId, task.revision, task.phase, "reconciling",
            { reason: "event stream disconnected; authoritative snapshot required" }); }
          catch { /* another reconciliation may have changed this revision */ }
        }
        this.kick();
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 15_000);
      }
    })();
  }

  private async reconcile(snapshot: StoredTask): Promise<void> {
    let task = this.store.get(snapshot.scopeId, snapshot.taskId);
    if (!task || task.executionId !== snapshot.executionId) return;
    if (task.phase === "queued") {
      if (expired(task.queueDeadlineAt)) {
        this.store.transition(task.scopeId, task.taskId, task.revision, "timed_out", "current", { reason: "queue deadline" });
        return;
      }
      const config = loadConfiguration();
      const active = this.store.unresolved().filter((item) => item.admittedAt && item.phase !== "queued").length;
      if (active >= config.limits.concurrency) return;
      const fresh = task.frozenBaseline ? compareBaseline(task.frozenBaseline as WorkspaceBaseline) : { fresh: false, changed: ["missing baseline"] };
      if (!fresh.fresh) {
        this.store.transition(task.scopeId, task.taskId, task.revision, "failed", "current", { code: "STALE_INPUT", changed: fresh.changed });
        return;
      }
      task = this.store.admit(task.scopeId, task.taskId, task.revision, resourceKeys(task));
      if (!task) return;
    }
    if (["dispatching", "running", "waiting_input"].includes(task.phase) &&
      expired(task.executionDeadlineAt) && !task.cancellationIntent) {
      this.store.cancelTask({ scopeId: task.scopeId, taskId: task.taskId, executionId: task.executionId,
        expectedRevision: task.revision, idempotencyKey: `deadline-${task.executionId}`, reason: "execution deadline",
        requester: "supervisor", ...(task.executionDeadlineAt ? { deadlineOrigin: task.executionDeadlineAt } : {}) });
      return;
    }
    if (task.phase === "dispatching") { await this.dispatch(task); return; }
    if (task.phase === "running" || task.phase === "waiting_input") { await this.observe(task); return; }
    if (task.phase === "cancelling") { await this.reconcileCancellation(task); return; }
    if (task.phase === "finalizing") { await this.finalize(task); }
  }

  private async dispatch(input: StoredTask): Promise<void> {
    let task = input;
    const lease = await this.backendFor(task);
    if (task.contextMode === "resume" && !task.sessionId) throw new Error("recorded follow-up session is missing");
    if (task.contextMode === "resume" && !task.backendId) {
      if (!task.predecessorExecutionId) throw new Error("resume predecessor is missing");
      const predecessor = this.store.getExecution(task.scopeId, task.taskId, task.predecessorExecutionId);
      if (!predecessor || predecessor.sessionId !== task.sessionId || !predecessor.userMessageId)
        throw new Error("resume session lacks an exact predecessor turn");
      const observed = await lease.backend.inspectTurn(task.sessionId!, predecessor.userMessageId, { timeoutMs: 5_000 });
      if (!observed.submitted || !observed.finished)
        throw new Error("recorded resume session was not recovered in the scoped worker");
      task = this.store.bindSession(task.scopeId, task.taskId, task.revision, lease.backendId, task.sessionId!);
    }
    if (!task.sessionId) {
      if (task.creationIntent) {
        const found = await lease.backend.findCreatedSession(task.creationIntent.marker, { timeoutMs: 5_000 });
        if (!found || found.backendId !== lease.backendId || found.workspace !== task.workspace) {
          this.markUnknown(task, "session creation remains ambiguous");
          return;
        }
        task = this.store.bindSession(task.scopeId, task.taskId, task.revision, lease.backendId, found.id);
      } else {
        const marker = `opencode-agents:${task.executionId}`;
        task = this.store.recordCreationIntent(task.scopeId, task.taskId, task.revision, lease.backendId, marker);
        const found = await lease.backend.findCreatedSession(marker, { timeoutMs: 5_000 });
        const session = found ?? await lease.backend.createSession(marker, { timeoutMs: 10_000 });
        if (session.backendId !== lease.backendId || session.workspace !== task.workspace) throw new Error("session binding mismatch");
        task = this.store.bindSession(task.scopeId, task.taskId, task.revision, lease.backendId, session.id);
      }
    }
    const intent = this.store.dispatchIntent(task.executionId);
    if (intent) {
      const observed = await lease.backend.inspectTurn(intent.sessionId, intent.messageId, { timeoutMs: 5_000 });
      if (!observed.submitted) { this.markUnknown(task, "recorded prompt delivery is ambiguous"); return; }
      if (!intent.acknowledged) this.store.acknowledgeDispatch(task.executionId);
      this.store.transition(task.scopeId, task.taskId, task.revision, observed.pendingRequests.length ? "waiting_input" : "running", "current");
      return;
    }
    if (!task.sessionId) throw new Error("session not bound");
    if (!task.reportPath) throw new Error("frozen report path is missing");
    mkdirSync(task.reportPath, { recursive: true, mode: 0o700 });
    const sessionId = task.sessionId;
    const messageId = `msg_${randomUUID()}`;
    task = this.store.recordDispatchIntent(task.scopeId, task.taskId, task.revision, lease.backendId, sessionId, messageId);
    const slash = task.model.indexOf("/");
    const providerId = slash < 0 ? "" : task.model.slice(0, slash);
    const modelId = slash < 0 ? "" : task.model.slice(slash + 1);
    if (!providerId || !modelId) throw new Error("recorded model is invalid");
    await lease.backend.submitTurn({ sessionId, messageId, prompt: task.frozenPrompt,
      providerId, modelId, agent: task.profile }, { timeoutMs: 10_000 });
    this.store.acknowledgeDispatch(task.executionId);
    this.store.transition(task.scopeId, task.taskId, task.revision, "running", "current", { messageId });
  }

  private async observe(task: StoredTask): Promise<void> {
    if (!task.sessionId || !task.userMessageId) { this.markUnknown(task, "missing exact turn identity"); return; }
    const { backend } = await this.backendFor(task);
    const observed = await backend.inspectTurn(task.sessionId, task.userMessageId, { timeoutMs: 5_000 });
    this.updateRequests(task, observed);
    task = this.store.get(task.scopeId, task.taskId)!;
    if (observed.finished) {
      this.store.beginFinalization(task.scopeId, task.taskId, task.revision, observed.error ? "failed" : "completed",
        { error: observed.error });
      return;
    }
    const phase = observed.pendingRequests.length ? "waiting_input" : "running";
    const uncertainReply = task.pendingRequests.some((request) =>
      ["responding", "unconfirmed", "responded"].includes(request.status) &&
      observed.pendingRequests.some((pending) => pending.id === request.requestId));
    const observation = uncertainReply ? "unknown" : "current";
    if (task.phase !== phase || task.observation !== observation)
      this.store.transition(task.scopeId, task.taskId, task.revision, phase, observation,
        uncertainReply ? { reason: "recorded input response may or may not have reached upstream; operator action required" } : {});
  }

  private updateRequests(task: StoredTask, observed: TurnObservation): void {
    for (const request of observed.pendingRequests) {
      if (request.sessionId !== task.sessionId) throw new Error("upstream request belongs to another session");
      this.store.upsertInputRequest(task.scopeId, task.taskId,
        task.executionId, request.id, request.type, request);
    }
    this.store.expireMissingInputRequests(task.executionId, observed.pendingRequests.map((request) => request.id));
  }

  private async reconcileCancellation(task: StoredTask): Promise<void> {
    if (!task.userMessageId) {
      if (this.store.dispatchIntent(task.executionId)) { this.markUnknown(task, "cancellation lacks recorded message identity"); return; }
      if (!task.sessionId && task.creationIntent) {
        const { backend } = await this.backendFor(task);
        const found = await backend.findCreatedSession(task.creationIntent.marker, { timeoutMs: 5_000 });
        if (!found) { this.markUnknown(task, "session creation remains ambiguous during cancellation"); return; }
        if (found.backendId !== task.creationIntent.backendId || found.workspace !== task.workspace)
          throw new Error("recovered session binding mismatch during cancellation");
        task = this.store.bindSession(task.scopeId, task.taskId, task.revision, found.backendId, found.id);
      }
      // There is no durable dispatch intent, so this execution never submitted
      // a prompt. No worker turn exists to stop or keep ownership for.
      this.store.beginFinalization(task.scopeId, task.taskId, task.revision,
        task.cancellationIntent?.deadlineOrigin ? "timed_out" : "cancelled", { promptSubmitted: false });
      return;
    }
    if (!task.sessionId) { this.markUnknown(task, "cancellation lacks exact session identity"); return; }
    const lease = await this.backendFor(task);
    const { backend } = lease;
    const before = await backend.inspectTurn(task.sessionId, task.userMessageId, { timeoutMs: 5_000 });
    if (before.finished) {
      this.freshAbortAcks.delete(task.executionId);
      const abortApplied = Boolean(task.cancellationIntent?.abortAcknowledged && isCorrelatedAbort(before.error));
      this.store.beginFinalization(task.scopeId, task.taskId, task.revision,
        abortApplied ? task.cancellationIntent?.deadlineOrigin ? "timed_out" : "cancelled" : before.error ? "failed" : "completed",
        { cancelEffect: abortApplied ? "applied" : "not_applied" });
      return;
    }
    let acknowledged = Boolean(task.cancellationIntent?.abortAcknowledged);
    if (!acknowledged) {
      acknowledged = await backend.abortSession(task.sessionId, { timeoutMs: 5_000 });
      if (acknowledged) {
        this.store.acknowledgeAbort(task.executionId);
        this.freshAbortAcks.set(task.executionId, { lease, sessionId: task.sessionId, messageId: task.userMessageId });
      }
    }
    const after = await backend.inspectTurn(task.sessionId, task.userMessageId, { timeoutMs: 5_000 });
    if (after.finished) {
      this.freshAbortAcks.delete(task.executionId);
      const abortApplied = Boolean(acknowledged && isCorrelatedAbort(after.error));
      this.store.beginFinalization(task.scopeId, task.taskId, task.revision,
        abortApplied ? task.cancellationIntent?.deadlineOrigin ? "timed_out" : "cancelled" : after.error ? "failed" : "completed",
        { cancelEffect: abortApplied ? "applied" : "not_applied" });
    } else if (acknowledged && lease.confirmAbortStopped &&
      this.freshAbortAcks.get(task.executionId)?.lease === lease &&
      this.freshAbortAcks.get(task.executionId)?.sessionId === task.sessionId &&
      this.freshAbortAcks.get(task.executionId)?.messageId === task.userMessageId &&
      await lease.confirmAbortStopped(task.sessionId, task.userMessageId)) {
      this.freshAbortAcks.delete(task.executionId);
      this.store.beginFinalization(task.scopeId, task.taskId, task.revision,
        task.cancellationIntent?.deadlineOrigin ? "timed_out" : "cancelled", { cancelEffect: "applied" });
    } else this.markUnknown(task, "stop has not been confirmed");
  }

  private async finalize(task: StoredTask): Promise<void> {
    const outcome = task.intendedOutcome ?? "failed";
    try {
      if (!task.reportPath || !task.frozenBaseline) throw new Error("frozen report path or baseline missing");
      mkdirSync(task.reportPath, { recursive: true, mode: 0o700 });
      let structuredReport: unknown;
      if (task.sessionId && task.userMessageId) {
        try { structuredReport = (await (await this.backendFor(task)).backend.readResult(task.sessionId, task.userMessageId, { timeoutMs: 5_000 })).structured; }
        catch { /* file report remains available */ }
      }
      const evidence = captureEvidence({ taskId: task.taskId, executionId: task.executionId, workspace: task.workspace,
        outputDirectory: task.reportPath, packet: task.packet as TaskPacket,
        baseline: task.frozenBaseline as WorkspaceBaseline, store: this.store, artifacts: this.artifacts,
        structuredReport, ...(task.backendConfig ? { maxSnapshotBytes: task.backendConfig.limits.artifact_bytes } : {}) });
      this.store.finalize(task.scopeId, task.taskId, task.revision, outcome, evidence.reportValidity, evidence.finalManifestHash);
      this.store.release(task.executionId);
    } catch (error) {
      if (!expired(task.finalizationDeadlineAt)) { this.markUnknown(task, `evidence capture: ${String(error)}`); return; }
      this.store.finalize(task.scopeId, task.taskId, task.revision, outcome, "invalid", null);
      this.store.release(task.executionId);
    }
  }

  private markUnknown(task: StoredTask, reason: string): void {
    const current = this.store.get(task.scopeId, task.taskId);
    if (current && current.executionId === task.executionId && current.observation !== "unknown")
      this.store.transition(task.scopeId, task.taskId, current.revision, current.phase, "unknown", { reason });
  }

  private handleFailure(task: StoredTask, error: unknown): void {
    const current = this.store.get(task.scopeId, task.taskId);
    if (!current || current.executionId !== task.executionId) return;
    if (current.phase === "queued" || (current.phase === "dispatching" && !current.creationIntent && !this.store.dispatchIntent(current.executionId))) {
      this.store.transition(current.scopeId, current.taskId, current.revision, "failed", "current", { error: String(error) });
      this.store.release(current.executionId);
    } else this.markUnknown(current, String(error));
  }
}
