import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { WorkerReportSchema, type TaskPacket } from "./contracts.js";
import type { ArtifactRegistration, ArtifactStore } from "./artifacts.js";
import type { SqliteTaskStore } from "./store.js";
import { captureEvidenceIndex, type EvidenceEntry, type WorkspaceBaseline } from "./workspace.js";

export type EvidenceResult = {
  reportValidity: "valid" | "missing" | "invalid";
  finalManifestHash: string | null;
  artifacts: ArtifactRegistration[];
  gaps: string[];
};

function sha(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function inside(path: string, root: string): boolean { return path === root || path.startsWith(root + sep); }
function git(workspace: string, args: string[]): Buffer | null {
  try { return execFileSync("git", ["-C", workspace, ...args], { maxBuffer: 50 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
}
function sameEntry(before: EvidenceEntry, after: EvidenceEntry): boolean {
  return before.kind === after.kind && before.sha256 === after.sha256 && before.byteLength === after.byteLength;
}
function regularBytes(path: string, expected: EvidenceEntry): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.byteLength)
      throw new Error("file changed type or size before capture");
    const bytes = readFileSync(fd);
    if (sha(bytes) !== expected.sha256) throw new Error("file changed after final index");
    return bytes;
  } finally { closeSync(fd); }
}
function safeRegularBytes(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    const namedBefore = lstatSync(path);
    if (!before.isFile() || !namedBefore.isFile() || namedBefore.isSymbolicLink() ||
      namedBefore.ino !== before.ino || before.size > maxBytes)
      throw new Error("not a regular file within the snapshot limit");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino ||
      namedAfter.ino !== before.ino ||
      bytes.byteLength !== before.size)
      throw new Error("file changed during capture");
    return bytes;
  } finally { closeSync(fd); }
}

