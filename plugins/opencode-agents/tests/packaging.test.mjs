import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
  linkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildBundle, validateBundle, BundleError } from "../scripts/build_bundle.mjs";
import { extractBundleZip } from "../scripts/lib/zip.mjs";
import { smoke } from "../scripts/smoke_installed_bundle.mjs";

const required = [
  ".mcp.json", "bin/opencode-agents.mjs", "bin/opencode-agents.mjs.LEGAL.txt",
  "bin/THIRD_PARTY_LICENSES.txt", "compatibility.json", "runtime/package-lock.json",
  "schemas/task-packet.schema.json", "schemas/worker-report.schema.json",
  "schemas/review.schema.json", "worker/bounded-build.md", "worker/bounded-inspect.md",
];

function fixture(parent) {
  const root = join(parent, "standalone fixture");
  mkdirSync(root, { recursive: true });
  const files = new Map([
    [".codex-plugin/plugin.json", JSON.stringify({ name: "fixture", version: "2.0.0-test",
      skills: "./skills/", mcpServers: "./.mcp.json" })],
    [".mcp.json", JSON.stringify({ mcpServers: { fixture: { command: "node", cwd: "./",
      args: ["./bin/opencode-agents.mjs", "mcp"] } } })],
    ["skills/opencode-agents/SKILL.md", "# Fixture\n\n[Task](assets/task.md)\n[Operations](references/operations.md)\n"],
    ["skills/opencode-agents/assets/task.md", "synthetic task\n"],
    ["skills/opencode-agents/references/operations.md", "synthetic operations\n"],
  ]);
  for (const name of required) if (!files.has(name)) files.set(name, `fixture ${name}\n`);
  files.set("bundle-files.txt", [...files.keys(), "bundle-files.txt"].sort().join("\n") + "\n");
  for (const [name, content] of files) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function withFixture(run) {
  const parent = mkdtempSync(join(tmpdir(), "oa-package-test-"));
  try { return run(fixture(parent), parent); }
  finally { rmSync(parent, { recursive: true, force: true }); }
}

function appendList(root, entry) {
  const list = join(root, "bundle-files.txt");
  writeFileSync(list, readFileSync(list, "utf8") + `${entry}\n`);
}

test("Node bundle check is read-only, sorted, deterministic, and excludes unlisted files", () => {
  const parent = mkdtempSync(join(tmpdir(), "oa-package-determinism-"));
  try {
    const first = fixture(join(parent, "first"));
    const second = fixture(join(parent, "second"));
    writeFileSync(join(first, "local-secret.txt"), "MUST_NOT_SHIP\n");
    assert.equal(validateBundle(first).size, validateBundle(second).size);
    mkdirSync(join(parent, "release-one"));
    mkdirSync(join(parent, "release-two"));
    const firstZip = join(parent, "release-one", "bundle.zip");
    const secondZip = join(parent, "release-two", "bundle.zip");
    buildBundle(first, firstZip);
    buildBundle(second, secondZip);
    assert.deepEqual(readFileSync(firstZip), readFileSync(secondZip));
    assert.deepEqual(readFileSync(`${firstZip}.manifest.json`), readFileSync(`${secondZip}.manifest.json`));
    assert.deepEqual(readFileSync(`${firstZip}.sha256`), readFileSync(`${secondZip}.sha256`));
    const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const manifestBytes = readFileSync(`${firstZip}.manifest.json`);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.schema_version, 1);
    assert.deepEqual(manifest.archive, { name: "bundle.zip", sha256: sha(readFileSync(firstZip)),
      byte_length: readFileSync(firstZip).length });
    assert.deepEqual(manifest.files.map((file) => file.path),
      [...validateBundle(first).keys()].sort().map((name) => `opencode-agents/${name}`));
    for (const file of manifest.files) {
      const bytes = readFileSync(join(first, file.path.slice("opencode-agents/".length)));
      assert.deepEqual({ sha256: file.sha256, byte_length: file.byte_length },
        { sha256: sha(bytes), byte_length: bytes.length });
    }
    assert.equal(readFileSync(`${firstZip}.sha256`, "utf8"),
      `${sha(readFileSync(firstZip))}  bundle.zip\n${sha(manifestBytes)}  bundle.zip.manifest.json\n`);
    const extracted = join(parent, "extracted with spaces");
    assert.equal(extractBundleZip(firstZip, extracted), validateBundle(first).size);
    assert.equal(readdirSync(join(extracted, "opencode-agents")).includes("local-secret.txt"), false);
    const bytes = readFileSync(firstZip);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(bytes.readUInt16LE(10), 0);
    assert.equal(bytes.readUInt16LE(12), 0x21);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("the shipped v2 source bundle passes the Node allowlist check", () => {
  assert.ok(validateBundle().size >= 50);
  const bin = readFileSync(new URL("../bin/opencode-agents.mjs", import.meta.url), "utf8");
  for (const symbol of ["prepareLegacyImport", "inspectLegacyJob", "migrate-v1", "migrate_v1",
    "importLegacy", "legacy_imports"]) assert.equal(bin.includes(symbol), false, `v1 symbol in bundled bin: ${symbol}`);
});

test("release build rejects a stale compiled runtime", () => {
  withFixture((root, parent) => {
    const source = join(root, "runtime", "src", "cli.ts");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'process.stdout.write("fresh runtime\\n");\n');
    symlinkSync(new URL("../runtime/node_modules", import.meta.url).pathname,
      join(root, "runtime", "node_modules"), "dir");
    assert.throws(() => buildBundle(root, join(parent, "stale.zip")), /compiled runtime is stale/);
    assert.equal(existsSync(join(parent, "stale.zip")), false);
  });
});

test("allowlist rejects duplicate, traversal, missing, and directory entries", () => {
  for (const [entry, pattern] of [
    ["skills/opencode-agents/SKILL.md", /duplicate/], ["../outside.txt", /unsafe/],
    ["missing.txt", /missing/], ["skills/opencode-agents", /not a regular file/],
  ]) withFixture((root) => {
    appendList(root, entry);
    assert.throws(() => validateBundle(root), pattern);
  });
});

test("allowlist and skill tree reject symlinks and unlisted runtime files", () => {
  withFixture((root) => {
    symlinkSync(join(root, "bundle-files.txt"), join(root, "linked.txt"));
    appendList(root, "linked.txt");
    assert.throws(() => validateBundle(root), /symlink/);
  });
  withFixture((root) => {
    writeFileSync(join(root, "skills/opencode-agents/references/unlisted.md"), "extra");
    assert.throws(() => validateBundle(root), /runtime resource is not listed/);
  });
});

test("v2 manifest, MCP launch, and Markdown link targets must be bundled", () => {
  withFixture((root) => {
    const list = join(root, "bundle-files.txt");
    writeFileSync(list, readFileSync(list, "utf8").replace("bin/opencode-agents.mjs\n", ""));
    assert.throws(() => validateBundle(root), /v2 runtime assets are not listed/);
  });
  withFixture((root) => {
    const manifest = join(root, ".codex-plugin/plugin.json");
    const data = JSON.parse(readFileSync(manifest, "utf8"));
    data.skills = "./missing/";
    writeFileSync(manifest, JSON.stringify(data));
    assert.throws(() => validateBundle(root), /skills path/);
  });
  withFixture((root) => {
    const skill = join(root, "skills/opencode-agents/SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8") + "[Missing](references/missing.md)\n");
    assert.throws(() => validateBundle(root), /Markdown link/);
  });
});

test("existing output, output inside skill tree, and destination race never clobber", () => {
  withFixture((root, parent) => {
    const existing = join(parent, "existing.zip");
    writeFileSync(existing, "already here");
    assert.throws(() => buildBundle(root, existing), /already exists/);
    assert.equal(readFileSync(existing, "utf8"), "already here");
    for (const suffix of [".manifest.json", ".sha256"]) {
      const path = join(parent, `sidecar${suffix}`);
      writeFileSync(path, "already here");
      assert.throws(() => buildBundle(root, join(parent, "sidecar")), /already exists/);
      assert.equal(readFileSync(path, "utf8"), "already here");
      assert.equal(existsSync(join(parent, "sidecar")), false);
      rmSync(path);
    }
    assert.throws(() => buildBundle(root, join(root, "skills", "inside.zip")), /inside runtime skills/);
    const raced = join(parent, "race.zip");
    assert.throws(() => buildBundle(root, raced, { link(temp, target) {
      if (target.endsWith("/race.zip")) writeFileSync(target, "created concurrently");
      linkSync(temp, target);
    } }), /created during build/);
    assert.equal(readFileSync(raced, "utf8"), "created concurrently");
    assert.equal(existsSync(`${raced}.manifest.json`), false);
    assert.equal(existsSync(`${raced}.sha256`), false);
    assert.deepEqual(readdirSync(parent).filter((name) => name.startsWith(".race.zip.") && name.endsWith(".tmp")), []);
  });
});

test("ZIP extraction rejects modified entry names before writing files", () => {
  withFixture((root, parent) => {
    const zip = join(parent, "clean.zip");
    buildBundle(root, zip);
    const bytes = readFileSync(zip);
    const name = Buffer.from("opencode-agents/bundle-files.txt");
    const unsafe = Buffer.from("opencode-agents/../escape.txtxxx");
    assert.equal(name.length, unsafe.length);
    let changes = 0;
    for (let index = 0; index <= bytes.length - name.length; index++) {
      if (!bytes.subarray(index, index + name.length).equals(name)) continue;
      unsafe.copy(bytes, index);
      changes++;
    }
    assert.equal(changes, 2);
    const malicious = join(parent, "malicious.zip");
    writeFileSync(malicious, bytes);
    assert.throws(() => extractBundleZip(malicious, join(parent, "target")), /unsafe ZIP entry path/);
  });
});

test("installed smoke rejects a changed archive before extraction or execution", async () => {
  const parent = mkdtempSync(join(tmpdir(), "oa-release-check-test-"));
  try {
    const root = fixture(parent);
    const zip = join(parent, "release.zip");
    buildBundle(root, zip);
    writeFileSync(zip, Buffer.concat([readFileSync(zip), Buffer.from("tampered")]));
    await assert.rejects(smoke(zip), /release checksum sidecar differs/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
