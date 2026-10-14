import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { assertNoLocalPlugins, assertWorkerPolicy, terminateOwnedChild, workerPolicy } from "../managed-server.js";

test("owned-worker termination escalates and requires exit evidence", async () => {
  class Child extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: NodeJS.Signals[] = [];
    exitOnKill = false;
    kill(signal: NodeJS.Signals) {
      this.signals.push(signal);
      if (this.exitOnKill && signal === "SIGKILL") { this.signalCode = signal; this.emit("exit"); }
      return true;
    }
  }
  const child = new Child();
  assert.equal(await terminateOwnedChild(child, 5), false, "successful kill() is not exit proof");
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("exit"), 0);
  child.exitOnKill = true;
  assert.equal(await terminateOwnedChild(child, 5), true);
  assert.equal(child.listenerCount("exit"), 0);
  const signals = child.signals.length;
  assert.equal(await terminateOwnedChild(child, 5), true);
  assert.equal(child.signals.length, signals, "an exited child is never signaled again");
});

test("termination confirms a real owned child exit without affecting an unrelated child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.equal(await terminateOwnedChild(child, 100), true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
  } finally {
    await terminateOwnedChild(child, 100);
    await terminateOwnedChild(unrelated, 100);
  }
});

test("managed termination stops a tool subprocess and escalates when its parent ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const script = `
    process.on('SIGTERM', () => {});
    const tool = require('node:child_process').spawn(process.execPath,
      ['-e', "console.log('tool ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    tool.stdout.once('data', () => console.log('ready'));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("child did not start")), 3_000);
      child.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });
    assert.equal(await terminateOwnedChild(child, 100, true), true);
    assert.equal(child.signalCode, "SIGKILL");
    assert.throws(() => process.kill(-child.pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  } finally { await terminateOwnedChild(child, 100, true); }
});

test("worker profiles restrict inspection edits to the assigned execution report", () => {
  const worktree = "/tmp/sample-project";
  const reportPath = "/tmp/opencode-agents-state/reports/exec_one";
  const sibling = "/tmp/opencode-agents-state/reports/exec_two";
  const { profiles, reportEditPattern } = workerPolicy(reportPath, worktree);
  assert.equal(reportEditPattern, `${relative(worktree, reportPath)}/*`);
  assert.deepEqual(profiles["bounded-inspect"]?.permission.edit,
    { "*": "deny", [reportEditPattern]: "allow" });
  assert.deepEqual(profiles["bounded-inspect"]?.permission.external_directory,
    { "*": "deny", [`${reportPath}/*`]: "allow" });
  assert.equal(Object.keys(profiles["bounded-inspect"]?.permission.edit as object).some((pattern) => pattern.includes(sibling)), false);
  assert.equal(Object.keys(profiles["bounded-inspect"]?.permission.external_directory as object).some((pattern) => pattern.includes(sibling)), false);
  assert.equal(profiles["bounded-inspect"]?.permission.bash, "deny");
  assert.equal(profiles["bounded-build"]?.permission.bash, "ask");
  assertWorkerPolicy({ plugin: [], mcp: { inherited: { enabled: false } }, agent: profiles }, profiles);
  assert.throws(() => assertWorkerPolicy({ plugin: [], mcp: { inherited: { enabled: true } }, agent: profiles }, profiles), /MCP/);
  assert.throws(() => assertWorkerPolicy({ plugin: ["unexpected"], mcp: {}, agent: profiles }, profiles), /plugins/);
});

test("worker plugin scan uses the child HOME rather than the supervisor HOME", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-child-home-"));
  try {
    const workspace = join(root, "project");
    const childHome = join(root, "child-home");
    mkdirSync(workspace);
    mkdirSync(join(childHome, ".opencode", "plugins"), { recursive: true });
    writeFileSync(join(childHome, ".opencode", "plugins", "sentinel.js"), "export default {};");
    assert.throws(() => assertNoLocalPlugins(workspace, { HOME: childHome }), /local plugins present/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local project plugin files cause worker launch to fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-policy-"));
  try {
    const workspace = join(root, "project");
    const configDir = join(root, "global-config");
    const env = { OPENCODE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"), OPENCODE_TEST_HOME: join(root, "home") };
    mkdirSync(join(workspace, ".opencode", "plugins"), { recursive: true });
    mkdirSync(configDir);
    assert.doesNotThrow(() => assertNoLocalPlugins(workspace, env));
    writeFileSync(join(workspace, ".opencode", "plugins", "sentinel.js"), "export default {};");
    assert.throws(() => assertNoLocalPlugins(workspace, env), /local plugins present/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("V2 plugin declarations in project and global documents fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-config-policy-"));
  try {
    const workspace = join(root, "project");
    const configDir = join(root, "global-config");
    const env = { OPENCODE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"), OPENCODE_TEST_HOME: join(root, "home") };
    mkdirSync(join(workspace, ".opencode"), { recursive: true });
    mkdirSync(configDir);
    const cases = [
      [join(workspace, "opencode.json"), '{"plugins":["file:///tmp/sentinel.js"]}'],
      [join(workspace, ".opencode", "opencode.json"), '{"plugin":["file:///tmp/sentinel.js"]}'],
      [join(configDir, "opencode.json"), '{"plugins":["file:///tmp/sentinel.js"]}'],
      [join(configDir, "opencode.jsonc"), '{"plugins":[]}'],
    ];
    writeFileSync(join(configDir, "opencode.json"), '{"provider":{"llama.cpp":{"npm":"@ai-sdk/openai-compatible"}}}');
    assert.doesNotThrow(() => assertNoLocalPlugins(workspace, env));
    for (const [file, contents] of cases) {
      writeFileSync(file!, contents!);
      assert.throws(() => assertNoLocalPlugins(workspace, env), /plugin configuration present/);
      rmSync(file!);
    }
    writeFileSync(join(workspace, "opencode.jsonc"), '{ // valid JSONC\n "provider": {"llama.cpp": {}}, }');
    assert.doesNotThrow(() => assertNoLocalPlugins(workspace, env));
    writeFileSync(join(workspace, "opencode.jsonc"), '{ /* V2 */ "plu\\u0067ins": ["sentinel",], }');
    assert.throws(() => assertNoLocalPlugins(workspace, env), /plugin configuration present/);
    writeFileSync(join(workspace, "opencode.jsonc"), '{ /* unclosed');
    assert.throws(() => assertNoLocalPlugins(workspace, env), /cannot be checked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom config content and config file plugin declarations fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-custom-policy-"));
  try {
    const workspace = join(root, "project");
    const custom = join(root, "custom.json");
    mkdirSync(workspace);
    const env = { OPENCODE_CONFIG_DIR: join(root, "global-config"), XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"), OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_CONFIG: custom };
    writeFileSync(custom, '{"plugin":["sentinel"]}');
    assert.throws(() => assertNoLocalPlugins(workspace, env), /plugin configuration present/);
    writeFileSync(join(workspace, "relative.json"), '{"plugins":["sentinel"]}');
    assert.throws(() => assertNoLocalPlugins(workspace, { ...env, OPENCODE_CONFIG: "relative.json" }),
      /plugin configuration present/);
    writeFileSync(custom, '{"model":"llama.cpp\/laguna-s-21"}');
    assert.doesNotThrow(() => assertNoLocalPlugins(workspace, env));
    assert.throws(() => assertNoLocalPlugins(workspace, { ...env, OPENCODE_CONFIG_CONTENT: '{"plugins":["sentinel"]}' }),
      /plugin configuration present/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
