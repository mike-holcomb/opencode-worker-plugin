import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

const stages = ["starting", "investigating", "implementing", "verifying", "preparing_report", "blocked"];
const text = (limit: number) => ({ type: "string", minLength: 1, maxLength: limit });
const list = (limit: number) => ({ type: "array", maxItems: 5, items: text(limit) });
const args = { stage: { type: "string", enum: stages }, summary: text(600), completed: list(200), remaining: list(200),
  blocker: { anyOf: [{ type: "null" }, { type: "object", properties: { summary: text(400), request_id: text(128) }, required: ["summary"], additionalProperties: false }] }, evidence_refs: list(128) };

/** No imports or dependency resolution: OpenCode accepts legacy JSON Schema argument definitions. */
export function createProgressToolAsset(): string {
  return `const stages = ${JSON.stringify(stages)};
const keys = ['stage','summary','completed','remaining','blocker','evidence_refs'];
function object(value, allowed, required, name) {
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)) || required.some(k=>!Object.hasOwn(value,k))) throw new Error(name+': expected exactly the documented checkpoint fields');
}
function text(value, limit, name) { if(typeof value!=='string'||value.length<1||value.length>limit) throw new Error(name+': expected 1..'+limit+' characters'); }
function list(value, limit, name) { if(!Array.isArray(value)||value.length>5)throw new Error(name+': expected at most five entries'); for(const item of value)text(item,limit,name); }
export default {
 description: 'Publish a short milestone or blocker transition. Claims are advisory; this tool cannot control execution or replace a permission request. Avoid credentials, raw commands/results, source excerpts, and hidden reasoning.',
 args: ${JSON.stringify(args)},
 async execute(input) {
  object(input,keys,keys,'checkpoint');
  if(!stages.includes(input.stage))throw new Error('stage: expected a documented generic stage');
  text(input.summary,600,'summary'); list(input.completed,200,'completed');list(input.remaining,200,'remaining');list(input.evidence_refs,128,'evidence_refs');
  if(input.blocker!==null){object(input.blocker,['summary','request_id'],['summary'],'blocker');text(input.blocker.summary,400,'blocker.summary');if(Object.hasOwn(input.blocker,'request_id'))text(input.blocker.request_id,128,'blocker.request_id');}
  if(Buffer.byteLength(JSON.stringify(input),'utf8')>4096)throw new Error('checkpoint: exceeds 4096 UTF-8 bytes; submit fewer/shorter entries');
  return {output:'Checkpoint emitted; supervisor ingestion is asynchronous.',title:'Worker progress',metadata:{opencode_agents_progress:JSON.parse(JSON.stringify(input))}};
 }
};\n`;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const privateDirectories = ["tool", "home", "home/.opencode", "config", "config/opencode"];
const ignored = "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n";

export function assertProgressTool(directory: string, expectedSha256: string): void {
  const walk = (path: string, relative = "") => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`progress tool symlink: ${relative}`);
    if (!info.isDirectory()) throw new Error(`progress configuration is not a directory: ${relative}`);
    for (const entry of readdirSync(path)) {
      const name = relative ? `${relative}/${entry}` : entry;
      const child = join(path, entry);
      if (lstatSync(child).isSymbolicLink()) throw new Error(`progress tool symlink: ${name}`);
      if (privateDirectories.includes(name)) { walk(child, name); continue; }
      const expected = name === "package.json" ? '{"type":"module"}\n'
        : [".gitignore", "home/.opencode/.gitignore", "config/opencode/.gitignore"].includes(name) ? ignored
        : name === "tool/report_progress.js" ? createProgressToolAsset() : null;
      if (expected === null || !lstatSync(child).isFile() || readFileSync(child, "utf8") !== expected)
        throw new Error(`unexpected or substituted progress tool source: ${name}`);
    }
  };
  walk(directory);
  for (const relative of privateDirectories) if (!lstatSync(join(directory, relative)).isDirectory()) throw new Error("missing isolated discovery directory");
  for (const relative of [".gitignore", "home/.opencode/.gitignore", "config/opencode/.gitignore"])
    if (readFileSync(join(directory, relative), "utf8") !== ignored) throw new Error("isolated discovery ignore file changed");
  if (hash(readFileSync(join(directory, "tool/report_progress.js"), "utf8")) !== expectedSha256)
    throw new Error("progress tool hash mismatch");
  if (readFileSync(join(directory, "package.json"), "utf8") !== '{"type":"module"}\n') throw new Error("progress package mismatch");
}

export function stageProgressTool(reportPath: string): { directory: string; sha256: string; asset: string } {
  if (!isAbsolute(reportPath)) throw new Error("progress tool requires an absolute execution report path");
  const directory = join(dirname(reportPath), `${basename(reportPath)}.progress-config`);
  const asset = createProgressToolAsset();
  const sha256 = hash(asset);
  if (existsSync(directory)) { assertProgressTool(directory, sha256); return { directory, sha256, asset }; }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const relative of privateDirectories) mkdirSync(join(directory, relative), { mode: 0o700 });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}\n', { mode: 0o600, flag: "wx" });
  writeFileSync(join(directory, "tool/report_progress.js"), asset, { mode: 0o600, flag: "wx" });
  for (const relative of [".gitignore", "home/.opencode/.gitignore", "config/opencode/.gitignore"])
    writeFileSync(join(directory, relative), ignored, { mode: 0o600, flag: "wx" });
  // OpenCode's config loader skips dependency installation in non-writable directories.
  // Precreate .gitignore so its discovery also performs no configuration writes.
  for (const relative of [...privateDirectories].reverse()) chmodSync(join(directory, relative), 0o500);
  chmodSync(directory, 0o500);
  assertProgressTool(directory, sha256);
  return { directory, sha256, asset };
}

export function isolatedProgressEnvironment(baseEnv: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, OPENCODE_CONFIG_DIR: directory, OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_TEST_HOME: join(directory, "home"), XDG_CONFIG_HOME: join(directory, "config") };
  delete env.OPENCODE_CONFIG;
  return env;
}
