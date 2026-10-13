# OpenCode Agents

A Codex plugin for bounded delegation through a durable local supervisor and an independently installed OpenCode backend. The v2 MCP runtime and skill ship together. The parent prepares the assignment, recovers exact task identities, inspects evidence, and records acceptance. Publisher: Mike Holcomb. License: [MIT](LICENSE).

## Published release

[Version v2.0.0](https://github.com/mike-holcomb/opencode-worker-plugin/releases/tag/v2.0.0)
is published as a full GitHub release. The tagged plugin and runtime manifests
retain version `2.0.0-dev.0`; an installed package may display that internal version.
The bundled [compatibility manifest](compatibility.json) still has
`execution_supported: false`, so live tasks require the exact-workspace opt-in in
[installation](docs/installation.md). Publication did not enable execution or
complete the outstanding certification checks.

Known plugin boundary: OpenCode 1.18.35 can load a project plugin added after the
worker's launch-time scan. Use only trusted workspaces; bounded tool permissions
do not provide plugin containment. Attached execution and native questions remain
disabled. See [validation](docs/validation.md) for passing evidence and remaining checks.

## Install

```bash
codex plugin marketplace add mike-holcomb/opencode-worker-plugin --ref v2.0.0
codex plugin add opencode-agents@opencode-worker-plugin
```

Install the supported Node runtime first and start a fresh Codex session after
installation. Follow the [configuration and rollback guide](docs/installation.md)
for live execution setup.

## Use

Install a Node.js 24.15+ runtime in the 24.x line, OpenCode separately, and an authorized provider/model. The `node` on the host's PATH must resolve to that supported line when Codex launches the MCP server. Configure permitted workspace roots, model destinations, and limits outside the bundle. The `opencode-agents:opencode-agents` skill explains when to delegate, how to supply a typed packet, and how to review. The plugin declares `node ./bin/opencode-agents.mjs mcp` as its MCP entry. Codex CLI 0.162.0 resolved that relative command in a local marketplace install on macOS. Codex 0.162.1 also passed installation from the historical `v2.0.0-dev.0` Git tag; marketplace installation from `v2.0.0` remains to be verified. The runtime needs no startup `npm install`, TypeScript loader, or Python runner.

Use `opencode_health` and `opencode_start_task` with `dry_run: true` for read-only setup checks. Live start requires either a certified backend or the [private development opt-in](docs/installation.md) for an exact trusted workspace, plus effective bounded policy and explicit task authorization. The development path does not certify the release. Keep the scope and idempotency key for recovery. A timeout does not authorize a new submission, and worker completion does not mean parent acceptance. See [installation and rollback](docs/installation.md).

## Build and verify

From `plugins/opencode-agents`:

```bash
cd runtime
npm ci
npm run bundle
cd ..
node scripts/build_bundle.mjs --check
node scripts/build_bundle.mjs --out /private/tmp/opencode-agents-v2.zip
node scripts/smoke_installed_bundle.mjs /private/tmp/opencode-agents-v2.zip
node --test tests/packaging.test.mjs
node --test evaluation/harness.test.mjs
node evaluation/harness.mjs validate
```

The archive is allowlisted and deterministic. The builder checks that the compiled executable matches the TypeScript source and writes `.manifest.json` with per-file SHA-256 values plus a `.sha256` sidecar for the archive and manifest. The installed smoke verifies those hashes, extracts the archive to a read-only path with spaces, runs diagnostics from an unrelated directory, starts the bundled MCP command with the plugin directory as its working directory, lists ten tools, and checks that runtime state stayed outside the bundle. Plugin-relative MCP resolution was verified in the local and historical-tag marketplace installs described above.
