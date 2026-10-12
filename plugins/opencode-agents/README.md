# OpenCode Agents

A Codex plugin for bounded delegation through a durable local supervisor and an independently installed OpenCode backend. The v2 MCP runtime and skill ship together. The parent prepares the assignment, recovers exact task identities, inspects evidence, and records acceptance. Publisher: Mike Holcomb. License: [MIT](LICENSE).

## Current status

Version `2.0.0-dev.0` is a development build. Consult the repository's `docs/v2-implementation.md` and bundled [compatibility](compatibility.json) before live execution. A working MCP connection or passing component tests alone does not certify the backend or release gates.

Known plugin boundary FIXME: OpenCode 1.18.35 can load a project plugin added after the worker's launch-time scan. The user accepted continued development with this limitation; use only trusted workspaces and do not treat bounded tool permissions as plugin containment. The source compatibility manifest remains execution-disabled while other release gates are incomplete.

## Use

Install a Node.js 24.15+ runtime in the 24.x line, OpenCode separately, and an authorized provider/model. The `node` on the host's PATH must resolve to that supported line when Codex launches the MCP server. Configure permitted workspace roots, model destinations, and limits outside the bundle. The `opencode-agents:opencode-agents` skill explains when to delegate, how to supply a typed packet, and how to review. The development plugin declares `node ./bin/opencode-agents.mjs mcp` as its MCP entry. Codex CLI 0.162.0 resolved that relative command in an isolated local marketplace install on macOS; Git-backed installation is still unchecked. The runtime needs no startup `npm install`, TypeScript loader, or Python runner.

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

The archive is allowlisted and deterministic. The builder checks that the compiled executable matches the TypeScript source and writes `.manifest.json` with per-file SHA-256 values plus a `.sha256` sidecar for the archive and manifest. The installed smoke verifies those hashes, extracts the archive to a read-only path with spaces, runs diagnostics from an unrelated directory, starts the bundled MCP command with the plugin directory as its working directory, lists ten tools, and checks that runtime state stayed outside the bundle. Host plugin-relative MCP resolution remains unverified.
