import { z } from "zod";
import { ArtifactStore } from "./artifacts.js";
import { ReviewSchema, TaskPacketSchema } from "./contracts.js";
import { loadConfiguration } from "./config.js";
import { doctor } from "./doctor.js";
import { SqliteTaskStore, type StoredTask } from "./store.js";
import { captureBaseline, WorkspaceError } from "./workspace.js";

const Id = z.string().min(1);
const ScopeTask = z.object({ scope_id: Id, task_id: Id }).strict();
function compactTask(task: StoredTask) {
  const { packet: _packet, ...state } = task;
  return { ...state, terminal: ["completed", "failed", "cancelled", "timed_out"].includes(task.phase),
    operationally_resolved: ["finalizing", "completed", "failed", "cancelled", "timed_out"].includes(task.phase) };
}

export class ToolkitError extends Error {
  constructor(readonly code: string, message: string, readonly retry: "safe_same_key" | "observe_first" | "change_input" | "operator_action" = "operator_action") {
    super(message);
  }
}

export class SupervisorService {
  constructor(readonly store: SqliteTaskStore, readonly artifacts: ArtifactStore) {}

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "health": return this.health();
      case "get_task": return this.getTask(params);
      case "list_tasks": return this.listTasks(params);
      case "wait_tasks": return this.waitTasks(params);
      case "read_artifact": return this.readArtifact(params);
      case "record_review": return this.recordReview(params);
      case "start_task": return this.startTask(params);
      case "continue_task":
      case "cancel_task":
      case "respond_to_request":
        throw new ToolkitError("UNSUPPORTED_BACKEND", "execution operations are not enabled in this development runtime");
      default: throw new ToolkitError("INVALID_INPUT", `unknown operation ${method}`, "change_input");
    }
  }

  private health() {
    const unresolved = this.store.unresolved();
    return {
      ...doctor(),
      supervisor: { state: "running", queued: unresolved.filter((task) => task.phase === "queued").length,
        unresolved: unresolved.length },
    };
  }

  private getTask(params: unknown) {
    const input = ScopeTask.extend({ execution_id: Id.optional(), after_cursor: z.number().int().min(0).default(0) }).parse(params);
    const task = this.store.get(input.scope_id, input.task_id);
    if (!task) throw new ToolkitError("INVALID_INPUT", "task not found", "change_input");
    if (input.execution_id && input.execution_id !== task.executionId) throw new ToolkitError("INVALID_INPUT", "execution not found", "change_input");
    const events = this.store.events(task.executionId, input.after_cursor);
    return { ...compactTask(task),
      events, cursor: events.at(-1)?.cursor ?? input.after_cursor };
  }

  private listTasks(params: unknown) {
    const input = z.object({ scope_id: Id, limit: z.number().int().min(1).max(100).default(20), states: z.array(Id).optional(), page_cursor: Id.optional() }).strict().parse(params);
    if (input.page_cursor) throw new ToolkitError("INVALID_INPUT", "pagination is not available in this development runtime", "change_input");
    const tasks = this.store.list(input.scope_id, input.limit).filter((task) => !input.states || input.states.includes(task.phase)).map(compactTask);
    return { tasks, next_cursor: null };
  }

  private async waitTasks(params: unknown) {
    const input = z.object({ scope_id: Id, targets: z.array(z.object({ task_id: Id, after_cursor: z.number().int().min(0).default(0) }).strict()).min(1).max(16),
      timeout_ms: z.number().int().min(0).max(30_000).default(20_000) }).strict().parse(params);
    const deadline = Date.now() + input.timeout_ms;
    while (true) {
      const changed = input.targets.flatMap((target) => {
        const task = this.store.get(input.scope_id, target.task_id);
        if (!task) throw new ToolkitError("INVALID_INPUT", `task not found: ${target.task_id}`, "change_input");
        const events = this.store.events(task.executionId, target.after_cursor);
        return events.length ? [{ task: compactTask(task), events, cursor: events.at(-1)!.cursor }] : [];
      });
      if (changed.length) return { timed_out: false, changed };
      if (Date.now() >= deadline) return { timed_out: true, changed: [] };
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }

  private readArtifact(params: unknown) {
    const input = ScopeTask.extend({ execution_id: Id, artifact_id: Id,
      byte_offset: z.number().int().min(0).default(0), max_bytes: z.number().int().min(1).max(65_536).default(16_384) }).parse(params);
    const task = this.store.get(input.scope_id, input.task_id);
    if (!task || task.executionId !== input.execution_id) throw new ToolkitError("INVALID_INPUT", "execution not found", "change_input");
    const entry = this.store.artifact(input.execution_id, input.artifact_id);
    if (!entry) throw new ToolkitError("INVALID_INPUT", "artifact not found", "change_input");
    const range = this.artifacts.read(entry, input.byte_offset, input.max_bytes);
    return { artifact_id: entry.artifactId, sha256: entry.sha256, byte_length: entry.byteLength,
      media_type: entry.mediaType, byte_offset: input.byte_offset, next_offset: range.nextOffset,
      content: entry.mediaType.startsWith("text/") || entry.mediaType === "application/json"
        ? Buffer.from(range.bytes).toString("utf8") : null };
  }

  private recordReview(params: unknown) {
    const input = ScopeTask.extend({ execution_id: Id, expected_revision: z.number().int().positive(), idempotency_key: z.string().min(16).max(128), review: ReviewSchema }).parse(params);
    const task = this.store.get(input.scope_id, input.task_id);
    if (!task || task.executionId !== input.execution_id) throw new ToolkitError("INVALID_INPUT", "execution not found", "change_input");
    return compactTask(this.store.recordReview(input.scope_id, input.task_id, input.expected_revision, input.idempotency_key, input.review));
  }

  private startTask(params: unknown) {
    const input = z.object({ scope_id: Id, idempotency_key: z.string().min(16).max(128).optional(),
      workspace: z.object({ path: Id, access: z.enum(["exclusive", "shared_read"]).default("exclusive") }).strict(),
      model: z.union([z.object({ provider_id: Id, model_id: Id }).strict(), z.object({ profile: Id }).strict()]),
      profile: z.enum(["bounded-build", "bounded-inspect"]),
      limits: z.object({ queue_timeout_seconds: z.number().int().positive(), execution_timeout_seconds: z.number().int().positive() }).strict(),
      packet: TaskPacketSchema, dry_run: z.boolean().default(false),
    }).strict().parse(params);
    const packetBytes = Buffer.byteLength(JSON.stringify(input.packet), "utf8");
    if (packetBytes > 128 * 1024) throw new ToolkitError("INVALID_INPUT", "packet exceeds 128 KiB", "change_input");
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
    throw new ToolkitError("UNSUPPORTED_BACKEND", "task execution is disabled until the backend compatibility and policy gates complete");
  }
}
