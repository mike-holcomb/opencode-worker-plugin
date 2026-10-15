#!/usr/bin/env node
/** Exercise a relocated, read-only v2 bundle without live inference. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBundleZip } from "./lib/zip.mjs";

function assert(condition, message) { if (!condition) throw new Error(message); }

function walk(directory, visit) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const metadata = statSync(path);
    visit(path, metadata);
    if (metadata.isDirectory()) walk(path, visit);
  }
}

function filesDigest(root) {
  const result = new Map();
  walk(root, (path, metadata) => {
    if (metadata.isFile()) result.set(relative(root, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
  });
  return result;
}

function verifyRelease(archive) {
  const manifestPath = `${archive}.manifest.json`;
  const checksumPath = `${archive}.sha256`;
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const archiveBytes = readFileSync(archive);
  const manifestBytes = readFileSync(manifestPath);
  const expected = `${sha(archiveBytes)}  ${basename(archive)}\n` +
    `${sha(manifestBytes)}  ${basename(manifestPath)}\n`;
  assert(readFileSync(checksumPath, "utf8") === expected, "release checksum sidecar differs");
  const manifest = JSON.parse(manifestBytes);
  assert(manifest.schema_version === 1 && manifest.archive?.name === basename(archive) &&
    manifest.archive.sha256 === sha(archiveBytes) && manifest.archive.byte_length === archiveBytes.length,
    "release manifest archive differs");
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, "release manifest has no files");
  let previous = "";
  for (const file of manifest.files) {
    assert(typeof file.path === "string" && file.path.startsWith("opencode-agents/") &&
      file.path > previous && /^[a-f0-9]{64}$/.test(file.sha256) &&
      Number.isSafeInteger(file.byte_length) && file.byte_length >= 0, "invalid release file entry");
    previous = file.path;
  }
  return manifest;
}

function verifyExtractedFiles(plugin, manifest) {
  const actual = filesDigest(plugin);
  assert(actual.size === manifest.files.length, "extracted release file count differs");
  for (const file of manifest.files) {
    const name = file.path.slice("opencode-agents/".length);
    assert(actual.get(name) === file.sha256 && statSync(join(plugin, name)).size === file.byte_length,
      `extracted release file differs: ${name}`);
  }
}

function setReadOnly(root) {
  walk(root, (path, metadata) => chmodSync(path, metadata.isDirectory() ? 0o555 : 0o444));
  chmodSync(root, 0o555);
}

function setWritable(root) {
  if (!existsSync(root)) return;
  chmodSync(root, 0o755);
  walk(root, (path, metadata) => chmodSync(path, metadata.isDirectory() ? 0o755 : 0o644));
}

function run(node, args, options, timeout = 15_000) {
  const result = spawnSync(node, args, { ...options, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`command failed (${result.status ?? result.signal}): ${String(result.error ?? result.stderr).slice(0, 500)}`);
  return result.stdout;
}

function mcpClient(child) {
  const pending = new Map();
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2_000); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); }
      catch { continue; }
      const waiting = pending.get(message.id);
      if (waiting) { pending.delete(message.id); waiting.resolve(message); }
    }
  });
  child.on("exit", (code) => {
    for (const waiting of pending.values()) waiting.reject(new Error(`MCP closed (${code}): ${stderr}`));
    pending.clear();
  });
  return {
    notify(method) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`); },
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP response ${id} timed out: ${stderr}`)); }, 10_000);
        pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); } });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), 5_000);
  })]);
  clearTimeout(timer);
  if (stopped) return;
  child.kill("SIGKILL");
  await exited;
}

export async function smoke(archive, node = process.execPath) {
  const release = verifyRelease(archive);
  // macOS has a short Unix-socket path limit; the normal per-user tmpdir is
  // long enough to make the supervisor socket fail before MCP initializes.
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const base = mkdtempSync(join(temporaryRoot, "oa smoke "));
  const installation = join(base, "read only plugin with spaces");
  const plugin = join(installation, "opencode-agents");
  const unrelated = join(base, "unrelated cwd with spaces");
  const state = join(base, "private state with spaces");
  let child;
  try {
    mkdirSync(installation);
    extractBundleZip(archive, installation);
    verifyExtractedFiles(plugin, release);
    mkdirSync(unrelated);
    const env = { ...process.env, OPENCODE_AGENTS_STATE_DIR: state };
    delete env.OPENCODE_AGENTS_CONFIG;
    setReadOnly(plugin);
    const before = filesDigest(plugin);
    const executable = join(plugin, "bin", "opencode-agents.mjs");
    const diagnostic = JSON.parse(run(node, [executable, "doctor"], { cwd: unrelated, env }));
    assert(String(diagnostic.runtime?.toolkit).startsWith("2."), "wrong bundled toolkit version");
    assert(diagnostic.configuration?.status === "missing", "smoke unexpectedly loaded external configuration");
    const manifest = JSON.parse(readFileSync(join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
    assert(manifest.mcpServers === "./.mcp.json", "manifest MCP path changed");
    const servers = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8")).mcpServers;
    assert(Object.keys(servers).length === 1, "MCP config must declare exactly one server");
    const server = Object.values(servers)[0];
    assert(server.command === "node" && server.cwd === "./" &&
      JSON.stringify(server.args) === JSON.stringify(["./bin/opencode-agents.mjs", "mcp"]), "MCP launch contract changed");
    child = spawn(node, server.args, { cwd: plugin, env, stdio: ["pipe", "pipe", "pipe"] });
    const client = mcpClient(child);
    const initialized = await client.request(1, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "installed-smoke", version: "1" },
    });
    assert(!initialized.error, `MCP initialize failed: ${JSON.stringify(initialized.error)}`);
    client.notify("notifications/initialized");
    const listed = await client.request(2, "tools/list", {});
    assert(!listed.error, `MCP tools/list failed: ${JSON.stringify(listed.error)}`);
    const names = new Set(listed.result.tools.map((tool) => tool.name));
    assert(names.size === 11 && names.has("opencode_get_progress") && names.has("opencode_start_task") && names.has("opencode_record_review"),
      "bundled MCP tools do not match v2 surface");
    await stopChild(child);
    child = null;
    run(node, [executable, "daemon", "stop"], { cwd: unrelated, env }, 10_000);
    assert(JSON.stringify([...filesDigest(plugin)]) === JSON.stringify([...before]), "installed bundle was modified");
    assert(readdirSync(unrelated).length === 0, "runtime wrote into caller's working directory");
    return { tool_count: names.size, node: diagnostic.runtime.node,
      bundle_unchanged: true, state_outside_bundle: existsSync(state) };
  } finally {
    if (child) await stopChild(child);
    setWritable(plugin);
    rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, ...rest] = process.argv.slice(2);
  const nodeIndex = rest.indexOf("--node");
  if (!archive || (rest.length && (nodeIndex !== 0 || rest.length !== 2))) {
    process.stderr.write("Usage: node scripts/smoke_installed_bundle.mjs ZIP [--node NODE]\n");
    process.exitCode = 2;
  } else {
    smoke(resolve(archive), nodeIndex >= 0 ? rest[1] : process.execPath)
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 2; });
  }
}
