import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../artifacts.js";
import type { OpenCodeBackend, TurnObservation } from "../backend.js";
import { loadConfiguration } from "../config.js";
import { ExecutionCoordinator } from "../coordinator.js";
import type { TaskPacket } from "../contracts.js";
import { renderPrompt } from "../prompt.js";
import { SqliteTaskStore } from "../store.js";
import { captureBaseline } from "../workspace.js";

test("queued and restarted execution uses its frozen backend launch contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-binding-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "input.txt"), "input\n");
  const configPath = join(root, "config.json");
  const originalConfig = { schema_version: 1, project_roots: [root], read_roots: [],
    opencode_binary: "/bin/old-opencode", models: { local: { provider_id: "fake", model_id: "model", destination: "local-old" } },
    limits: { concurrency: 2, queue_timeout_seconds: 600, execution_timeout_seconds: 1800,
      finalization_timeout_seconds: 60, artifact_bytes: 50_000_000 } };
  writeFileSync(configPath, JSON.stringify(originalConfig));
  const prior = process.env.OPENCODE_AGENTS_CONFIG;
  process.env.OPENCODE_AGENTS_CONFIG = configPath;
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const openedWith: string[] = [];
  let backendId = "";
  let submitted = 0;
  let submittedMessage = "";
  const backend = {
    async inspectBackend() { return { version: "fake", openapiDigest: "fake", backendId,
      workspace, configurationDigest: "frozen", supportedForExecution: true,
      capabilities: { callerAssignedMessageId: true, permissionRequests: true,
        questionRequests: false, structuredOutput: false, sessionRecovery: true } }; },
    async createSession() { return { id: "ses_frozen", backendId, workspace }; },
    async findCreatedSession() { return null; },
    async submitTurn(input: { messageId: string; providerId: string; modelId: string }) {
      assert.equal(`${input.providerId}/${input.modelId}`, "fake/model");
      submittedMessage = input.messageId; submitted++;
    },
    async inspectTurn(_sessionId: string, messageId: string): Promise<TurnObservation> {
      assert.equal(messageId, submittedMessage);
      return { submitted: true, assistantMessageIds: [], activeTools: 1, status: "busy",
        pendingRequests: [], finished: false, error: null };
    },
    async *subscribeEvents() { await new Promise(() => {}); },
  } as unknown as OpenCodeBackend;
  const opener = async ({ backendId: id, config }: { backendId: string; workspace: string; config: ReturnType<typeof loadConfiguration> }) => {
    backendId = id;
    openedWith.push(config.opencode_binary);
    return { backendId: id, backend, close: async () => {} };
  };
  const packet: TaskPacket = { title: "Frozen", objective: "Read input", tier: "lightweight",
    authoritative_inputs: [{ reference: "input.txt", kind: "file", purpose: "Source" }],
    context: { verified_facts: [], rejected_assumptions: [], exclusions: [] },
    allowed_writes: [], acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
  const baseline = captureBaseline({ workspace, projectRoots: [root], packet });
  const taskId = `task_${randomUUID()}`;
  const executionId = `exec_${randomUUID()}`;
  const reportPath = join(root, "reports", executionId);
  const prompt = renderPrompt({ taskId, executionId, profile: "bounded-inspect", packet, baseline, outputDirectory: reportPath });
  const frozenConfig = loadConfiguration();
  const task = store.start({ taskId, executionId, scopeId: "scope", idempotencyKey: "frozen-start-key-123456",
    workspace, packet, model: "fake/model", profile: "bounded-inspect", backendConfig: frozenConfig,
    baselineHash: baseline.sha256, promptHash: prompt.sha256, frozenPrompt: prompt.text,
    frozenBaseline: baseline, reportPath,
    launchContract: { configContent: "{}", effectiveConfigSha256: "fixture", reportPath } });
  const changed = JSON.parse(readFileSync(configPath, "utf8")) as typeof originalConfig;
  changed.opencode_binary = "/bin/new-opencode";
  changed.models.local.destination = "local-new";
  writeFileSync(configPath, JSON.stringify(changed));
  const first = new ExecutionCoordinator(store, artifacts, opener);
  let second: ExecutionCoordinator | null = null;
  try {
    await first.start();
    const running = store.get("scope", task.taskId)!;
    assert.equal(running.phase, "running");
    assert.equal(running.observation, "current");
    assert.equal(running.backendConfig?.opencode_binary, "/bin/old-opencode");
    assert.equal(submitted, 1);
    await first.close();
    second = new ExecutionCoordinator(store, artifacts, opener);
    await second.start();
    const recovered = store.get("scope", task.taskId)!;
    assert.equal(recovered.phase, "running");
    assert.equal(recovered.observation, "current");
    assert.deepEqual(openedWith, ["/bin/old-opencode", "/bin/old-opencode"]);
    assert.equal(submitted, 1);
  } finally {
    await second?.close();
    await first.close();
    if (prior === undefined) delete process.env.OPENCODE_AGENTS_CONFIG;
    else process.env.OPENCODE_AGENTS_CONFIG = prior;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T29: a new task uses a new config generation while active work keeps its frozen contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-generation-"));
  const workspaces = [join(root, "old-project"), join(root, "new-project")];
  for (const path of workspaces) { mkdirSync(path); writeFileSync(join(path, "input.txt"), "input\n"); }
  const configPath = join(root, "config.json");
  const config = { schema_version: 1, project_roots: [root], read_roots: [],
    opencode_binary: "/bin/old-opencode",
    models: { local: { provider_id: "fake", model_id: "old-model", destination: "old-destination" } },
    limits: { concurrency: 2, queue_timeout_seconds: 600, execution_timeout_seconds: 1800,
      finalization_timeout_seconds: 60, artifact_bytes: 50_000_000 } };
  writeFileSync(configPath, JSON.stringify(config));
  const prior = process.env.OPENCODE_AGENTS_CONFIG;
  process.env.OPENCODE_AGENTS_CONFIG = configPath;
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const opened: Array<{ id: string; binary: string; destination: string; workspace: string }> = [];
  const submissions: Array<{ id: string; model: string }> = [];
  const messageByBackend = new Map<string, string>();
  const opener = async ({ backendId, workspace, config: frozen }: {
    backendId: string; workspace: string; config: ReturnType<typeof loadConfiguration>;
  }) => {
    opened.push({ id: backendId, binary: frozen.opencode_binary,
      destination: frozen.models.local!.destination, workspace });
    const backend = {
      async inspectBackend() { return { version: "fake", openapiDigest: "fake", backendId,
        workspace, configurationDigest: frozen.models.local!.destination, supportedForExecution: true,
        capabilities: { callerAssignedMessageId: true, permissionRequests: true,
          questionRequests: false, structuredOutput: false, sessionRecovery: true } }; },
      async createSession() { return { id: `ses_${backendId}`, backendId, workspace }; },
      async findCreatedSession() { return null; },
      async submitTurn(input: { messageId: string; providerId: string; modelId: string }) {
        submissions.push({ id: backendId, model: `${input.providerId}/${input.modelId}` });
        messageByBackend.set(backendId, input.messageId);
      },
      async inspectTurn(_sessionId: string, messageId: string): Promise<TurnObservation> {
        assert.equal(messageId, messageByBackend.get(backendId));
        return { submitted: true, assistantMessageIds: [], activeTools: 1, status: "busy",
          pendingRequests: [], finished: false, error: null };
      },
      async *subscribeEvents() { await new Promise(() => {}); },
    } as unknown as OpenCodeBackend;
    return { backendId, backend, close: async () => {} };
  };
  const packet: TaskPacket = { title: "Generation", objective: "Read input", tier: "lightweight",
    authoritative_inputs: [{ reference: "input.txt", kind: "file", purpose: "Source" }],
    context: { verified_facts: [], rejected_assumptions: [], exclusions: [] },
    allowed_writes: [], acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
  const queue = (workspace: string, key: string) => {
    const canonical = realpathSync(workspace);
    const baseline = captureBaseline({ workspace: canonical, projectRoots: [root], packet });
    const taskId = `task_${randomUUID()}`;
    const executionId = `exec_${randomUUID()}`;
    const reportPath = join(root, "reports", executionId);
    const prompt = renderPrompt({ taskId, executionId, profile: "bounded-inspect", packet, baseline, outputDirectory: reportPath });
    const frozen = loadConfiguration();
    return store.start({ taskId, executionId, scopeId: "scope", idempotencyKey: key,
      workspace: canonical, packet, model: `${frozen.models.local!.provider_id}/${frozen.models.local!.model_id}`,
      profile: "bounded-inspect", backendConfig: frozen, baselineHash: baseline.sha256,
      promptHash: prompt.sha256, frozenPrompt: prompt.text, frozenBaseline: baseline, reportPath,
      launchContract: { configContent: "{}", effectiveConfigSha256: "fixture", reportPath } });
  };
  const coordinator = new ExecutionCoordinator(store, artifacts, opener);
  try {
    const oldTask = queue(workspaces[0]!, "old-generation-key-12345");
    await coordinator.start();
    assert.equal(store.get("scope", oldTask.taskId)?.phase, "running");
    config.opencode_binary = "/bin/new-opencode";
    config.models.local.model_id = "new-model";
    config.models.local.destination = "new-destination";
    writeFileSync(configPath, JSON.stringify(config));
    const newTask = queue(workspaces[1]!, "new-generation-key-12345");
    coordinator.kick();
    for (let i = 0; i < 50 && store.get("scope", newTask.taskId)?.phase !== "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const oldActive = store.get("scope", oldTask.taskId)!;
    const newActive = store.get("scope", newTask.taskId)!;
    assert.equal(oldActive.phase, "running");
    assert.equal(newActive.phase, "running");
    assert.notEqual(oldActive.backendId, newActive.backendId);
    assert.equal(oldActive.backendConfig?.opencode_binary, "/bin/old-opencode");
    assert.equal(newActive.backendConfig?.opencode_binary, "/bin/new-opencode");
    assert.deepEqual(new Set(opened.map((item) => `${item.binary}:${item.destination}`)),
      new Set(["/bin/old-opencode:old-destination", "/bin/new-opencode:new-destination"]));
    assert.deepEqual(new Set(submissions.map((item) => item.model)), new Set(["fake/old-model", "fake/new-model"]));
    assert.equal(submissions.length, 2);
  } finally {
    await coordinator.close();
    if (prior === undefined) delete process.env.OPENCODE_AGENTS_CONFIG;
    else process.env.OPENCODE_AGENTS_CONFIG = prior;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