/** Freeze reports and baseline-relative changes, including new files and deletions. */
export function captureEvidence(input: {
  taskId: string;
  executionId: string;
  workspace: string;
  outputDirectory: string;
  packet: TaskPacket;
  baseline: WorkspaceBaseline;
  store: SqliteTaskStore;
  artifacts: ArtifactStore;
  structuredReport?: unknown;
  maxSnapshotBytes?: number;
}): EvidenceResult {
  const { taskId, executionId, outputDirectory, baseline, store, artifacts } = input;
  const workspace = baseline.workspace;
  const registered: ArtifactRegistration[] = store.artifactsForExecution(executionId);
  const captured: ArtifactRegistration[] = [];
  const gaps: string[] = [];
  const maxSnapshotBytes = input.maxSnapshotBytes ?? 50 * 1024 * 1024;
  if (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes <= 0)
    throw new Error("invalid per-execution snapshot limit");
  let capturedBytes = registered.reduce((sum, artifact) => sum + artifact.byteLength, 0);
  if (capturedBytes > maxSnapshotBytes) gaps.push("previously registered artifacts exceed the per-execution evidence snapshot limit");
  const identity = (digest: string, length: number, mediaType: string) => JSON.stringify([digest, length, mediaType]);
  const existingByIdentity = new Map(registered.map((entry) =>
    [identity(entry.sha256, entry.byteLength, entry.mediaType), entry]));
  const include = (entry: ArtifactRegistration): void => {
    if (!captured.some((item) => item.artifactId === entry.artifactId)) captured.push(entry);
  };
  const capture = (bytes: Uint8Array, mediaType: string, label: string): ArtifactRegistration | null => {
    const key = identity(sha(bytes), bytes.byteLength, mediaType);
    const existing = existingByIdentity.get(key);
    if (existing) {
      // Reading through ArtifactStore verifies the recorded path, length and full hash.
      artifacts.read(existing, 0, 1);
      include(existing);
      return existing;
    }
    if (bytes.byteLength > artifacts.maxBytes || capturedBytes + bytes.byteLength > maxSnapshotBytes) {
      gaps.push(`${label} exceeds the per-execution evidence snapshot limit (${maxSnapshotBytes} bytes)`);
      return null;
    }
    const entry = artifacts.captureBytes(executionId, bytes, mediaType, (value) => store.registerArtifact(value));
    capturedBytes += bytes.byteLength;
    existingByIdentity.set(key, entry);
    include(entry);
    return entry;
  };
  const reportPath = join(outputDirectory, "result.json");
  let reportBytes: Buffer | null = null;
  if (input.structuredReport !== undefined && input.structuredReport !== null) {
    reportBytes = Buffer.from(JSON.stringify(input.structuredReport));
  } else if (existsSync(reportPath)) {
    try { reportBytes = safeRegularBytes(reportPath, maxSnapshotBytes); }
    catch (error) { gaps.push(`result.json cannot be captured safely: ${String(error)}`); }
  }
  let reportValidity: EvidenceResult["reportValidity"] = "missing";
  if (reportBytes) {
    if (capture(reportBytes, "application/json", "result.json")) {
      try {
        const report = WorkerReportSchema.parse(JSON.parse(reportBytes.toString("utf8")));
        reportValidity = report.task_id === taskId && report.execution_id === executionId ? "valid" : "invalid";
        if (reportValidity === "invalid") gaps.push("report identity does not match execution");
      } catch { reportValidity = "invalid"; gaps.push("result.json is malformed or fails WorkerReport schema"); }
    } else reportValidity = "invalid";
  } else gaps.push("result.json is missing or not capturable");
  const summaryPath = join(outputDirectory, "summary.md");
  if (existsSync(summaryPath)) {
    try {
      if (!capture(safeRegularBytes(summaryPath, maxSnapshotBytes), "text/markdown", "summary.md") && reportValidity === "valid")
        reportValidity = "invalid";
    } catch (error) { gaps.push(`summary.md cannot be captured safely: ${String(error)}`); if (reportValidity === "valid") reportValidity = "invalid"; }
  } else { gaps.push("summary.md is missing"); if (reportValidity === "valid") reportValidity = "invalid"; }

  const tracked = baseline.git ? git(workspace, ["diff", "--binary", "HEAD", "--"]) : null;
  const staged = baseline.git ? git(workspace, ["diff", "--cached", "--binary", "--"]) : null;
  if (baseline.git && tracked === null) gaps.push("Git tracked diff could not be captured");
  if (baseline.git && staged === null) gaps.push("Git staged diff could not be captured");
  if (tracked) capture(tracked, "text/x-diff", "Git worktree diff");
  if (staged) capture(staged, "text/x-diff", "Git staged diff");

  const initial = baseline.evidenceIndex;
  if (!initial?.complete) gaps.push(...(initial?.gaps ?? ["frozen baseline has no change index"]));
  const final = captureEvidenceIndex(workspace, baseline.writeTargetState, Boolean(baseline.git));
  if (!final.complete) gaps.push(...final.gaps);
  const before = new Map((initial?.entries ?? []).map((entry) => [entry.path, entry]));
  const after = new Map(final.entries.map((entry) => [entry.path, entry]));
  const absent = (path: string): EvidenceEntry => ({ path, kind: "absent", sha256: null, byteLength: null });
  const changes: Array<{ path: string; change: "added" | "modified" | "deleted" | "type_changed";
    before: EvidenceEntry; after: EvidenceEntry; artifact_id: string | null; declared: boolean }> = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const prior = before.get(path) ?? absent(path);
    const current = after.get(path) ?? absent(path);
    if (sameEntry(prior, current)) continue;
    const absolute = resolve(workspace, path);
    if (inside(absolute, outputDirectory)) continue; // Supervisor-assigned report channel is captured above.
    const declared = baseline.writeTargetState.some((target) =>
      target.kind === "file" ? absolute === target.path : inside(absolute, target.path));
    if (!declared) gaps.push(`workspace changed outside declared writes: ${path}`);
    const change = prior.kind === "absent" ? "added" : current.kind === "absent" ? "deleted" :
      prior.kind !== current.kind ? "type_changed" : "modified";
    let artifactId: string | null = null;
    if (current.kind === "file") {
      try {
        if (current.byteLength === null) gaps.push(`changed file has no captured byte length: ${path}`);
        else artifactId = capture(regularBytes(absolute, current), "application/octet-stream", `changed file ${path}`)?.artifactId ?? null;
      } catch (error) { gaps.push(`changed file could not be captured: ${path}: ${String(error)}`); }
    } else if (current.kind === "symlink" || current.kind === "other") {
      gaps.push(`changed non-regular path cannot be accepted as complete file evidence: ${path}`);
    }
    changes.push({ path, change, before: prior, after: current, artifact_id: artifactId, declared });
  }
  if (gaps.length && reportValidity === "valid") reportValidity = "invalid";
  const manifest = {
    task_id: taskId, execution_id: executionId, workspace,
    starting_state_sha256: baseline.sha256,
    baseline_index_complete: initial?.complete ?? false,
    final_index_complete: final.complete,
    tracked_diff_to_head_sha256: tracked ? sha(tracked) : null,
    staged_diff_sha256: staged ? sha(staged) : null,
    changes, coverage_limits: [...new Set([...(baseline.coverageLimits ?? []), ...final.coverageLimits])],
    report_validity: reportValidity,
    snapshot_bytes: captured.reduce((sum, artifact) => sum + artifact.byteLength, 0),
    snapshot_limit_bytes: maxSnapshotBytes,
    artifacts: captured.map(({ artifactId, sha256, byteLength, mediaType }) =>
      ({ artifact_id: artifactId, sha256, byte_length: byteLength, media_type: mediaType })), gaps,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestEntry = capture(manifestBytes, "application/json", "final change manifest");
  if (!manifestEntry) reportValidity = "invalid";
  return { reportValidity, finalManifestHash: manifestEntry ? sha(manifestBytes) : null, artifacts: captured, gaps };
}
