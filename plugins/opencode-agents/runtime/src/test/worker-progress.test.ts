import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { assertProgressTool, createProgressToolAsset, isolatedProgressEnvironment, stageProgressTool } from "../worker-progress.js";
const checkpoint = { stage: "implementing", summary: "Milestone reached", completed: ["Added implementation"], remaining: ["Verify it"], blocker: null, evidence_refs: [] };
const writable = (path: string) => { if (lstatSync(path).isSymbolicLink()) return; if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700); for (const child of readdirSync(path)) writable(join(path, child)); };

test("native tool is deterministic and accepts the OpenCode direct-argument calling convention", async () => {
  const asset = createProgressToolAsset(); assert.equal(asset, createProgressToolAsset());
  assert.doesNotMatch(asset, /import\s|require\(/);
  const tool = (await import("data:text/javascript," + encodeURIComponent(asset))).default;
  assert.equal(tool.args.summary.maxLength, 600); assert.equal(tool.args.blocker.anyOf[0].type, "null");
  const result = await tool.execute(checkpoint);
  assert.deepEqual(result.metadata, { opencode_agents_progress: checkpoint });
  assert.match(result.output, /asynchronous/);
  for (const changed of [{ summary: "x".repeat(601) }, { stage: "completed" }, { completed: Array(6).fill("step") },
    { blocker: { summary: "Request", execution_id: "other" } }, { execution_id: "other" }, { evidence_refs: ["x".repeat(129)] },
    { summary: "界".repeat(600), remaining: Array(5).fill("界".repeat(200)) }]) await assert.rejects(tool.execute({ ...checkpoint, ...changed }));
  await assert.rejects(tool.execute({ args: checkpoint }), /documented checkpoint fields/);
});

test("staging is private, frozen, idempotent and has no checkpoint files or runtime imports", () => {
  const root = mkdtempSync(join(tmpdir(), "progress-tool-"));
  try {
    const staged = stageProgressTool(join(root, "reports", "exec"));
    assert.equal(staged.directory, join(root, "reports", "exec.progress-config"));
    assert.equal(lstatSync(staged.directory).mode & 0o777, 0o500);
    assert.equal(lstatSync(join(staged.directory, "tool/report_progress.js")).mode & 0o777, 0o600);
    assert.deepEqual(stageProgressTool(join(root, "reports", "exec")), staged);
    assert.doesNotThrow(() => assertProgressTool(staged.directory, staged.sha256));
    assert.throws(() => assertProgressTool(staged.directory, "0".repeat(64)), /hash/);
    assert.equal(readFileSync(join(staged.directory, "tool/report_progress.js"), "utf8"), staged.asset);
    assert.deepEqual(readdirSync(join(staged.directory, "tool")), ["report_progress.js"]);
  } finally { writable(root); rmSync(root, { recursive: true, force: true }); }
});

test("tool and discovery-directory substitutions are rejected before managed launch", () => {
  const root = mkdtempSync(join(tmpdir(), "progress-substitute-"));
  try {
    const staged = stageProgressTool(join(root, "reports", "exec")); writable(staged.directory);
    const tool = join(staged.directory, "tool/report_progress.js");
    writeFileSync(tool, "export default {};\n"); assert.throws(() => assertProgressTool(staged.directory, staged.sha256), /substituted/);
    writeFileSync(tool, staged.asset);
    writeFileSync(join(staged.directory, "tool/other.js"), "export default {};\n"); assert.throws(() => assertProgressTool(staged.directory, staged.sha256), /unexpected/);
    rmSync(join(staged.directory, "tool/other.js"));
    symlinkSync(tool, join(staged.directory, "home/.opencode/injected")); assert.throws(() => assertProgressTool(staged.directory, staged.sha256), /symlink/);
    rmSync(join(staged.directory, "home/.opencode/injected"));
    writeFileSync(join(staged.directory, "config/opencode/opencode.json"), '{"plugins":["untrusted"]}'); assert.throws(() => assertProgressTool(staged.directory, staged.sha256), /unexpected/);
  } finally { writable(root); rmSync(root, { recursive: true, force: true }); }
});

test("owned discovery isolates home/global/project tools without changing HOME or caller environment", () => {
  const base = { HOME: "/real/home", OPENCODE_CONFIG: "/untrusted/override", OPENCODE_CONFIG_DIR: "/untrusted/tools", XDG_CONFIG_HOME: "/global", OPENCODE_TEST_HOME: "/untrusted/home" };
  const copy = { ...base }; const env = isolatedProgressEnvironment(base, "/private/config");
  assert.deepEqual(base, copy); assert.equal(env.HOME, base.HOME); assert.equal(env.OPENCODE_CONFIG, undefined);
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "true"); assert.equal(env.OPENCODE_CONFIG_DIR, "/private/config");
  assert.equal(env.OPENCODE_TEST_HOME, "/private/config/home"); assert.equal(env.XDG_CONFIG_HOME, "/private/config/config");
  assert.equal(env.npm_config_offline, undefined);
});

test("worker npm commands retain defaults and caller-supplied offline settings", () => {
  const root = mkdtempSync(join(tmpdir(), "progress-npm-"));
  try {
    const base: NodeJS.ProcessEnv = { ...process.env, npm_config_userconfig: join(root, "npmrc"), npm_config_globalconfig: join(root, "global-npmrc") };
    delete base.npm_config_offline;
    delete base.NPM_CONFIG_OFFLINE;
    const offline = (env: NodeJS.ProcessEnv) => execFileSync("npm", ["config", "get", "offline"],
      { cwd: root, env: isolatedProgressEnvironment(env, join(root, "config")), encoding: "utf8" }).trim();
    assert.equal(offline(base), "false");
    assert.equal(offline({ ...base, npm_config_offline: "false" }), "false");
    assert.equal(offline({ ...base, npm_config_offline: "true" }), "true");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
