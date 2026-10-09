import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectLegacyJob } from "../legacy.js";

test("v1 zero exit remains operational evidence with parent review pending", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-legacy-"));
  try {
    writeFileSync(join(dir, "job.json"), JSON.stringify({ schema_version: 1, cwd: "/old/workspace", command: ["opencode", "run", "--model", "old/model"], task_sha256: "a".repeat(64) }));
    writeFileSync(join(dir, "exit.json"), JSON.stringify({ schema_version: 1, state: "exited", returncode: 0, session_ids: ["ses_old"] }));
    const result = inspectLegacyJob(dir);
    assert.equal(result.operational.terminal, true);
    assert.equal(result.operational.returnCode, 0);
    assert.equal(result.parentReview, "pending");
    assert.equal(result.job.model, "old/model");
    assert.equal(result.records.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing or malformed exit never establishes a terminal outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-legacy-"));
  try {
    writeFileSync(join(dir, "job.json"), JSON.stringify({ pid: 12345 }));
    assert.equal(inspectLegacyJob(dir).operational.state, "unreconciled");
    writeFileSync(join(dir, "exit.json"), "{bad");
    const result = inspectLegacyJob(dir);
    assert.equal(result.operational.terminal, false);
    assert.ok(result.warnings.some((warning) => warning.includes("malformed exit")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("symlinked v1 records are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agents-legacy-"));
  try {
    writeFileSync(join(dir, "source.json"), "{}");
    symlinkSync(join(dir, "source.json"), join(dir, "job.json"));
    assert.throws(() => inspectLegacyJob(dir), /not a regular file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
