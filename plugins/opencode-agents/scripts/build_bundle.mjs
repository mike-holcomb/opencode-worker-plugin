#!/usr/bin/env node
/** Deterministic, allowlisted v2 plugin ZIP builder. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  writeFileSync, linkSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { deterministicZip } from "./lib/zip.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestName = ".codex-plugin/plugin.json";
const requiredV2 = new Set([
  ".mcp.json", "bin/opencode-agents.mjs", "bin/opencode-agents.mjs.LEGAL.txt",
  "bin/THIRD_PARTY_LICENSES.txt", "compatibility.json", "runtime/package-lock.json",
  "schemas/task-packet.schema.json", "schemas/worker-report.schema.json",
  "schemas/review.schema.json", "worker/bounded-build.md", "worker/bounded-inspect.md",
]);

export class BundleError extends Error {}
function fail(message) { throw new BundleError(message); }
function stat(path) { try { return lstatSync(path); } catch { return null; } }

function canonicalAllowlistPath(raw, line) {
  const value = raw.trim();
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === ".."))
    fail(`bundle-files.txt:${line}: unsafe path ${JSON.stringify(value)}`);
  return value;
}

function localReference(raw, description) {
  const value = raw.trim();
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") ||
    value.split("/").some((part) => part === "..")) fail(`${description}: unsafe path ${JSON.stringify(value)}`);
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (!parts.length) fail(`${description}: empty path`);
  return parts.join("/");
}

function checkedPath(root, name, description) {
  let current = root;
  for (const component of name.split("/")) {
    current = join(current, component);
    if (stat(current)?.isSymbolicLink()) fail(`${description}: symlink is not allowed: ${name}`);
  }
  return current;
}

function listedFiles(root) {
  const list = checkedPath(root, "bundle-files.txt", "allowlist");
  if (!stat(list)?.isFile()) fail(`missing allowlist: ${list}`);
  const entries = new Map();
  for (const [index, line] of readFileSync(list, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const name = canonicalAllowlistPath(line, index + 1);
    if (entries.has(name)) fail(`bundle-files.txt:${index + 1}: duplicate path ${JSON.stringify(name)}`);
    if (name.split("/").at(-2) === "__pycache__" && name.endsWith(".pyc"))
      fail(`generated Python cache must not be listed: ${name}`);
    const path = checkedPath(root, name, `allowlist entry ${JSON.stringify(name)}`);
    const metadata = stat(path);
    if (!metadata) fail(`allowlist entry is missing: ${name}`);
    if (!metadata.isFile()) fail(`allowlist entry is not a regular file: ${name}`);
    entries.set(name, path);
  }
  return entries;
}

function manifestSkills(root, entries) {
  if (!entries.has(manifestName)) fail(`manifest is not listed in bundle-files.txt: ${manifestName}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(entries.get(manifestName), "utf8")); }
  catch (error) { fail(`invalid plugin manifest: ${error}`); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    fail("plugin manifest must contain a JSON object");
  const declared = typeof manifest.skills === "string" ? [manifest.skills] : manifest.skills;
  if (!Array.isArray(declared) || !declared.every((item) => typeof item === "string"))
    fail("plugin manifest skills must be a path or list of paths");
  const roots = declared.map((item) => {
    const name = localReference(item, "plugin manifest skills path");
    if (!stat(checkedPath(root, name, "plugin manifest skills path"))?.isDirectory())
      fail(`plugin manifest skills path is not a directory: ${name}`);
    return name;
  });
  return { manifest, roots };
}

function walkRuntime(root, directory, entries) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const relativeName = relative(root, path).split(sep).join("/");
    const metadata = stat(path);
    if (metadata?.isSymbolicLink()) fail(`runtime resource is a symlink: ${relativeName}`);
    if (metadata?.isDirectory()) {
      if (name !== "__pycache__") walkRuntime(root, path, entries);
    } else if (metadata?.isFile()) {
      if (dirname(relativeName).endsWith("__pycache__") && name.endsWith(".pyc")) continue;
      if (!entries.has(relativeName)) fail(`runtime resource is not listed: ${relativeName}`);
    } else fail(`runtime resource is not a regular file or directory: ${relativeName}`);
  }
}

function validateV2(root, entries, manifest) {
  if (!String(manifest.version ?? "").startsWith("2.")) fail("plugin manifest must declare v2");
  const missing = [...requiredV2].filter((name) => !entries.has(name)).sort();
  if (missing.length) fail(`v2 runtime assets are not listed: ${missing.join(", ")}`);
  if (manifest.mcpServers !== "./.mcp.json") fail("v2 manifest must reference ./.mcp.json");
  let servers;
  try { servers = JSON.parse(readFileSync(entries.get(".mcp.json"), "utf8")).mcpServers; }
  catch (error) { fail(`invalid v2 MCP config: ${error}`); }
  if (!servers || typeof servers !== "object" || Array.isArray(servers) || Object.keys(servers).length !== 1)
    fail("v2 MCP config must declare exactly one server");
  const server = Object.values(servers)[0];
  if (!server || server.command !== "node" || server.cwd !== "./" ||
    JSON.stringify(server.args) !== JSON.stringify(["./bin/opencode-agents.mjs", "mcp"]))
    fail("v2 MCP server must launch the bundled runtime from the plugin root");
}

function linkPath(source, raw) {
  let target;
  try { target = decodeURIComponent(raw); }
  catch { fail(`unsafe local Markdown link in ${source}: ${raw}`); }
  if (target.includes("\0") || target.includes("\\") || target.startsWith("/"))
    fail(`unsafe local Markdown link in ${source}: ${target}`);
  const components = source.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!components.length) fail(`local Markdown link escapes bundle in ${source}: ${target}`);
      components.pop();
    } else components.push(part);
  }
  if (!components.length) fail(`empty local Markdown link in ${source}`);
  return components.join("/");
}

function validateLinks(root, entries) {
  for (const [source, path] of entries) {
    if (!source.toLowerCase().endsWith(".md")) continue;
    const text = readFileSync(path, "utf8");
    const regex = /\[[^\]\n]*\]\(([^)\n]+)\)/g;
    let match;
    while ((match = regex.exec(text))) {
      if (match.index > 0 && text[match.index - 1] === "!") continue;
      const raw = match[1].trim();
      const target = raw.startsWith("<") ? raw.slice(1, raw.indexOf(">")) : raw.split(/\s+/, 1)[0];
      if (target.startsWith("#") || target.startsWith("//") || /^[A-Za-z][\w+.-]*:/.test(target)) continue;
      const pathname = target.split(/[?#]/, 1)[0];
      if (!pathname) continue;
      const relativeName = linkPath(source, pathname);
      if (!stat(checkedPath(root, relativeName, `Markdown link from ${source}`))?.isFile())
        fail(`Markdown link target is not a file: ${source} -> ${relativeName}`);
      if (!entries.has(relativeName)) fail(`Markdown link target is not listed: ${source} -> ${relativeName}`);
    }
  }
}

export function validateBundle(root = pluginRoot) {
  root = realpathSync(root);
  if (!stat(root)?.isDirectory()) fail(`bundle root is not a directory: ${root}`);
  const entries = listedFiles(root);
  const { manifest, roots } = manifestSkills(root, entries);
  for (const skill of roots) walkRuntime(root, checkedPath(root, skill, "runtime skills"), entries);
  validateV2(root, entries, manifest);
  validateLinks(root, entries);
  return entries;
}

function verifyCompiledBundle(root) {
  const runtime = join(root, "runtime");
  if (!stat(join(runtime, "src", "cli.ts"))) return; // Minimal test fixtures have no source tree.
  let buildSync;
  try { ({ buildSync } = createRequire(join(runtime, "package.json"))("esbuild")); }
  catch (error) { fail(`local esbuild is required to verify the compiled runtime: ${error.message}`); }
  const output = join(root, "bin", "opencode-agents.mjs");
  let generated;
  try {
    generated = buildSync({
      entryPoints: [join(runtime, "src", "cli.ts")], outfile: output,
      absWorkingDir: runtime, bundle: true, platform: "node", format: "esm", target: "node24",
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
      legalComments: "external", write: false,
    }).outputFiles;
  } catch (error) { fail(`compiled runtime verification failed: ${error.message}`); }
  for (const file of generated) {
    if (!stat(file.path)?.isFile() || Buffer.compare(file.contents, readFileSync(file.path)) !== 0)
      fail(`compiled runtime is stale: ${relative(root, file.path)}; run npm run bundle in runtime/`);
  }
}

function canonicalOutput(output) {
  let ancestor = dirname(output);
  const remaining = [];
  while (!existsSync(ancestor)) { remaining.unshift(ancestor.split(sep).at(-1)); ancestor = dirname(ancestor); }
  return join(realpathSync(ancestor), ...remaining, output.split(sep).at(-1));
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function sameFile(left, right) {
  const a = stat(left);
  const b = stat(right);
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

export function buildBundle(root, output, { link = linkSync } = {}) {
  const entries = validateBundle(root);
  verifyCompiledBundle(realpathSync(root));
  if (!isAbsolute(output)) fail("--out must be an absolute path");
  const target = canonicalOutput(resolve(output));
  const manifestPath = `${target}.manifest.json`;
  const checksumPath = `${target}.sha256`;
  for (const path of [target, manifestPath, checksumPath])
    if (stat(path)) fail(`output already exists: ${path}`);
  const skills = join(realpathSync(root), "skills");
  if (target === skills || target.startsWith(skills + sep)) fail("output cannot be inside runtime skills");
  mkdirSync(dirname(target), { recursive: true });
  const files = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, path]) => [name, readFileSync(path)]);
  const archive = deterministicZip(files);
  const archiveSha256 = sha256(archive);
  const manifestBytes = Buffer.from(`${JSON.stringify({ schema_version: 1,
    archive: { name: basename(target), sha256: archiveSha256, byte_length: archive.byteLength },
    files: files.map(([name, bytes]) => ({ path: `opencode-agents/${name}`,
      sha256: sha256(bytes), byte_length: bytes.byteLength })) }, null, 2)}\n`);
  const checksumBytes = Buffer.from(`${archiveSha256}  ${basename(target)}\n` +
    `${sha256(manifestBytes)}  ${basename(manifestPath)}\n`);
  const outputs = [[manifestPath, manifestBytes], [checksumPath, checksumBytes], [target, archive]];
  const staged = [];
  const published = [];
  try {
    for (const [path, bytes] of outputs) {
      const temporary = join(dirname(target), `.${basename(path)}.${randomUUID()}.tmp`);
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      staged.push([temporary, path]);
    }
    for (const [temporary, path] of staged) {
      try { link(temporary, path); }
      catch (error) {
        if (error?.code === "EEXIST") fail(`output was created during build: ${path}`);
        throw error;
      }
      published.push([temporary, path]);
    }
  } catch (error) {
    for (const [temporary, path] of published) if (sameFile(temporary, path)) unlinkSync(path);
    throw error;
  } finally {
    for (const [temporary] of staged) if (stat(temporary)) unlinkSync(temporary);
  }
  return { output: target, manifestPath, checksumPath, archiveSha256, count: entries.size };
}

function main(args) {
  let check = false;
  let output;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--check") check = true;
    else if (args[index] === "--out" && args[index + 1]) output = args[++index];
    else fail("usage: node scripts/build_bundle.mjs [--check] [--out ABSOLUTE_ZIP]");
  }
  if (check) {
    const entries = validateBundle();
    verifyCompiledBundle(pluginRoot);
    process.stdout.write(`Bundle check passed: ${entries.size} files\n`);
    return;
  }
  if (!output) fail("--out is required when building an archive");
  const result = buildBundle(pluginRoot, output);
  process.stdout.write(`Wrote ${result.output} (${result.count} files)\n` +
    `Manifest: ${result.manifestPath}\nChecksums: ${result.checksumPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 2; }
}
