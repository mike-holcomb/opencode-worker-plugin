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
  /** Exact binary/SDK/OpenAPI manifest match, independent of release certification. */
  exactPairRecognized?: boolean;
  capabilities: {
    callerAssignedMessageId: boolean;
    permissionRequests: boolean;
    questionRequests: boolean;
    structuredOutput: boolean;
    sessionRecovery: boolean;
    progressCheckpoints?: boolean;
  };
};

/** A private development opt-in never changes the pair's certified status. */
export function executionPairAllowed(inspection: BackendInspection, trustedDevelopmentOptIn: boolean): boolean {
  return inspection.supportedForExecution || (trustedDevelopmentOptIn &&
    inspection.exactPairRecognized === true && inspection.version === "1.19.0");
}

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
  /** True only when the exact session has no entry in OpenCode's status response. */
  statusOmitted?: boolean;
  pendingRequests: PendingRequest[];
  finished: boolean;
  error: string | null;
};

export type BackendEvent = {
  type: string;
  sessionId?: string;
  data: unknown;
};

export type AbortStopProof = { stopped: boolean; observation: TurnObservation | null };

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
  readCheckpoint?(event: BackendEvent, sessionId: string, userMessageId: string, control?: RequestControl): Promise<{ sourceId: string; checkpoint: unknown } | null>;
  subscribeEvents(control?: RequestControl): AsyncIterable<BackendEvent>;
  replyToRequest(request: PendingRequest, reply: "allow_once" | "deny" | string[][], control?: RequestControl): Promise<void>;
  abortSession(sessionId: string, control?: RequestControl): Promise<boolean>;
  readResult(sessionId: string, messageId: string, control?: RequestControl): Promise<{ text: string; structured: unknown }>;
}
