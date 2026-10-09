import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { TaskPacketSchema, ReviewSchema } from "./contracts.js";
import { rpcRequest } from "./rpc.js";
import { stateDirectory } from "./config.js";
import { startDaemon } from "./daemon.js";

const Id = z.string().min(1);
const Key = z.string().min(16).max(128);
const Revision = z.number().int().positive();
const Scope = { scope_id: Id };

function result(value: unknown) {
  const structuredContent = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : { value };
  const raw = JSON.stringify(structuredContent);
  const text = raw.length > 8000 ? `${raw.slice(0, 7950)}... [read structured content for full response]` : raw;
  return { structuredContent, content: [{ type: "text" as const, text }] };
}

export function createMcpServer(call: (method: string, params: unknown) => Promise<unknown>): McpServer {
  const server = new McpServer({ name: "opencode-agents", version: "2.0.0-dev.0" });
  server.registerTool("opencode_health", {
    description: "Read toolkit and configured backend health without inference.",
    inputSchema: z.object({ backend_id: Id.optional() }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => result(await call("health", input)));
  server.registerTool("opencode_start_task", {
    description: "Admit one bounded assignment; dry_run validates without dispatch.",
    inputSchema: z.object({
      ...Scope,
      idempotency_key: Key.optional(),
      workspace: z.object({ path: Id, access: z.enum(["exclusive", "shared_read"]).default("exclusive") }).strict(),
      model: z.union([
        z.object({ provider_id: Id, model_id: Id }).strict(),
        z.object({ profile: Id }).strict(),
      ]),
      profile: z.enum(["bounded-build", "bounded-inspect"]),
      limits: z.object({ queue_timeout_seconds: z.number().int().positive(), execution_timeout_seconds: z.number().int().positive() }).strict(),
      packet: TaskPacketSchema,
      dry_run: z.boolean().optional(),
    }).strict().refine((value) => value.dry_run || Boolean(value.idempotency_key), "idempotency_key is required for launch"),
  }, async (input) => result(await call("start_task", input)));
  server.registerTool("opencode_get_task", {
    description: "Read a compact task snapshot and material events.",
    inputSchema: z.object({ ...Scope, task_id: Id, execution_id: Id.optional(), after_cursor: z.number().int().min(0).optional() }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => result(await call("get_task", input)));
  server.registerTool("opencode_list_tasks", {
    description: "Recover task identities in a coordination scope.",
    inputSchema: z.object({ ...Scope, states: z.array(Id).optional(), limit: z.number().int().min(1).max(100).default(20), page_cursor: Id.optional() }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => result(await call("list_tasks", input)));
  server.registerTool("opencode_wait_tasks", {
    description: "Wait briefly for material changes; timeout never cancels work.",
    inputSchema: z.object({ ...Scope, targets: z.array(z.object({ task_id: Id, after_cursor: z.number().int().min(0).default(0) }).strict()).min(1).max(16), timeout_ms: z.number().int().min(0).max(30_000).default(20_000) }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => result(await call("wait_tasks", input)));
  server.registerTool("opencode_continue_task", {
    description: "Continue a resolved task in its exact recorded session or fresh context.",
    inputSchema: z.object({ ...Scope, task_id: Id, predecessor_execution_id: Id, expected_revision: Revision, idempotency_key: Key,
      context_mode: z.enum(["resume", "fresh"]), packet: TaskPacketSchema }).strict(),
  }, async (input) => result(await call("continue_task", input)));
  server.registerTool("opencode_cancel_task", {
    description: "Record a cancellation request; confirmation is reported separately.",
    inputSchema: z.object({ ...Scope, task_id: Id, execution_id: Id, reason: Id, expected_revision: Revision, idempotency_key: Key }).strict(),
  }, async (input) => result(await call("cancel_task", input)));
  server.registerTool("opencode_respond_to_request", {
    description: "Reply once to a current permission or question request.",
    inputSchema: z.object({ ...Scope, task_id: Id, execution_id: Id, request_id: Id, request_revision: Revision,
      reply: z.union([z.enum(["allow_once", "deny"]), z.array(z.array(Id))]), authorization_basis: Id, idempotency_key: Key }).strict(),
  }, async (input) => result(await call("respond_to_request", input)));
  server.registerTool("opencode_read_artifact", {
    description: "Read a bounded range of an immutable artifact.",
    inputSchema: z.object({ ...Scope, task_id: Id, execution_id: Id, artifact_id: Id,
      byte_offset: z.number().int().min(0).default(0), max_bytes: z.number().int().min(1).max(65_536).default(16_384) }).strict(),
    annotations: { readOnlyHint: true },
  }, async (input) => result(await call("read_artifact", input)));
  server.registerTool("opencode_record_review", {
    description: "Append the parent's evidence-based review decision.",
    inputSchema: z.object({ ...Scope, task_id: Id, execution_id: Id, expected_revision: Revision, idempotency_key: Key, review: ReviewSchema }).strict(),
  }, async (input) => result(await call("record_review", input)));
  return server;
}

export async function runMcp(): Promise<void> {
  await startDaemon(process.argv[1]);
  const server = createMcpServer((method, params) => rpcRequest(stateDirectory(), method, params));
  await server.connect(new StdioServerTransport());
}
