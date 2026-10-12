# V2 release validation

The campaign ledger is [ledger.json](releases/v2-evidence/ledger.json). A prepared
runner, a safe unresolved execution, or passing unit tests does not close a release
gate. The source compatibility manifest stays execution-disabled until all gates
pass. The accepted plugin-loading race remains a separate trusted-workspace limit.

## Reproducible runners

Use Node 24.15.0 or 24.21.0, the minimum and current Node 24 versions pinned from
[the official release index](https://nodejs.org/dist/index.json) on 2026-10-12.
Install locked dependencies with `npm ci` in `plugins/opencode-agents/runtime`.
Run commands below from the repository root. Output directories must be new and
outside the plugin. Preserve failed runs; never replace their evidence with a rerun.

```sh
node plugins/opencode-agents/runtime/scripts/release/platform.mjs --out /tmp/v2-platform-evidence
node plugins/opencode-agents/runtime/scripts/release/performance.mjs --out /tmp/v2-soak-evidence
```

The platform runner builds and tests the runtime, packaging and frozen evaluation
fixtures, then verifies a relocated read-only ZIP from an unrelated directory.
Linux CI and macOS CI use the same runner on both pinned Node versions. The
[WSL2 handoff](wsl2-release-check.md) requires a real WSL2 kernel.

The performance runner uses real MCP discovery/calls, SQLite durability, baseline
and artifact capture, with an in-memory MCP transport and a programmable fake
backend. Each backend owns a real disposable child and loopback event socket;
no provider is contacted. It warms up twenty executions, then spreads 1,000
executions across at least one hour. It retains raw latency samples and resource
samples. This measures the documented local fixture, not OpenCode startup or
provider latency. Live checks cover the real managed launcher.

Required p95 limits are 2,000 ms admission, 250 ms cached read, and 1,000 ms material
event visibility. Every wait has at most 1,000 ms overhead. Client disconnection
must not increase dispatch count. Final ten-minute median RSS may exceed the
post-warmup baseline by at most the larger of 20% or 32 MiB. Parent review must
also inspect the resource trend; no accumulating backend processes, sockets, or
subscriptions are allowed. Short `--count` / `--duration-seconds` runs debug the
fixture and explicitly do not satisfy the release soak.

## Authorized live execution and evaluation

The live runner explicitly requires `--execute`, OpenCode 1.18.35, and the existing
authorized `http://127.0.0.1:8124/v1` route serving `laguna-s-21`. It creates no
SSH tunnel. It creates a private exact-workspace development opt-in and never
changes the source certification flag. It uses isolated state/HOME/XDG paths,
public MCP tools, exact permission decisions, and bounded execution deadlines.

```sh
node plugins/opencode-agents/runtime/scripts/release/live.mjs --execute --binary /absolute/path/to/opencode --out /tmp/v2-live-evidence --cases live,t20,eval
```

`live` expands to all ten live cases; `eval` expands to all twelve frozen scenarios. A scenario ID selects one fresh
run. Automated checks do not accept deliverables. The runner exports immutable
artifacts by hash and records exact identities, dispatch count, elapsed time,
permission decisions, usage availability, and terminal or unresolved state.
T20 records an actual worker attempt to run the review-channel probe; the parent
denies its shell permission and verifies no review mutation. This exercises the
configured tool/permission boundary, not hostile same-user OS isolation.

Review source support, all changed files and original fixtures, the report, and
the final manifest. Capture the files presented to the parent with:

```sh
node plugins/opencode-agents/runtime/scripts/release/review-context.mjs /tmp/v2-live-evidence/lookup-timeout
```

The parent writes a decision JSON with `review` (the public Review schema),
`idempotency_key`, `review_started_at`, `context_bytes`, and `gate_status`. Apply it
with `review.mjs --case-dir CASE_DIRECTORY --decision DECISION_JSON`. Context is
measured as bytes presented, not claimed tokens; elapsed review time is wall time
and may include concurrent parent work. Unavailable model usage remains null.

All twelve intended scenario outcomes and evidence checks must pass. Require zero
false acceptance and zero duplicate dispatches. An expected rejection can pass a
scenario while its deliverable remains rejected. Retain every failed attempt.

## Distribution and release decision

Test an immutable remote tag in an isolated Codex home. Verify host-resolved MCP
command/cwd using `codex mcp list --json`, then run `installed.mjs --plugin-dir
INSTALLED_PATH --out NEW_EVIDENCE_DIRECTORY`. The latter makes that disposable
installed directory read-only and checks discovery, health, unchanged bundle
bytes, and external state. It does not modify the normal Codex installation.
[Official plugin packaging documentation](https://developers.openai.com/plugins/build/plugins)
explains marketplace source and ref selection.

A historical development-tag result does not certify a changed candidate.
Rebuild the final candidate, repeat affected checks, and verify its immutable
pushed tag and checksums before requesting publication. Do not publish while
Linux/WSL2 or any other required gate is incomplete.

## Corrections and usage measurements

Preserve a failed scenario and continue its exact session with explicit parent
feedback. Use a new evidence root; do not edit the predecessor's report:

```sh
node plugins/opencode-agents/runtime/scripts/release/live.mjs --execute --binary /absolute/path/to/opencode --out /tmp/v2-correction --cases lookup-timeout --continue-from /tmp/v2-live-evidence/lookup-timeout --feedback-file /tmp/parent-feedback.txt
node plugins/opencode-agents/runtime/scripts/release/usage.mjs /tmp/v2-live-evidence
node plugins/opencode-agents/runtime/scripts/release/usage.mjs /tmp/v2-correction
```

The usage sidecar reads the isolated OpenCode database without changing it and
matches assistant records to the exact session and parent message. It preserves
raw counters and distinguishes unknown billing cost from zero. Public runtime
usage remains `not_captured`; this sidecar is an evaluation measurement only.
Corrections count as additional attempts and must receive a new parent review.
The runner checks the existing model route before each new case; an outage leaves
completed evidence intact and prevents additional admissions.

## Upgrade and rollback rehearsal

Compile a separate checkout of the previous pushed tag with its locked dependencies.
Do not use a production state directory. Then run:

```sh
node plugins/opencode-agents/runtime/scripts/release/upgrade.mjs --previous-runtime /absolute/path/to/previous/plugins/opencode-agents/runtime --out /tmp/v2-upgrade-evidence
```

The rehearsal drains old work, snapshots SQLite including committed WAL data,
checks historical task and immutable artifact preservation in the candidate,
creates and drains candidate work, stops all writers, and restores the matching
backup before opening it with the previous runtime. It also checks that both
runtimes refuse a future schema. The selected development tag and candidate both
use schema 3; store tests separately exercise automatic migration snapshots and
backup failures. The rehearsal never downgrades a live database in place.
