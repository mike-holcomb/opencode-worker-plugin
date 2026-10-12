import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../artifacts.js";
import type { TaskPacket } from "../contracts.js";
import { captureEvidence } from "../evidence.js";
import { SqliteTaskStore, StoreConflict } from "../store.js";
import { captureBaseline } from "../workspace.js";

function fixture(git = false, allowed_writes: TaskPacket["allowed_writes"] = []) {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-evidence-"));
  const workspace = join(root, "project");
  const reports = join(root, "reports");
  mkdirSync(workspace); mkdirSync(reports);
  if (git) {
    execFileSync("git", ["-C", workspace, "init", "-q"]);
    execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", workspace, "config", "user.name", "Test"]);
  }
  const packet: TaskPacket = { title: "Build", objective: "Change files", tier: "lightweight",
    authoritative_inputs: [], context: { verified_facts: [], rejected_assumptions: [], exclusions: [] },
    allowed_writes, acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
  const store = new SqliteTaskStore(join(root, "state.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const freeze = () => {
    const baseline = captureBaseline({ workspace, projectRoots: [root], packet });
    const task = store.start({ scopeId: "scope", idempotencyKey: "evidence-key-123456", workspace,
      packet, model: "fake/model", profile: "bounded-build", baselineHash: baseline.sha256,
      promptHash: "a".repeat(64), frozenBaseline: baseline });
    writeFileSync(join(reports, "result.json"), JSON.stringify({ schema_version: 2,
      task_id: task.taskId, execution_id: task.executionId, outcome: "completed", summary: "Changed files",
      coverage: [], gaps: [], findings: [], changes: [], checks: [], blockers: [], next_action: "Review" }));
    writeFileSync(join(reports, "summary.md"), "Changed files.\n");
    const capture = (maxSnapshotBytes?: number) => captureEvidence({ taskId: task.taskId,
      executionId: task.executionId, workspace, outputDirectory: reports, packet, baseline, store, artifacts,
      ...(maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes }) });
    const manifest = (hash: string | null) => {
      assert.ok(hash);
      const entry = store.artifactsForExecution(task.executionId).find((artifact) => artifact.sha256 === hash);
      assert.ok(entry);
      return JSON.parse(Buffer.from(artifacts.read(entry!, 0, 65_536).bytes).toString("utf8")) as {
        changes: Array<{ path: string; change: string; artifact_id: string | null; declared: boolean }>;
        gaps: string[]; snapshot_bytes: number; snapshot_limit_bytes: number;
      };
    };
    return { baseline, task, capture, manifest };
  };
  return { root, workspace, packet, store, artifacts, freeze, cleanup: () => {
    store.close(); rmSync(root, { recursive: true, force: true });
  } };
}

test("Git evidence separates pre-existing dirt from added files and deletions", () => {
  const fx = fixture(true, [{ path: "out", kind: "directory", purpose: "Output" },
    { path: "remove.txt", kind: "file", purpose: "Delete" }]);
  try {
    writeFileSync(join(fx.workspace, "dirty.txt"), "base\n");
    writeFileSync(join(fx.workspace, "remove.txt"), "remove me\n");
    execFileSync("git", ["-C", fx.workspace, "add", "."]);
    execFileSync("git", ["-C", fx.workspace, "commit", "-qm", "base"]);
    writeFileSync(join(fx.workspace, "dirty.txt"), "pre-existing edit\n");
    const frozen = fx.freeze();
    mkdirSync(join(fx.workspace, "out"));
    writeFileSync(join(fx.workspace, "out", "new.txt"), "delivered\n");
    unlinkSync(join(fx.workspace, "remove.txt"));
    const result = frozen.capture();
    assert.equal(result.reportValidity, "valid", result.gaps.join("; "));
    const manifest = frozen.manifest(result.finalManifestHash);
    assert.deepEqual(manifest.changes.map(({ path, change }) => [path, change]),
      [["out", "added"], ["out/new.txt", "added"], ["remove.txt", "deleted"]]);
    const entry = manifest.changes.find((change) => change.path === "out/new.txt")!;
    const artifact = fx.store.artifact(frozen.task.executionId, entry.artifact_id!);
    assert.ok(artifact);
    assert.equal(Buffer.from(fx.artifacts.read(artifact!, 0, 100).bytes).toString("utf8"), "delivered\n");
    assert.equal(manifest.gaps.length, 0);
  } finally { fx.cleanup(); }
});

test("undeclared Git changes and required snapshot omissions fail review evidence", () => {
  const fx = fixture(true, [{ path: "out", kind: "directory", purpose: "Output" }]);
  try {
    writeFileSync(join(fx.workspace, "base.txt"), "base\n");
    execFileSync("git", ["-C", fx.workspace, "add", "."]);
    execFileSync("git", ["-C", fx.workspace, "commit", "-qm", "base"]);
    const frozen = fx.freeze();
    writeFileSync(join(fx.workspace, "rogue.txt"), "outside contract\n");
    mkdirSync(join(fx.workspace, "out"));
    writeFileSync(join(fx.workspace, "out", "large.txt"), "x".repeat(5900));
    const result = frozen.capture(6000);
    assert.equal(result.reportValidity, "invalid");
    const manifest = frozen.manifest(result.finalManifestHash);
    assert.ok(manifest.gaps.some((gap) => gap.includes("outside declared writes: rogue.txt")));
    assert.ok(manifest.gaps.some((gap) => gap.includes("snapshot limit") && gap.includes("large.txt")));
    assert.ok(manifest.snapshot_bytes <= manifest.snapshot_limit_bytes);
    let task = fx.store.get("scope", frozen.task.taskId)!;
    task = fx.store.transition("scope", task.taskId, task.revision, "finalizing", "current");
    task = fx.store.finalize("scope", task.taskId, task.revision, "completed", result.reportValidity, result.finalManifestHash);
    assert.throws(() => fx.store.recordReview("scope", task.taskId, task.revision, "review-key-12345678", {
      disposition: "accepted", rationale: "Reviewed", criteria: [], starting_state_sha256: frozen.baseline.sha256,
      final_manifest_sha256: result.finalManifestHash!, freshness: "current", integration_checks: [],
      coverage_limits: [], unresolved_issues: [], next_action: "Integrate",
    }), (error) => error instanceof StoreConflict && error.code === "INVALID_STATE");
  } finally { fx.cleanup(); }
});

test("symlinked summary is rejected without following its target", () => {
  const fx = fixture(false, []);
  try {
    const frozen = fx.freeze();
    unlinkSync(join(fx.root, "reports", "summary.md"));
    writeFileSync(join(fx.root, "private.txt"), "secret\n");
    symlinkSync(join(fx.root, "private.txt"), join(fx.root, "reports", "summary.md"));
    const result = frozen.capture();
    assert.equal(result.reportValidity, "invalid");
    assert.ok(result.gaps.some((gap) => gap.includes("summary.md cannot be captured safely")));
  } finally { fx.cleanup(); }
});

test("retry capture counts already registered bytes against the execution limit", () => {
  const fx = fixture(false, []);
  try {
    const frozen = fx.freeze();
    fx.artifacts.captureBytes(frozen.task.executionId, Buffer.alloc(1000), "application/octet-stream",
      (entry) => fx.store.registerArtifact(entry));
    const result = frozen.capture(1000);
    assert.equal(result.reportValidity, "invalid");
    assert.ok(result.gaps.some((gap) => gap.includes("result.json exceeds")));
    assert.equal(fx.store.artifactsForExecution(frozen.task.executionId)
      .reduce((sum, artifact) => sum + artifact.byteLength, 0), 1000);
  } finally { fx.cleanup(); }
});

test("retrying the same evidence reuses verified artifacts and final manifest", () => {
  const fx = fixture(false, [{ path: "out", kind: "directory", purpose: "Output" }]);
  try {
    const frozen = fx.freeze();
    mkdirSync(join(fx.workspace, "out"));
    writeFileSync(join(fx.workspace, "out", "deliverable.txt"), "delivered\n");
    const first = frozen.capture(5000);
    assert.equal(first.reportValidity, "valid", first.gaps.join("; "));
    const before = fx.store.artifactsForExecution(frozen.task.executionId);
    const firstManifest = frozen.manifest(first.finalManifestHash);
    const second = frozen.capture(5000);
    assert.equal(second.reportValidity, "valid", second.gaps.join("; "));
    assert.equal(second.finalManifestHash, first.finalManifestHash);
    const after = fx.store.artifactsForExecution(frozen.task.executionId);
    assert.deepEqual(after.map((entry) => entry.artifactId), before.map((entry) => entry.artifactId));
    assert.equal(second.artifacts.length, first.artifacts.length);
    const secondManifest = frozen.manifest(second.finalManifestHash);
    assert.deepEqual(secondManifest, firstManifest);
    assert.equal(new Set(second.artifacts.map((entry) => entry.artifactId)).size, second.artifacts.length);
  } finally { fx.cleanup(); }
});

test("retry rejects a registered artifact whose immutable bytes changed", () => {
  const fx = fixture(false, []);
  try {
    const frozen = fx.freeze();
    const first = frozen.capture();
    assert.equal(first.reportValidity, "valid");
    const report = fx.store.artifactsForExecution(frozen.task.executionId)
      .find((entry) => entry.mediaType === "application/json" && entry.sha256 !== first.finalManifestHash);
    assert.ok(report);
    writeFileSync(report!.path, "tampered");
    assert.throws(() => frozen.capture(), /artifact changed/);
  } finally { fx.cleanup(); }
});

test("non-Git declared directory evidence includes nested additions and deletions", () => {
  const fx = fixture(false, [{ path: "out", kind: "directory", purpose: "Output" }]);
  try {
    mkdirSync(join(fx.workspace, "out"));
    writeFileSync(join(fx.workspace, "out", "old.txt"), "old\n");
    const frozen = fx.freeze();
    unlinkSync(join(fx.workspace, "out", "old.txt"));
    mkdirSync(join(fx.workspace, "out", "nested"));
    writeFileSync(join(fx.workspace, "out", "nested", "new.txt"), "new\n");
    const result = frozen.capture();
    assert.equal(result.reportValidity, "valid", result.gaps.join("; "));
    const manifest = frozen.manifest(result.finalManifestHash);
    assert.deepEqual(manifest.changes.map(({ path, change }) => [path, change]),
      [["out/nested", "added"], ["out/nested/new.txt", "added"], ["out/old.txt", "deleted"]]);
  } finally { fx.cleanup(); }
});
