import { ProgressManager, ProgressReadSchema } from "./progress.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts.js";
import { ReviewSchema, TaskPacketSchema } from "./contracts.js";
import { loadConfiguration, stateDirectory, trustedDevelopmentWorkspace, type UserConfig } from "./config.js";
import { ExecutionCoordinator } from "./coordinator.js";
import { freezeManagedLaunch } from "./managed-server.js";
import { assertSelectedModelDestination, policyNeutralConfigHash, type SelectedModel, type ManagedLaunchContract } from "./launch-config.js";
import { doctor, doctorWithAttached } from "./doctor.js";
import { SqliteTaskStore, StoreConflict, type StoredTask } from "./store.js";
import { renderPrompt } from "./prompt.js";
import { captureBaseline, WorkspaceError } from "./workspace.js";

const Id = z.string().min(1);
const ScopeTask = z.object({ scope_id: Id, task_id: Id }).strict();
function compactTask(task: StoredTask) {
  const { packet: _packet, frozenPrompt: _prompt, frozenBaseline: _baseline,
    backendConfig: _backendConfig, launchContract: _launchContract, ...state } = task;
  return { ...state, terminal: ["completed", "failed", "cancelled", "timed_out"].includes(task.phase),
    operationally_resolved: ["completed", "failed", "cancelled", "timed_out"].includes(task.phase),
    usage: { input_tokens: null, output_tokens: null, cache_tokens: null,
      reported_cost: null, currency: null, source: "not_captured" } };
}

export class ToolkitError extends Error {
  constructor(readonly code: string, message: string, readonly retry: "safe_same_key" | "observe_first" | "change_input" | "operator_action" = "operator_action") {
    super(message);
  }
}

export class SupervisorService {
  readonly progress: ProgressManager;
  constructor(readonly store: SqliteTaskStore, readonly artifacts: ArtifactStore,
    readonly coordinator?: ExecutionCoordinator,
    readonly freezeLaunch: typeof freezeManagedLaunch = freezeManagedLaunch) {
    this.progress = coordinator?.progress ?? new ProgressManager();
  }

  private assertExecutionAdmission(config: UserConfig, workspace: string): void {
    const diagnostics = doctor();
    if (!this.coordinator || !diagnostics.runtime.supportedNode ||
      !(diagnostics.backend.executionTested || trustedDevelopmentWorkspace(config, workspace)))
      throw new ToolkitError("UNSUPPORTED_BACKEND",
        "backend is not certified; development execution requires an operator opt-in for this exact trusted workspace");
  }

