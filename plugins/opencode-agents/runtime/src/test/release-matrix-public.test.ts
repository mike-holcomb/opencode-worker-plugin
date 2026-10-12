import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { ArtifactStore } from "../artifacts.js";
import { ExecutionCoordinator } from "../coordinator.js";
import { createMcpServer } from "../mcp.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore, type StoredTask } from "../store.js";

const packet = {
  title: "Inspect", objective: "Inspect the selected workspace", tier: "lightweight",
  authoritative_inputs: [], context: { verified_facts: [], rejected_assumptions: [], exclusions: [] },
  allowed_writes: [], acceptance_criteria: [{ id: "required", requirement: "Verify output",
    evidence_required: "An inspected artifact", required: true }],
  checks: [], constraints: [], stop_conditions: [], shared_resources: [],
} as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-release-public-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ schema_version: 1, project_roots: [root], read_roots: [],
    opencode_binary: "/usr/bin/false", models: { local: { provider_id: "fake", model_id: "model", destination: "local" } },
    limits: { concurrency: 2, queue_timeout_seconds: 600, execution_timeout_seconds: 1800,
      finalization_timeout_seconds: 60, artifact_bytes: 50_000_000 } }));
  const previous = process.env.OPENCODE_AGENTS_CONFIG;
  process.env.OPENCODE_AGENTS_CONFIG = config;
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const coordinator = new ExecutionCoordinator(store, artifacts, async () => {
    throw new Error("this test must not contact a backend");
  });
  const service = new SupervisorService(store, artifacts, coordinator);
  const start = (key: string): StoredTask => store.start({ scopeId: "scope", idempotencyKey: key,
    workspace, packet, model: "fake/model", profile: "bounded-inspect",
    baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
  return { root, workspace, store, artifacts, coordinator, service, start, close() {
    store.close();
    if (previous === undefined) delete process.env.OPENCODE_AGENTS_CONFIG;
    else process.env.OPENCODE_AGENTS_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  } };
}

test("T09/T25: MCP wait timeout preserves queued work and reports unknown usage as null", async () => {
  const fx = fixture();
  const task = fx.start("wait-timeout-123456789");
  const server = createMcpServer((method, params) => fx.service.handle(method, params));
  const client = new Client({ name: "release-matrix", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const cursor = fx.store.events(task.executionId).at(-1)!.cursor;
    const waited = await client.callTool({ name: "opencode_wait_tasks", arguments: {
      scope_id: "scope", targets: [{ task_id: task.taskId, after_cursor: cursor }], timeout_ms: 10,
    } });
    assert.equal((waited.structuredContent as { timed_out: boolean }).timed_out, true);
    const observed = await client.callTool({ name: "opencode_get_task", arguments: {
      scope_id: "scope", task_id: task.taskId,
    } });
    const state = observed.structuredContent as { phase: string; usage: Record<string, unknown> };
    assert.equal(state.phase, "queued");
    assert.equal(state.usage.input_tokens, null);
    assert.equal(state.usage.output_tokens, null);
    assert.equal(state.usage.reported_cost, null);
    assert.equal(state.usage.source, "not_captured");
    assert.equal(fx.store.get("scope", task.taskId)?.phase, "queued");
  } finally { await client.close(); await server.close(); fx.close(); }
});

test("T12/T31: unresolved and finalizing predecessors cannot be continued, and finalization holds ownership", async () => {
  const fx = fixture();
  try {
    let task = fx.start("continue-gate-123456789");
    const follow = (revision: number) => fx.service.handle("continue_task", {
      scope_id: "scope", task_id: task.taskId, predecessor_execution_id: task.executionId,
      expected_revision: revision, idempotency_key: "follow-gate-123456789",
      context_mode: "fresh", packet,
    });
    await assert.rejects(follow(task.revision), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "INVALID_STATE");
    assert.equal(fx.store.get("scope", task.taskId)?.executionId, task.executionId);
    task = fx.store.admit(task.scopeId, task.taskId, task.revision, [`workspace:${task.workspace}`])!;
    task = fx.store.beginFinalization(task.scopeId, task.taskId, task.revision, "completed");
    assert.equal(fx.store.reserve("other_execution", [`workspace:${task.workspace}`]), false);
    await assert.rejects(follow(task.revision), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "INVALID_STATE");
    const projected = await fx.service.handle("get_task", { scope_id: "scope", task_id: task.taskId }) as
      { phase: string; terminal: boolean; operationally_resolved: boolean };
    assert.equal(projected.phase, "finalizing");
    assert.equal(projected.terminal, false);
    assert.equal(projected.operationally_resolved, false);
  } finally { fx.close(); }
});

test("T17: accepted review rejects failed or unchecked required criteria", async () => {
  const fx = fixture();
  try {
    let task = fx.start("review-gate-123456789");
    task = fx.store.admit(task.scopeId, task.taskId, task.revision, [`workspace:${task.workspace}`])!;
    task = fx.store.beginFinalization(task.scopeId, task.taskId, task.revision, "completed");
    const capture = (body: string, mediaType: string) => fx.artifacts.captureBytes(task.executionId,
      Buffer.from(body), mediaType, (entry) => fx.store.registerArtifact(entry));
    const report = capture(JSON.stringify({ schema_version: 2, task_id: task.taskId, execution_id: task.executionId,
      outcome: "completed", summary: "Verified output", coverage: ["workspace"], gaps: [], findings: [],
      changes: [], checks: [], blockers: [], next_action: "Review" }), "application/json");
    capture("Verified output.\n", "text/markdown");
    const manifest = capture("{\"changes\":[]}", "application/json");
    task = fx.store.finalize(task.scopeId, task.taskId, task.revision, "completed", "valid", manifest.sha256);
    for (const result of ["unsatisfied", "not_checked"] as const) {
      const review = { disposition: "accepted", rationale: "Review attempted",
        criteria: [{ id: "required", result,
          evidence: [`artifact:${report.artifactId}@sha256:${report.sha256}`] }],
        starting_state_sha256: task.baselineHash, final_manifest_sha256: task.finalManifestHash,
        freshness: "current", integration_checks: [], coverage_limits: [], unresolved_issues: [], next_action: "none" };
      await assert.rejects(fx.service.handle("record_review", { scope_id: "scope", task_id: task.taskId,
        execution_id: task.executionId, expected_revision: task.revision,
        idempotency_key: `review-${result}-123456789`, review }), (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_STATE");
    }
    assert.equal(fx.store.get("scope", task.taskId)?.reviewStatus, "pending");
  } finally { fx.close(); }
});

test("T18: changed captured bytes block acceptance while the historical registration remains", async () => {
  const fx = fixture();
  try {
    let task = fx.start("artifact-gate-123456789");
    task = fx.store.admit(task.scopeId, task.taskId, task.revision, [`workspace:${task.workspace}`])!;
    task = fx.store.beginFinalization(task.scopeId, task.taskId, task.revision, "completed");
    const capture = (body: string, mediaType: string) => fx.artifacts.captureBytes(task.executionId,
      Buffer.from(body), mediaType, (entry) => fx.store.registerArtifact(entry));
    const report = capture("{}", "application/json");
    const summary = capture("Summary", "text/markdown");
    const manifest = capture("{\"evidence\":true}", "application/json");
    task = fx.store.finalize(task.scopeId, task.taskId, task.revision, "completed", "valid", manifest.sha256);
    writeFileSync(summary.path, "Tampered");
    const review = { disposition: "accepted", rationale: "Inspected all evidence",
      criteria: [{ id: "required", result: "satisfied",
        evidence: [`artifact:${report.artifactId}@sha256:${report.sha256}`] }],
      starting_state_sha256: task.baselineHash, final_manifest_sha256: manifest.sha256,
      freshness: "current", integration_checks: [], coverage_limits: [], unresolved_issues: [], next_action: "none" };
    await assert.rejects(fx.service.handle("record_review", { scope_id: "scope", task_id: task.taskId,
      execution_id: task.executionId, expected_revision: task.revision,
      idempotency_key: "review-artifact-gate-123456789", review }), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ARTIFACT_CHANGED");
    assert.equal(fx.store.get(task.scopeId, task.taskId)?.reviewStatus, "pending");
    assert.equal(fx.store.artifact(task.executionId, summary.artifactId)?.sha256, summary.sha256);
  } finally { fx.close(); }
});

test("T19: wrong-session or expired permission requests are rejected before any upstream reply", async () => {
  const fx = fixture();
  try {
    let task = fx.start("request-gate-123456789");
    task = fx.store.bindSession(task.scopeId, task.taskId, task.revision, "backend_fake", "session_recorded");
    task = fx.store.transition(task.scopeId, task.taskId, task.revision, "running", "current");
    const request = fx.store.upsertInputRequest(task.scopeId, task.taskId, task.executionId,
      "permission_wrong", "permission", { id: "permission_wrong", sessionId: "session_other", type: "permission" });
    const reply = (requestId: string) => fx.service.handle("respond_to_request", { scope_id: task.scopeId,
      task_id: task.taskId, execution_id: task.executionId, request_id: requestId, request_revision: request.revision,
      reply: "allow_once", authorization_basis: "existing task authorization", idempotency_key: `reply-${requestId}-123456789` });
    await assert.rejects(reply(request.requestId), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "REQUEST_EXPIRED");
    fx.store.expireInputRequest(task.executionId, request.requestId);
    await assert.rejects(reply(request.requestId), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "REQUEST_EXPIRED");
    assert.equal(fx.store.inputRequests(task.executionId)[0]?.status, "expired");
    assert.equal(fx.store.events(task.executionId).some((event) => event.kind === "input_response_intent"), false);
  } finally { fx.close(); }
});

test("T26: get_task event pages retain blockers and advance an explicit cursor", async () => {
  const fx = fixture();
  try {
    let task = fx.start("event-page-123456789");
    for (let i = 0; i < 105; i++) task = fx.store.transition(task.scopeId, task.taskId, task.revision,
      "queued", "current", { blocker: `blocker_${i}` });
    const seen: Array<{ cursor: number; detail: { blocker?: string } }> = [];
    let cursor = 0;
    for (let page = 0; page < 20; page++) {
      const result = await fx.service.handle("get_task", { scope_id: "scope", task_id: task.taskId,
        after_cursor: cursor }) as { events: Array<{ cursor: number; detail: { blocker?: string } }>; cursor: number };
      if (!result.events.length) break;
      assert.ok(result.cursor > cursor);
      seen.push(...result.events);
      cursor = result.cursor;
    }
    assert.equal(seen.length, 106);
    assert.equal(new Set(seen.map((event) => event.cursor)).size, seen.length);
    assert.equal(seen.at(-1)?.detail.blocker, "blocker_104");
  } finally { fx.close(); }
});
