import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../artifacts.js";

test("artifact registration precedes publication and content is immutable", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-artifacts-"));
  try {
    const store = new ArtifactStore(root);
    let registrationSawFinalFile = false;
    const entry = store.captureBytes("exec-1", Buffer.from("hello world"), "text/plain", (value) => {
      registrationSawFinalFile = requireExists(value.path);
    });
    assert.equal(registrationSawFinalFile, false);
    assert.equal(readFileSync(entry.path, "utf8"), "hello world");
    const first = store.read(entry, 0, 5);
    assert.equal(Buffer.from(first.bytes).toString(), "hello");
    assert.equal(first.nextOffset, 5);
    writeFileSync(entry.path, "changed");
    assert.throws(() => store.read(entry), /artifact changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed registration leaves no staged bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-artifacts-"));
  try {
    const store = new ArtifactStore(root);
    assert.throws(() => store.captureBytes("exec-1", Buffer.from("body"), "text/plain", () => { throw new Error("db unavailable"); }), /db unavailable/);
    assert.deepEqual(store.stagedFiles(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup reconciles a committed staged artifact and removes an unregistered orphan", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-agents-artifacts-"));
  try {
    const store = new ArtifactStore(root);
    const bytes = Buffer.from("committed before rename");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const entry = { artifactId: "artifact_registered", executionId: "exec-1", sha256,
      byteLength: bytes.length, mediaType: "text/plain", path: join(root, "objects", sha256) };
    writeFileSync(join(root, "staging", `${entry.artifactId}.tmp`), bytes);
    writeFileSync(join(root, "staging", "artifact_orphan.tmp"), "orphan");
    const result = store.reconcile((id) => id === entry.artifactId ? entry : null);
    assert.deepEqual(result.published, [entry.artifactId]);
    assert.deepEqual(result.removed, ["artifact_orphan"]);
    assert.equal(readFileSync(entry.path, "utf8"), bytes.toString());
    assert.deepEqual(store.stagedFiles(), []);
    rmSync(entry.path);
    assert.throws(() => store.reconcile(() => null, [entry]), /registered artifact is missing or changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function requireExists(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}
