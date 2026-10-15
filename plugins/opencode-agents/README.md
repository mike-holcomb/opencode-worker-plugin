# OpenCode Agents

A Codex plugin for bounded delegation through a durable local supervisor and an independently installed OpenCode backend. The v2 MCP runtime and skill ship together. The parent prepares the assignment, recovers exact task identities, inspects evidence, and records acceptance. Publisher: Mike Holcomb. License: [MIT](LICENSE).

## Release 2.1.0 candidate

Plugin and runtime versions are `2.1.0`. This release includes durable
cancellation reconciliation, bounded owned-worker stop recovery and native
worker progress checkpoints, resolving issues #2, #3 and #4. See the
[release notes](https://github.com/mike-holcomb/opencode-worker-plugin/blob/main/docs/releases/v2.1.0.md).

The [compatibility manifest](compatibility.json) retains `execution_supported: false`.
Live tasks require the exact-workspace opt-in in [installation](docs/installation.md).
Managed OpenCode/SDK 1.19.0 workers isolate custom-tool discovery and disable
project configuration discovery. Full host/plugin discovery containment and
execution certification remain pending. Attached execution and native questions
remain disabled. See [validation](docs/validation.md).

## Install

After the `v2.1.0` tag is published:

```bash
codex plugin marketplace add mike-holcomb/opencode-worker-plugin --ref v2.1.0
codex plugin add opencode-agents@opencode-worker-plugin
```

Until publication, [v2.0.0](https://github.com/mike-holcomb/opencode-worker-plugin/releases/tag/v2.0.0)
remains the published release and can be installed with `--ref v2.0.0`.
Install the supported Node runtime first and start a fresh Codex session after
installation. Follow the [configuration and rollback guide](docs/installation.md).

## Use

Install a Node.js 24.15+ runtime in the 24.x line, OpenCode separately, and an authorized provider/model. The `node` on the host's PATH must resolve to that supported line when Codex launches the MCP server. Configure permitted workspace roots, model destinations, and limits outside the bundle. The `opencode-agents:opencode-agents` skill explains when to delegate, how to supply a typed packet, and how to review. The plugin declares `node ./bin/opencode-agents.mjs mcp` as its MCP entry. Codex CLI 0.162.0 resolved that relative command in a local marketplace install on macOS. Codex 0.162.1 also passed installation from the historical `v2.0.0-dev.0` Git tag; marketplace installation from the final `v2.1.0` tag remains to be verified. The runtime needs no startup `npm install`, TypeScript loader, or Python runner.

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

The archive is allowlisted and deterministic. The builder checks that the compiled executable matches the TypeScript source and writes `.manifest.json` with per-file SHA-256 values plus a `.sha256` sidecar for the archive and manifest. The installed smoke verifies those hashes, extracts the archive to a read-only path with spaces, runs diagnostics from an unrelated directory, starts the bundled MCP command with the plugin directory as its working directory, lists eleven tools, and checks that runtime state stayed outside the bundle. Plugin-relative MCP resolution was verified in the local and historical-tag marketplace installs described above.

## Worker progress

`opencode_get_progress` reads only worker-authored checkpoints for one required execution. Retain its opaque `next_cursor` to consume unseen milestones; snapshot inclusion is explicit. Checkpoints are bounded and held in supervisor memory, with explicit gaps after restart, disconnect, or eviction. The native `report_progress` tool loads from an owned, hashed private directory and works in read-only assignments without project writes. Reading progress never starts inference or changes task lifecycle, requests, reports, or review status. See the [tool reference](skills/opencode-agents/references/tools.md) and [progress validation](docs/progress.md).
