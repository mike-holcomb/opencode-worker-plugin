import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compatibilityPath } from "./resources.js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { BackendEvent, BackendInspection, OpenCodeBackend, PendingRequest, RequestControl, SessionIdentity, TurnObservation } from "./backend.js";

function signalFor(control?: RequestControl): AbortSignal | null {
  if (!control?.timeoutMs) return control?.signal ?? null;
  const timeout = AbortSignal.timeout(control.timeoutMs);
  return control.signal ? AbortSignal.any([control.signal, timeout]) : timeout;
}

function requireData<T>(result: { data?: T; error?: unknown }, operation: string): NonNullable<T> {
  if (result.error || result.data === undefined) {
    throw new Error(`${operation}: ${JSON.stringify(result.error ?? "missing response data")}`);
  }
  return result.data as NonNullable<T>;
}

export class SdkOpenCodeBackend implements OpenCodeBackend {
  private readonly client;
  private readonly headers: Record<string, string>;

  constructor(
    readonly baseUrl: string,
    readonly workspace: string,
    readonly backendId: string,
    headers?: Record<string, string>,
  ) {
    this.headers = headers ?? {};
    this.client = createOpencodeClient({ baseUrl, directory: workspace, headers });
  }

  private identity(id: string): SessionIdentity {
    return { id, backendId: this.backendId, workspace: this.workspace };
  }

  async effectiveConfiguration(control?: RequestControl): Promise<unknown> {
    return requireData(await this.client.config.get(
      { directory: this.workspace }, { signal: signalFor(control) },
    ), "backend config");
  }

  async inspectBackend(control?: RequestControl): Promise<BackendInspection> {
    const signal = signalFor(control);
    const health = requireData(await this.client.global.health({ signal }), "backend health");
    const path = requireData(await this.client.path.get({ directory: this.workspace }, { signal }), "backend path");
    if (path.directory !== this.workspace) throw new Error(`backend workspace mismatch: ${path.directory}`);
    const config = requireData(await this.client.config.get({ directory: this.workspace }, { signal }), "backend config");
    const configurationDigest = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    const doc = await fetch(new URL("/doc", this.baseUrl), { headers: this.headers, signal });
    if (!doc.ok) throw new Error(`backend OpenAPI document unavailable: ${doc.status}`);
    const openapiDigest = createHash("sha256").update(Buffer.from(await doc.arrayBuffer())).digest("hex");
    const manifest = JSON.parse(readFileSync(compatibilityPath(), "utf8")) as {
      pairs: Array<{ binary_version: string; sdk_version: string; openapi_sha256: string; execution_supported: boolean;
        capabilities: BackendInspection["capabilities"] }>;
    };
    const pair = manifest.pairs.find((item) => item.binary_version === health.version && item.sdk_version === "1.18.35" && item.openapi_sha256 === openapiDigest);
    return {
      version: health.version,
      openapiDigest,
      backendId: this.backendId,
      workspace: this.workspace,
      configurationDigest,
      supportedForExecution: pair?.execution_supported ?? false,
      exactPairRecognized: pair !== undefined,
      capabilities: pair?.capabilities ?? {
        callerAssignedMessageId: false,
        permissionRequests: false,
        questionRequests: false,
        structuredOutput: false,
        sessionRecovery: false,
      },
    };
  }

  async createSession(marker: string, control?: RequestControl): Promise<SessionIdentity> {
    const session = requireData(await this.client.session.create(
      { directory: this.workspace, title: marker, metadata: { opencodeAgentsMarker: marker } },
      { signal: signalFor(control) },
    ), "create session");
    return this.identity(session.id);
  }

  async findCreatedSession(marker: string, control?: RequestControl): Promise<SessionIdentity | null> {
    const sessions = requireData(await this.client.session.list(
      { directory: this.workspace, search: marker, limit: 100 },
      { signal: signalFor(control) },
    ), "find session");
    const exact = sessions.filter((session) => session.title === marker && session.metadata?.opencodeAgentsMarker === marker);
    if (exact.length > 1) throw new Error("ambiguous session creation");
    return exact[0] ? this.identity(exact[0].id) : null;
  }

  async submitTurn(input: {
    sessionId: string;
    messageId: string;
    prompt: string;
    providerId: string;
    modelId: string;
    agent: string;
    structuredOutputSchema?: Record<string, unknown>;
  }, control?: RequestControl): Promise<void> {
    const result = await this.client.session.promptAsync({
      sessionID: input.sessionId,
      directory: this.workspace,
      messageID: input.messageId,
      model: { providerID: input.providerId, modelID: input.modelId },
      agent: input.agent,
      parts: [{ type: "text", text: input.prompt }],
      ...(input.structuredOutputSchema ? { format: { type: "json_schema", schema: input.structuredOutputSchema } } : {}),
    }, { signal: signalFor(control) });
    if (result.error) throw new Error(`submit turn: ${JSON.stringify(result.error)}`);
  }

