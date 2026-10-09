export type RequestControl = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type BackendInspection = {
  version: string;
  openapiDigest: string;
  backendId: string;
  workspace: string;
  configurationDigest: string;
  supportedForExecution: boolean;
  capabilities: {
    callerAssignedMessageId: boolean;
    permissionRequests: boolean;
    questionRequests: boolean;
    structuredOutput: boolean;
    sessionRecovery: boolean;
  };
};

export type SessionIdentity = {
  id: string;
  backendId: string;
  workspace: string;
};

export type PendingRequest = {
  id: string;
  sessionId: string;
  type: "permission" | "question";
  api: "legacy" | "v2";
  detail: unknown;
};

export type TurnObservation = {
  submitted: boolean;
  assistantMessageIds: string[];
  activeTools: number;
  status: "busy" | "idle" | "retry" | "unknown";
  pendingRequests: PendingRequest[];
  finished: boolean;
  error: string | null;
};

export type BackendEvent = {
  type: string;
  sessionId?: string;
  data: unknown;
};

export interface OpenCodeBackend {
  inspectBackend(control?: RequestControl): Promise<BackendInspection>;
  createSession(marker: string, control?: RequestControl): Promise<SessionIdentity>;
  findCreatedSession(marker: string, control?: RequestControl): Promise<SessionIdentity | null>;
  submitTurn(input: {
    sessionId: string;
    messageId: string;
    prompt: string;
    providerId: string;
    modelId: string;
    agent: string;
    structuredOutputSchema?: Record<string, unknown>;
  }, control?: RequestControl): Promise<void>;
  inspectTurn(sessionId: string, messageId: string, control?: RequestControl): Promise<TurnObservation>;
  subscribeEvents(control?: RequestControl): AsyncIterable<BackendEvent>;
  replyToRequest(request: PendingRequest, reply: "allow_once" | "deny" | string[][], control?: RequestControl): Promise<void>;
  abortSession(sessionId: string, control?: RequestControl): Promise<boolean>;
  readResult(sessionId: string, messageId: string, control?: RequestControl): Promise<{ text: string; structured: unknown }>;
}
