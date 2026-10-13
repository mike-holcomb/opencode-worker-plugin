# V2 validation

[OpenCode Agents v2.0.0](https://github.com/mike-holcomb/opencode-worker-plugin/releases/tag/v2.0.0)
is a published full release. Its internal package version remains `2.0.0-dev.0`,
and the compatibility manifest retains `execution_supported: false`. Live managed
execution requires the exact trusted-workspace opt-in in [installation](installation.md).
Release publication and execution certification are separate statuses.

## Automated checks

The tagged main merge has the same tree as PR head `5a91c29`, which passed all four
[CI jobs](https://github.com/mike-holcomb/opencode-worker-plugin/actions/runs/38306022269):
macOS 15 and Ubuntu 24.04, each on Node 24.15.0 and 24.21.0. Each job ran 93 runtime
tests, five release-runner tests, nine packaging tests, five evaluation-harness
tests, frozen-fixture validation, deterministic packaging, and relocated read-only
installation. These automated checks perform no provider inference.

All 30 applicable fault cases have direct coverage under the configured boundary,
including a real T20 worker attempt to access the parent review channel. This is
not plugin suppression or protection from hostile same-user operating-system access.

## Installation evidence

The deterministic allowlisted archive contains 72 files, a per-file manifest, and
SHA-256 checksums. The ZIP attached to v2.0.0 passed a relocated read-only smoke
test on Node 24.21.0: ten MCP tools, unchanged bundle bytes, and external runtime state.

Codex CLI 0.162.0 resolved plugin-relative MCP startup in a local marketplace
installation. Codex CLI 0.162.1 passed Git-backed installation from the historical
`v2.0.0-dev.0` tag. Installation from the `v2.0.0` marketplace ref remains to be
verified; the published ZIP smoke test does not establish that result.

## Live, evaluation, and performance evidence

All ten macOS live cases have recorded passing observations and parent reviews.
Case 3 retains its documented historical concurrency evidence; reconnect and
supervisor restart were rerun after the RPC fix with exact identity continuity
and one dispatch. Missing or failed deliverables in operational denial/cancellation
cases remain rejected. Historical failed and unresolved attempts are retained.

All twelve evaluation scenarios were run, producing 40 retained attempts: nine
accepted deliverables and ten passing reviewed scenario outcomes, including
expected rejection in the failed-check scenario. Policy-contradiction and
false-completion assessments still need satisfactory reviewed results. Model-route
outages, harness defects, parent delays, and report errors are recorded; automated
marker checks alone do not establish acceptance.

The one-hour, 1,000-execution fake-backend soak passed, with 20 additional warmups.
Measured p95 admission was 83.6 ms, cached read 1.08 ms, and event visibility 8.34 ms.
All 1,020 backends closed and final median RSS stayed within the fixture limit.
These measurements use in-memory MCP transport and fake owned child backends;
they exclude provider latency, cold startup, and local RPC transport.
Upgrade/rollback rehearsal also passed with matching backups and preserved data.

## Remaining certification checks and limitations

- Policy-contradiction and false-completion evaluation outcomes.
- Linux live and WSL2 operator evidence. Automated Ubuntu CI does not certify live Linux execution.
- Marketplace installation from the final `v2.0.0` tag.
- OpenCode 1.18.35 can load a project plugin introduced after launch inspection.
  This accepted limitation requires trusted workspaces and is not a passed plugin-suppression test.
- Attached execution and native questions remain intentionally disabled.

See the repository's
[implementation status](https://github.com/mike-holcomb/opencode-worker-plugin/blob/main/docs/v2-implementation.md),
[evidence ledger](https://github.com/mike-holcomb/opencode-worker-plugin/blob/main/docs/releases/v2-evidence/ledger.json),
and [quality review](https://github.com/mike-holcomb/opencode-worker-plugin/blob/main/docs/releases/v2-evidence/quality-review.md)
for exact provenance and measurement limits.
