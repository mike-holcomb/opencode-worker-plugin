import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { freezeManagedLaunch, launchEnvironment } from "../managed-server.js";
import { assertSelectedModelDestination, policyNeutralConfigHash } from "../launch-config.js";
import { ArtifactStore } from "../artifacts.js";
import { SupervisorService } from "../service.js";
import { SqliteTaskStore } from "../store.js";

test("managed launch freezes provider routing and rejects a changed effective config", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-launch-binding-"));
  try {
    const workspace = join(root, "project");
    const configDir = join(root, "config");
    mkdirSync(workspace);
    mkdirSync(configDir);
    const binary = join(root, "fake-opencode");
    writeFileSync(binary, `#!/usr/bin/env node
const base = { plugin: [], mcp: { inherited: { enabled: true } }, agent: {},
  provider: { "llama.cpp": { options: { baseURL: "http://127.0.0.1:8124/v1" } } } };
const config = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : base;
if (process.env.FROZEN_DRIFT) config.provider["llama.cpp"].options.baseURL = "http://127.0.0.1:9999/v1";
process.stdout.write(JSON.stringify(config));
`);
    chmodSync(binary, 0o700);
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: root, OPENCODE_CONFIG_DIR: configDir };
    delete env.OPENCODE_CONFIG_CONTENT;
    const reportPath = join(root, "state", "reports", "exec_first");
    const contract = await freezeManagedLaunch(binary, workspace, reportPath, env);
    assert.equal(contract.reportPath, reportPath);
    const frozen = JSON.parse(contract.configContent) as { provider: Record<string, { options: { baseURL: string } }> };
    assert.equal(frozen.provider["llama.cpp"]?.options.baseURL, "http://127.0.0.1:8124/v1");
    assert.doesNotThrow(() => assertSelectedModelDestination({ provider_id: "llama.cpp", model_id: "laguna-s-21",
      destination: "local" }, contract));
    assert.doesNotThrow(() => assertSelectedModelDestination({ provider_id: "llama.cpp", model_id: "laguna-s-21",
      destination: "http://127.0.0.1:8124/v1" }, contract));
    assert.throws(() => assertSelectedModelDestination({ provider_id: "llama.cpp", model_id: "laguna-s-21",
      destination: "http://127.0.0.1:9999/v1" }, contract), /route differs/);
    const prepared = await launchEnvironment({ binary, workspace, env, launchContract: contract });
    assert.equal(prepared.env.OPENCODE_CONFIG_CONTENT, contract.configContent);
    const sibling = join(root, "state", "reports", "exec_sibling");
    const siblingContract = await freezeManagedLaunch(binary, workspace, sibling, env);
    assert.notEqual(contract.effectiveConfigSha256, siblingContract.effectiveConfigSha256);
    assert.equal(policyNeutralConfigHash(contract), policyNeutralConfigHash(siblingContract));
    await assert.rejects(launchEnvironment({ binary, workspace, env,
      launchContract: { ...contract, reportPath: sibling } }), /worker policy mismatch/);
    const changedState = { ...env, OPENCODE_AGENTS_STATE_DIR: join(root, "elsewhere") };
    const reopened = await launchEnvironment({ binary, workspace, env: changedState, launchContract: contract });
    assert.equal(reopened.env.OPENCODE_CONFIG_CONTENT, contract.configContent);
    await assert.rejects(launchEnvironment({ binary, workspace,
      env: { ...env, FROZEN_DRIFT: "1" }, launchContract: contract }), /changed since task admission/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("frozen launch contract survives a restart without appearing in task projections", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-launch-storage-"));
  const database = join(root, "state.sqlite");
  const contract = { configContent: JSON.stringify({ provider: { local: { options: { baseURL: "http://127.0.0.1:8124/v1" } } } }),
    effectiveConfigSha256: "frozen-digest", reportPath: join(root, "reports", "exec_first") };
  try {
    let store = new SqliteTaskStore(database);
    const task = store.start({ scopeId: "scope", idempotencyKey: "frozen-config-123456789", workspace: root,
      packet: {}, model: "local/model", profile: "bounded-inspect", baselineHash: "a", promptHash: "b",
      launchContract: contract });
    store.close();
    store = new SqliteTaskStore(database);
    assert.deepEqual(store.get("scope", task.taskId)?.launchContract, contract);
    assert.equal(statSync(database).mode & 0o777, 0o600);
    const service = new SupervisorService(store, new ArtifactStore(join(root, "artifacts")));
    const projected = await service.handle("get_task", { scope_id: "scope", task_id: task.taskId });
    assert.equal("launchContract" in (projected as object), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker launch fails closed when git cannot establish the worktree root", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-git-root-"));
  try {
    const workspace = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(workspace);
    mkdirSync(bin);
    const binary = join(bin, "fake-opencode");
    writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({plugin: [], mcp: {}, agent: {}}));\n`);
    chmodSync(binary, 0o700);
    const git = join(bin, "git");
    writeFileSync(git, "#!/bin/sh\necho 'fatal: unsafe repository ownership' >&2\nexit 1\n");
    chmodSync(git, 0o700);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      OPENCODE_CONFIG_DIR: join(root, "config", "opencode"), PATH: `${bin}:${process.env.PATH ?? ""}` };
    delete env.OPENCODE_CONFIG_CONTENT;
    await assert.rejects(freezeManagedLaunch(binary, workspace, join(root, "reports", "exec_one"), env),
      /cannot establish OpenCode worktree root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