  async inspectTurn(sessionId: string, messageId: string, control?: RequestControl): Promise<TurnObservation> {
    const signal = signalFor(control);
    const [messagesResult, statusResult, permissionsResult, questionsResult, v2PermissionsResult, v2QuestionsResult] = await Promise.all([
      this.client.session.messages({ sessionID: sessionId, directory: this.workspace, limit: 200 }, { signal }),
      this.client.session.status({ directory: this.workspace }, { signal }),
      this.client.permission.list({ directory: this.workspace }, { signal }),
      this.client.question.list({ directory: this.workspace }, { signal }),
      this.client.v2.session.permission.list({ sessionID: sessionId }, { signal }),
      this.client.v2.session.question.list({ sessionID: sessionId }, { signal }),
    ]);
    const messages = requireData(messagesResult, "inspect messages");
    const statuses = requireData(statusResult, "inspect status");
    const permissions = requireData(permissionsResult, "inspect permissions");
    const questions = requireData(questionsResult, "inspect questions");
    const v2Permissions = requireData(v2PermissionsResult, "inspect v2 permissions").data;
    const v2Questions = requireData(v2QuestionsResult, "inspect v2 questions").data;
    const submitted = messages.some(({ info }) => info.id === messageId && info.role === "user");
    const assistants = messages.filter(({ info }) => info.role === "assistant" && info.parentID === messageId);
    const activeTools = assistants.flatMap(({ parts }) => parts).filter((part) =>
      part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
    ).length;
    const pendingRequests: PendingRequest[] = [
      ...permissions.filter((request) => request.sessionID === sessionId).map((request) => ({
        id: request.id, sessionId, type: "permission" as const, api: "legacy" as const, detail: request,
      })),
      ...questions.filter((request) => request.sessionID === sessionId).map((request) => ({
        id: request.id, sessionId, type: "question" as const, api: "legacy" as const, detail: request,
      })),
      ...v2Permissions.map((request) => ({
        id: request.id, sessionId, type: "permission" as const, api: "v2" as const, detail: request,
      })),
      ...v2Questions.map((request) => ({
        id: request.id, sessionId, type: "question" as const, api: "v2" as const, detail: request,
      })),
    ];
    // A tool-calls step ends one model step, not the delegated turn. In particular,
    // a denied tool request may leave the session absent from /session/status while
    // the assistant has not produced a final answer.
    const terminalAssistant = assistants.find(({ info }) => info.role === "assistant" &&
      Boolean(info.error || info.finish === "stop" || info.finish === "length"));
    const upstreamStatus = statuses[sessionId]?.type;
    // OpenCode omits idle sessions from /session/status. A correlated terminal
    // assistant message is required before interpreting that omission as idle.
    const status = upstreamStatus === "busy" || upstreamStatus === "idle" || upstreamStatus === "retry"
      ? upstreamStatus : terminalAssistant ? "idle" : "unknown";
    const error = terminalAssistant?.info.role === "assistant" && terminalAssistant.info.error
      ? JSON.stringify(terminalAssistant.info.error) : null;
    return {
      submitted,
      assistantMessageIds: assistants.map(({ info }) => info.id),
      activeTools,
      status,
      statusOmitted: !Object.hasOwn(statuses, sessionId),
      pendingRequests,
      finished: submitted && Boolean(terminalAssistant) && status === "idle" && activeTools === 0 && pendingRequests.length === 0,
      error,
    };
  }

  async *subscribeEvents(control?: RequestControl): AsyncIterable<BackendEvent> {
    const { stream } = await this.client.event.subscribe({ directory: this.workspace }, { signal: signalFor(control) });
    for await (const event of stream) {
      const data: unknown = event;
      const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const properties = record.properties && typeof record.properties === "object" ? record.properties as Record<string, unknown> : {};
      const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
      yield { type: typeof record.type === "string" ? record.type : "unknown", data, ...(sessionId ? { sessionId } : {}) };
    }
  }

  async replyToRequest(request: PendingRequest, reply: "allow_once" | "deny" | string[][], control?: RequestControl): Promise<void> {
    const signal = signalFor(control);
    if (request.type === "permission") {
      if (Array.isArray(reply)) throw new Error("permission reply must be allow_once or deny");
      if (request.api === "v2") {
        requireData(await this.client.v2.session.permission.reply({
          sessionID: request.sessionId, requestID: request.id, reply: reply === "allow_once" ? "once" : "reject",
        }, { signal }), "v2 permission reply");
      } else {
        requireData(await this.client.permission.reply({
          requestID: request.id, directory: this.workspace, reply: reply === "allow_once" ? "once" : "reject",
        }, { signal }), "permission reply");
      }
      return;
    }
    if (!Array.isArray(reply)) {
      if (reply !== "deny") throw new Error("question reply must supply answers or deny");
      if (request.api === "v2") {
        requireData(await this.client.v2.session.question.reject({ sessionID: request.sessionId, requestID: request.id }, { signal }), "v2 question reject");
      } else {
        requireData(await this.client.question.reject({ requestID: request.id, directory: this.workspace }, { signal }), "question reject");
      }
      return;
    }
    if (request.api === "v2") {
      requireData(await this.client.v2.session.question.reply({
        sessionID: request.sessionId, requestID: request.id, questionV2Reply: { answers: reply },
      }, { signal }), "v2 question reply");
    } else {
      requireData(await this.client.question.reply({ requestID: request.id, directory: this.workspace, answers: reply }, { signal }), "question reply");
    }
  }

  async abortSession(sessionId: string, control?: RequestControl): Promise<boolean> {
    const result = await this.client.session.abort({ sessionID: sessionId, directory: this.workspace }, { signal: signalFor(control) });
    return requireData(result, "abort session");
  }

  async readResult(sessionId: string, messageId: string, control?: RequestControl): Promise<{ text: string; structured: unknown }> {
    const messages = requireData(await this.client.session.messages(
      { sessionID: sessionId, directory: this.workspace, limit: 200 }, { signal: signalFor(control) },
    ), "read result");
    const assistants = messages.filter(({ info }) => info.role === "assistant" && info.parentID === messageId);
    const structuredAssistant = assistants.find(({ info }) => info.role === "assistant" && info.structured !== undefined);
    return {
      text: assistants.flatMap(({ parts }) => parts).filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      structured: structuredAssistant?.info.role === "assistant" ? structuredAssistant.info.structured ?? null : null,
    };
  }
}