  private async frozenLaunch(binary: string, workspace: string, reportPath: string, model: SelectedModel): Promise<ManagedLaunchContract> {
    try {
      const contract = await this.freezeLaunch(binary, workspace, reportPath);
      assertSelectedModelDestination(model, contract);
      return contract;
    } catch (error) {
      throw new ToolkitError("POLICY_MISMATCH", `OpenCode launch policy or provider route could not be frozen: ${String(error)}`);
    }
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "health": return this.health();
      case "get_task": return this.getTask(params);
      case "get_progress": return this.getProgress(params);
      case "list_tasks": return this.listTasks(params);
      case "wait_tasks": return this.waitTasks(params);
      case "read_artifact": return this.readArtifact(params);
      case "record_review": return this.recordReview(params);
      case "start_task": return this.startTask(params);
      case "continue_task": return this.continueTask(params);
      case "cancel_task": return this.cancelTask(params);
      case "respond_to_request": return this.respondToRequest(params);
      default: throw new ToolkitError("INVALID_INPUT", `unknown operation ${method}`, "change_input");
    }
  }

  private async health() {
    const unresolved = this.store.unresolved();
    return {
      ...await doctorWithAttached(),
      supervisor: { state: "running", queued: unresolved.filter((task) => task.phase === "queued").length,
        unresolved: unresolved.length },
    };
  }

  private getTask(params: unknown) {
    const input = ScopeTask.extend({ execution_id: Id.optional(), after_cursor: z.number().int().min(0).default(0),
      event_detail_cursor: z.string().min(1).max(512).optional(),
      diagnostic_cursor: z.string().min(1).max(512).optional() }).parse(params);
    if (input.event_detail_cursor && input.diagnostic_cursor)
      throw new ToolkitError("INVALID_INPUT", "choose one detail cursor", "change_input");
    const task = input.execution_id
      ? this.store.getExecution(input.scope_id, input.task_id, input.execution_id)
      : this.store.get(input.scope_id, input.task_id);
    if (!task) throw new ToolkitError("INVALID_INPUT", "task not found", "change_input");
    const page = this.store.eventPage(task.executionId, input.after_cursor);
    const snapshot = { ...compactTask(task), ...this.progress.hint(task.executionId),
      events: page.events, artifacts: this.store.artifactsForExecution(task.executionId).map(({ artifactId, sha256, byteLength, mediaType }) =>
        ({ artifact_id: artifactId, sha256, byte_length: byteLength, media_type: mediaType })),
      cursor: page.cursor, has_more_events: page.hasMore };
    if (input.event_detail_cursor) return { ...snapshot,
      event_detail: this.store.eventDetailChunk(task.executionId, input.event_detail_cursor) };
    if (input.diagnostic_cursor) return { ...snapshot,
      diagnostic: this.store.diagnosticChunk(task.executionId, input.diagnostic_cursor) };
    return snapshot;
  }

  private getProgress(params: unknown) {
    const input = ProgressReadSchema.parse(params);
    const task = this.store.getExecution(input.scope_id, input.task_id, input.execution_id);
    if (!task) throw new ToolkitError("INVALID_INPUT", "execution not found", "change_input");
    try {
      const { scope_id: _scope, task_id: _task, execution_id: _execution, ...options } = input;
      return this.progress.read(task.executionId, options, {
        phase: task.phase, observation: task.observation,
        ...(this.coordinator?.progressRuntime(task.executionId) ?? { observed_at: null, backend_reachable: null }),
      }, { scope_id: input.scope_id, task_id: input.task_id, execution_id: task.executionId });
    } catch (error) { throw new ToolkitError("INVALID_INPUT", String(error), "change_input"); }
  }

  private listTasks(params: unknown) {
    const input = z.object({ scope_id: Id, limit: z.number().int().min(1).max(100).default(20), states: z.array(Id).optional(), page_cursor: Id.optional() }).strict().parse(params);
    const page = this.store.listPage(input.scope_id, { limit: input.limit,
      ...(input.states ? { states: input.states as StoredTask["phase"][] } : {}),
      ...(input.page_cursor ? { cursor: input.page_cursor } : {}) });
    return { tasks: page.tasks.map(compactTask), next_cursor: page.nextCursor };
  }

  private async waitTasks(params: unknown) {
    const input = z.object({ scope_id: Id, targets: z.array(z.object({ task_id: Id, after_cursor: z.number().int().min(0).default(0), execution_id: Id.optional(), after_progress_cursor: Id.max(512).optional() }).strict()).min(1).max(16),
      timeout_ms: z.number().int().min(0).max(30_000).default(20_000) }).strict().parse(params);
    const deadline = Date.now() + input.timeout_ms;
    while (true) {
      const changed = input.targets.flatMap((target) => {
        const task = this.store.get(input.scope_id, target.task_id);
        if (!task) throw new ToolkitError("INVALID_INPUT", `task not found: ${target.task_id}`, "change_input");
        if (target.execution_id && target.execution_id !== task.executionId) throw new ToolkitError("INVALID_INPUT", "wait execution is no longer current", "change_input");
        const page = this.store.eventPage(task.executionId, target.after_cursor);
        let progressChanged = false;
        if (target.after_progress_cursor) {
          if (!target.execution_id) throw new ToolkitError("INVALID_INPUT", "execution_id required with progress cursor", "change_input");
          try {
            const delta = this.progress.read(task.executionId, { after_cursor: target.after_progress_cursor }) as { updates: unknown[]; gap: unknown };
            progressChanged = delta.updates.length > 0 || delta.gap !== null;
          } catch (error) { throw new ToolkitError("INVALID_INPUT", String(error), "change_input"); }
        }
        return page.events.length || progressChanged ? [{ task: compactTask(task), ...(progressChanged ? this.progress.hint(task.executionId) : {}), events: page.events,
          cursor: page.cursor, has_more_events: page.hasMore }] : [];
      });
      if (changed.length) return { timed_out: false, changed: changed.slice(0, 1),
        more_targets_ready: changed.length > 1 };
      if (Date.now() >= deadline) return { timed_out: true, changed: [] };
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }

  private readArtifact(params: unknown) {
    const input = ScopeTask.extend({ execution_id: Id, artifact_id: Id,
      byte_offset: z.number().int().min(0).default(0), max_bytes: z.number().int().min(1).max(65_536).default(16_384) }).parse(params);
    const task = this.store.getExecution(input.scope_id, input.task_id, input.execution_id);
    if (!task) throw new ToolkitError("INVALID_INPUT", "execution not found", "change_input");
    const entry = this.store.artifact(input.execution_id, input.artifact_id);
    if (!entry) throw new ToolkitError("INVALID_INPUT", "artifact not found", "change_input");
    const range = this.artifacts.read(entry, input.byte_offset, input.max_bytes);
    return { artifact_id: entry.artifactId, sha256: entry.sha256, byte_length: entry.byteLength,
      media_type: entry.mediaType, byte_offset: input.byte_offset, next_offset: range.nextOffset,
      content: entry.mediaType.startsWith("text/") || entry.mediaType === "application/json"
        ? Buffer.from(range.bytes).toString("utf8") : null,
      content_base64: Buffer.from(range.bytes).toString("base64") };
  }

  private recordReview(params: unknown) {
    const input = ScopeTask.extend({ execution_id: Id, expected_revision: z.number().int().positive(), idempotency_key: z.string().min(16).max(128), review: ReviewSchema }).parse(params);
    const task = this.store.getExecution(input.scope_id, input.task_id, input.execution_id);
    if (!task) throw new ToolkitError("INVALID_INPUT", "execution not found", "change_input");
    if (!["bounded-build", "bounded-inspect"].includes(task.profile)) throw new StoreConflict("INVALID_STATE");
    if (input.review.disposition === "accepted") {
      for (const entry of this.store.artifactsForExecution(task.executionId)) {
        try { this.artifacts.read(entry, 0, 1); }
        catch { throw new ToolkitError("ARTIFACT_CHANGED", `artifact is missing or changed: ${entry.artifactId}`, "observe_first"); }
      }
    }
    return compactTask(this.store.recordReview(input.scope_id, input.task_id, input.expected_revision,
      input.idempotency_key, input.review, input.execution_id));
  }

  private async startTask(params: unknown) {
    const input = z.object({ scope_id: Id, idempotency_key: z.string().min(16).max(128).optional(),
      workspace: z.object({ path: Id, access: z.enum(["exclusive", "shared_read"]).default("exclusive") }).strict(),
      model: z.union([z.object({ provider_id: Id, model_id: Id }).strict(), z.object({ profile: Id }).strict()]),
      profile: z.enum(["bounded-build", "bounded-inspect"]),
      limits: z.object({ queue_timeout_seconds: z.number().int().positive(), execution_timeout_seconds: z.number().int().positive() }).strict(),
      packet: TaskPacketSchema, dry_run: z.boolean().default(false),
    }).strict().parse(params);
    const packetBytes = Buffer.byteLength(JSON.stringify(input.packet), "utf8");
    if (packetBytes > 128 * 1024) throw new ToolkitError("INVALID_INPUT", "packet exceeds 128 KiB", "change_input");
    if (!input.dry_run && input.idempotency_key) {
      const existing = this.store.findStartByKey(input.scope_id, input.idempotency_key, {
        workspace: input.workspace.path, requestWorkspace: input.workspace.path,
        workspaceAccess: input.workspace.access, packet: input.packet,
        requestModel: input.model, model: "", profile: input.profile,
        queueTimeoutSeconds: input.limits.queue_timeout_seconds,
        executionTimeoutSeconds: input.limits.execution_timeout_seconds,
      });
      if (existing) return compactTask(existing);
    }
    const config = loadConfiguration();
    if (input.limits.queue_timeout_seconds > config.limits.queue_timeout_seconds ||
      input.limits.execution_timeout_seconds > config.limits.execution_timeout_seconds) {
      throw new ToolkitError("INVALID_INPUT", "task limits exceed configured maxima", "change_input");
    }
    const requestedModel = input.model;
    const configuredModel = "profile" in requestedModel ? config.models[requestedModel.profile] :
      Object.values(config.models).find((candidate) => candidate.provider_id === requestedModel.provider_id && candidate.model_id === requestedModel.model_id);
    if (!configuredModel) throw new ToolkitError("INVALID_INPUT", "model is not configured", "change_input");
    if (input.workspace.access === "shared_read" && input.profile !== "bounded-inspect") {
      throw new ToolkitError("INVALID_INPUT", "shared_read requires the bounded-inspect profile", "change_input");
    }
    let baseline;
    try { baseline = captureBaseline({ workspace: input.workspace.path, projectRoots: config.project_roots,
      readRoots: config.read_roots, packet: input.packet }); }
    catch (error) {
      if (error instanceof WorkspaceError) throw new ToolkitError(error.code, error.message, "change_input");
      throw error;
    }
    if (input.dry_run) return { dry_run: true, accepted: false,
      checks: { packet: "valid", configuration: "valid", workspace: "valid", model: "configured", backend: "unchecked", policy: "unchecked" },
      packet_bytes: packetBytes, workspace: baseline.workspace, starting_state_sha256: baseline.sha256,
      coverage_limits: baseline.coverageLimits };
    if (!input.idempotency_key) throw new ToolkitError("INVALID_INPUT", "idempotency_key is required", "change_input");
    if (config.attached_backend) throw new ToolkitError("UNSUPPORTED_BACKEND", "attached backend dispatch is not certified");
    this.assertExecutionAdmission(config, baseline.workspace);
    const taskId = `task_${randomUUID()}`;
    const executionId = `exec_${randomUUID()}`;
    const reportPath = join(stateDirectory(), "reports", executionId);
    const launchContract = await this.frozenLaunch(config.opencode_binary, baseline.workspace, reportPath, configuredModel);
    const frozen = renderPrompt({ taskId, executionId, profile: input.profile, packet: input.packet,
      baseline, outputDirectory: reportPath });
    const task = this.store.start({ taskId, executionId, scopeId: input.scope_id,
      idempotencyKey: input.idempotency_key, workspace: baseline.workspace,
      requestWorkspace: input.workspace.path, packet: input.packet,
      model: `${configuredModel.provider_id}/${configuredModel.model_id}`, profile: input.profile,
      requestModel: input.model, workspaceAccess: input.workspace.access, backendConfig: config,
      launchContract,
      baselineHash: baseline.sha256, promptHash: frozen.sha256, frozenPrompt: frozen.text,
      frozenBaseline: baseline, reportPath, queueTimeoutSeconds: input.limits.queue_timeout_seconds,
      executionTimeoutSeconds: input.limits.execution_timeout_seconds });
    this.coordinator!.kick();
    return compactTask(task);
  }

  private async continueTask(params: unknown) {
    const input = ScopeTask.extend({ predecessor_execution_id: Id, expected_revision: z.number().int().positive(),
      idempotency_key: z.string().min(16).max(128), context_mode: z.enum(["resume", "fresh"]), packet: TaskPacketSchema }).parse(params);
    if (!this.coordinator) throw new ToolkitError("UNSUPPORTED_BACKEND", "execution coordinator is unavailable");
    const repeated = this.store.findContinueByKey(input.scope_id, input.idempotency_key, {
      taskId: input.task_id, predecessorExecutionId: input.predecessor_execution_id,
      packet: input.packet, contextMode: input.context_mode,
    });
    if (repeated) return compactTask(repeated);
    const predecessor = this.store.getExecution(input.scope_id, input.task_id, input.predecessor_execution_id);
    const current = this.store.get(input.scope_id, input.task_id);
    if (!predecessor || !current || current.executionId !== predecessor.executionId)
      throw new ToolkitError("INVALID_INPUT", "predecessor execution is not current", "change_input");
    if (!["bounded-build", "bounded-inspect"].includes(predecessor.profile)) throw new StoreConflict("INVALID_STATE");
    if (predecessor.revision !== input.expected_revision) throw new StoreConflict("STALE_REVISION");
    if (!["completed", "failed", "cancelled", "timed_out"].includes(predecessor.phase) || predecessor.pendingRequests.length)
      throw new StoreConflict("INVALID_STATE");
    const priorPacket = predecessor.packet as z.infer<typeof TaskPacketSchema>;
    if (input.packet.objective !== priorPacket.objective)
      throw new ToolkitError("INVALID_INPUT", "follow-up cannot change the task objective", "change_input");
    const config = loadConfiguration();
    if (config.attached_backend) throw new ToolkitError("UNSUPPORTED_BACKEND",
      "attached backend is available for read-only diagnostics only");
    this.assertExecutionAdmission(config, current.workspace);
    const freshModel = Object.values(config.models).find((candidate) =>
      `${candidate.provider_id}/${candidate.model_id}` === predecessor.model);
    if (!freshModel) {
      throw new ToolkitError("INVALID_INPUT", "recorded model is not configured for a follow-up", "change_input");
    }
    const baseline = captureBaseline({ workspace: current.workspace, projectRoots: config.project_roots,
      readRoots: config.read_roots, packet: input.packet });
    const executionId = `exec_${randomUUID()}`;
    const reportPath = join(stateDirectory(), "reports", executionId);
    if (!predecessor.launchContract) throw new ToolkitError("UNSUPPORTED_BACKEND", "predecessor launch configuration is missing");
    if (predecessor.backendConfig?.opencode_binary !== config.opencode_binary)
      throw new ToolkitError("POLICY_MISMATCH", "follow-up changes the recorded OpenCode binary", "change_input");
    const launchContract = await this.frozenLaunch(config.opencode_binary, current.workspace, reportPath, freshModel);
    if (policyNeutralConfigHash(launchContract) !== policyNeutralConfigHash(predecessor.launchContract))
      throw new ToolkitError("POLICY_MISMATCH", "follow-up changes the recorded backend configuration", "change_input");
    const frozen = renderPrompt({ taskId: current.taskId, executionId, profile: current.profile as "bounded-build" | "bounded-inspect",
      packet: input.packet, baseline, outputDirectory: reportPath });
    const task = this.store.continueTask({ scopeId: input.scope_id, taskId: input.task_id,
      predecessorExecutionId: input.predecessor_execution_id, expectedRevision: input.expected_revision,
      idempotencyKey: input.idempotency_key, executionId, packet: input.packet, contextMode: input.context_mode,
      baselineHash: baseline.sha256, promptHash: frozen.sha256, frozenPrompt: frozen.text,
      frozenBaseline: baseline, backendConfig: config, reportPath, queueTimeoutSeconds: config.limits.queue_timeout_seconds,
      launchContract,
      executionTimeoutSeconds: config.limits.execution_timeout_seconds });
    this.coordinator.kick();
    return compactTask(task);
  }

  private cancelTask(params: unknown) {
    const input = ScopeTask.extend({ execution_id: Id, reason: Id, expected_revision: z.number().int().positive(),
      idempotency_key: z.string().min(16).max(128) }).parse(params);
    const candidate = this.store.getExecution(input.scope_id, input.task_id, input.execution_id);
    if (candidate && !["bounded-build", "bounded-inspect"].includes(candidate.profile)) throw new StoreConflict("INVALID_STATE");
    const repeated = this.store.findCancelByKey(input.scope_id, input.idempotency_key, {
      taskId: input.task_id, executionId: input.execution_id, reason: input.reason, requester: "parent",
    });
    if (repeated) return compactTask(repeated);
    const task = this.store.cancelTask({ scopeId: input.scope_id, taskId: input.task_id,
      executionId: input.execution_id, expectedRevision: input.expected_revision,
      idempotencyKey: input.idempotency_key, reason: input.reason, requester: "parent" });
    this.coordinator?.kick();
    return compactTask(task);
  }

  private async respondToRequest(params: unknown) {
    const input = ScopeTask.extend({ execution_id: Id, request_id: Id, request_revision: z.number().int().positive(),
      reply: z.union([z.enum(["allow_once", "deny"]), z.array(z.array(Id))]), authorization_basis: Id,
      idempotency_key: z.string().min(16).max(128) }).parse(params);
    if (!this.coordinator) throw new ToolkitError("UNSUPPORTED_BACKEND", "execution coordinator is unavailable");
    const candidate = this.store.getExecution(input.scope_id, input.task_id, input.execution_id);
    if (candidate && !["bounded-build", "bounded-inspect"].includes(candidate.profile)) throw new StoreConflict("INVALID_STATE");
    const repeated = this.store.findResponseByKey(input.scope_id, input.idempotency_key, {
      taskId: input.task_id, executionId: input.execution_id, requestId: input.request_id,
      requestRevision: input.request_revision, reply: input.reply, authorizationBasis: input.authorization_basis,
    });
    if (repeated) { this.coordinator.kick(); return compactTask(repeated); }
    const task = this.store.getExecution(input.scope_id, input.task_id, input.execution_id);
    if (!task) throw new ToolkitError("INVALID_INPUT", "execution not found", "change_input");
    const request = task.pendingRequests.find((item) => item.requestId === input.request_id);
    if (!request) throw new ToolkitError("REQUEST_EXPIRED", "request is no longer pending", "observe_first");
    const upstreamRequest = request.detail as { sessionId?: unknown; type?: unknown };
    if (upstreamRequest.sessionId !== task.sessionId || upstreamRequest.type !== request.kind)
      throw new ToolkitError("REQUEST_EXPIRED", "request binding does not match the execution", "observe_first");
    if ((request.kind === "permission" && Array.isArray(input.reply)) ||
      (request.kind === "question" && input.reply === "allow_once"))
      throw new ToolkitError("INVALID_INPUT", "reply does not match request type", "change_input");
    const updated = this.store.respondToRequest({ scopeId: input.scope_id, taskId: input.task_id,
      executionId: input.execution_id, expectedRevision: task.revision,
      idempotencyKey: input.idempotency_key, requestId: input.request_id,
      requestRevision: input.request_revision, reply: input.reply, authorizationBasis: input.authorization_basis });
    await this.coordinator.replyToRequest(updated, request.detail as Parameters<ExecutionCoordinator["replyToRequest"]>[1], input.reply);
    return compactTask(this.store.get(input.scope_id, input.task_id)!);
  }

}
