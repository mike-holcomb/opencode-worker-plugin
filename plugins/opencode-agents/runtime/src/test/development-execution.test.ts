import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../artifacts.js";
import { executionPairAllowed, type OpenCodeBackend, type TurnObservation } from "../backend.js";
import { UserConfigSchema, trustedDevelopmentWorkspace } from "../config.js";
import { ExecutionCoordinator } from "../coordinator.js";
import { doctor } from "../doctor.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore } from "../store.js";

test("development opt-in requires an exact trusted workspace and keeps certification false", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-development-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const canonicalWorkspace = realpathSync(workspace);
  writeFileSync(join(workspace, "input.txt"), "input\n");
  const configPath = join(root, "config.json");
  const state = join(root, "state");
  const previousConfig = process.env.OPENCODE_AGENTS_CONFIG;
  const previousState = process.env.OPENCODE_AGENTS_STATE_DIR;
  process.env.OPENCODE_AGENTS_CONFIG = configPath;
  process.env.OPENCODE_AGENTS_STATE_DIR = state;
  const base = { schema_version: 1, project_roots: [root], read_roots: [], opencode_binary: "/usr/bin/false",
    models: { local: { provider_id: "fake", model_id: "model", destination: "local" } } };
  const packet = { title: "Probe", objective: "Read input", tier: "lightweight",
    authoritative_inputs: [{ reference: "input.txt", kind: "file", purpose: "Source" }],
    context: { verified_facts: [], rejected_assumptions: [], exclusions: [] },
    allowed_writes: [], acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
  const start = { scope_id: "scope", workspace: { path: workspace, access: "exclusive" },
    model: { profile: "local" }, profile: "bounded-inspect", limits: { queue_timeout_seconds: 60,
      execution_timeout_seconds: 120 }, packet, idempotency_key: "development-start-123456" };
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  let submits = 0;
  let messageId = "";
  let backendId = "";
  let finished = false;
  const backend = {
    async inspectBackend() { return { version: "1.19.0", openapiDigest: "pinned-digest", backendId,
      workspace: canonicalWorkspace, configurationDigest: "frozen", supportedForExecution: false, exactPairRecognized: true,
      capabilities: { callerAssignedMessageId: true, permissionRequests: true,
        questionRequests: false, structuredOutput: false, sessionRecovery: true } }; },
    async createSession() { return { id: "ses_development", backendId, workspace: canonicalWorkspace }; },
    async findCreatedSession() { return null; },
    async submitTurn(input: { messageId: string }) { submits++; messageId = input.messageId; },
    async inspectTurn(_sessionId: string, exactMessageId: string): Promise<TurnObservation> {
      assert.equal(exactMessageId, messageId);
      return { submitted: true, assistantMessageIds: finished ? ["assistant"] : [],
        activeTools: finished ? 0 : 1, status: finished ? "idle" : "busy",
        pendingRequests: [], finished, error: null };
    },
    async *subscribeEvents() { await new Promise(() => {}); },
  } as unknown as OpenCodeBackend;
  const coordinator = new ExecutionCoordinator(store, new ArtifactStore(join(root, "artifacts")),
    async ({ backendId: id }) => { backendId = id; return { backendId: id, backend, close: async () => {} }; });
  const freezeLaunch = async (_binary: string, _workspace: string, reportPath: string) => ({
    configContent: JSON.stringify({ provider: { fake: { options: { baseURL: "http://127.0.0.1:8124" },
      models: { model: {} } } } }), effectiveConfigSha256: "fixture", reportPath,
  });
  const service = new SupervisorService(store, new ArtifactStore(join(root, "artifacts")),
    coordinator, freezeLaunch);
  try {
    writeFileSync(configPath, JSON.stringify(base));
    await assert.rejects(service.handle("start_task", start), { code: "UNSUPPORTED_BACKEND" });
    assert.deepEqual(store.list("scope"), []);
    writeFileSync(configPath, JSON.stringify({ ...base,
      development_execution: { enabled: true, trusted_workspaces: [root] } }));
    await assert.rejects(service.handle("start_task", start), { code: "UNSUPPORTED_BACKEND" });
    assert.deepEqual(store.list("scope"), []);
    writeFileSync(configPath, JSON.stringify({ ...base,
      development_execution: { enabled: true, trusted_workspaces: [workspace] } }));
    assert.equal(trustedDevelopmentWorkspace(UserConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8"))), workspace), true);
    const diagnostic = doctor();
    assert.deepEqual(diagnostic.backend.certifiedPairs, []);
    assert.equal(diagnostic.backend.executionTested, false);
    const accepted = await service.handle("start_task", start) as { taskId: string };
    assert.match(accepted.taskId, /^task_/);
    for (let i = 0; i < 100 && submits === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(submits, 1);
    assert.equal(store.get("scope", accepted.taskId)?.phase, "running");
    finished = true;
    coordinator.kick();
    for (let i = 0; i < 100 && store.get("scope", accepted.taskId)?.phase !== "completed"; i++) {
      coordinator.kick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const predecessor = store.get("scope", accepted.taskId)!;
    assert.equal(predecessor.phase, "completed");
    writeFileSync(configPath, JSON.stringify(base));
    await assert.rejects(service.handle("continue_task", { scope_id: "scope", task_id: predecessor.taskId,
      predecessor_execution_id: predecessor.executionId, expected_revision: predecessor.revision,
      idempotency_key: "development-follow-123456", context_mode: "fresh", packet }),
    { code: "UNSUPPORTED_BACKEND" });
  } finally {
    await coordinator.close();
    store.close();
    if (previousConfig === undefined) delete process.env.OPENCODE_AGENTS_CONFIG;
    else process.env.OPENCODE_AGENTS_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.OPENCODE_AGENTS_STATE_DIR;
    else process.env.OPENCODE_AGENTS_STATE_DIR = previousState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("development pair gate rejects unknown pair even with workspace opt-in", () => {
  const inspection = { version: "1.19.0", openapiDigest: "wrong", backendId: "backend",
    workspace: "/tmp/project", configurationDigest: "config", supportedForExecution: false,
    exactPairRecognized: false, capabilities: { callerAssignedMessageId: true, permissionRequests: true,
      questionRequests: false, structuredOutput: false, sessionRecovery: true } };
  assert.equal(executionPairAllowed(inspection, true), false);
  assert.equal(executionPairAllowed({ ...inspection, exactPairRecognized: true }, false), false);
  assert.equal(executionPairAllowed({ ...inspection, exactPairRecognized: true, version: "1.18.36" }, true), false);
  assert.equal(executionPairAllowed({ ...inspection, exactPairRecognized: true }, true), true);
});
