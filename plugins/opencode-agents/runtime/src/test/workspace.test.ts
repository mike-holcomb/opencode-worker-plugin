import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalWorkspace, captureBaseline, compareBaseline, WorkspaceError } from "../workspace.js";

test("declared mutable input and dirty Git state become stale after changes", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-workspace-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  try {
    execFileSync("git", ["-C", workspace, "init", "-q"]);
    execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", workspace, "config", "user.name", "Test"]);
    writeFileSync(join(workspace, "tracked.txt"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "tracked.txt"]);
    execFileSync("git", ["-C", workspace, "commit", "-qm", "base"]);
    writeFileSync(join(workspace, "tracked.txt"), "dirty\n");
    writeFileSync(join(workspace, "declared.txt"), "untracked input\n");
    writeFileSync(join(workspace, "out.txt"), "pre-existing output\n");
    const baseline = captureBaseline({ workspace, projectRoots: [root], packet: {
      authoritative_inputs: [{ reference: "declared.txt", kind: "file", purpose: "Source" }],
      allowed_writes: [{ path: "out.txt", kind: "file", purpose: "Output" }],
    } });
    assert.equal(baseline.files[0]?.untracked, true);
    assert.ok(baseline.git);
    assert.equal(compareBaseline(baseline).fresh, true);
    writeFileSync(join(workspace, "declared.txt"), "changed\n");
    assert.deepEqual(compareBaseline(baseline).changed, [realpathSync(join(workspace, "declared.txt"))]);
    writeFileSync(join(workspace, "tracked.txt"), "dirty again\n");
    assert.ok(compareBaseline(baseline).changed.includes("git:tracked-diff"));
    writeFileSync(join(workspace, "out.txt"), "external change\n");
    assert.ok(compareBaseline(baseline).changed.includes(realpathSync(join(workspace, "out.txt"))));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical root validation rejects symlink escapes and non-Git manifests state their bounds", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-workspace-"));
  const project = join(root, "project");
  const outside = mkdtempSync(join(tmpdir(), "opencode-agents-outside-"));
  mkdirSync(project);
  try {
    symlinkSync(outside, join(project, "escape"));
    assert.equal(canonicalWorkspace(project, [root]), realpathSync(project));
    assert.throws(() => captureBaseline({ workspace: project, projectRoots: [root], packet: {
      authoritative_inputs: [], allowed_writes: [{ path: "escape/file.txt", kind: "file", purpose: "Write" }],
    } }), (error) => error instanceof WorkspaceError && error.code === "OUTSIDE_CONFIGURED_ROOT");
    const manifest = captureBaseline({ workspace: project, projectRoots: [root], packet: { authoritative_inputs: [], allowed_writes: [] } });
    assert.equal(manifest.git, null);
    assert.ok(manifest.coverageLimits.some((limit) => limit.includes("Non-Git")));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
