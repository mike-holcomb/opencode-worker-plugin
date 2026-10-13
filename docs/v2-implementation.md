# V2 implementation status

[v2.0.0](https://github.com/mike-holcomb/opencode-worker-plugin/releases/tag/v2.0.0) is published as a full GitHub release from the main merge of PR #1. The tagged plugin/runtime manifests retain internal version `2.0.0-dev.0`. Execution certification against [spec-v2.md](spec-v2.md) remains incomplete: the compatibility manifest still has `execution_supported: false`, and real tasks require a private development opt-in naming the exact trusted workspace. Without it, `start_task` returns `UNSUPPORTED_BACKEND`. The evidence ledger records the validation campaign and its outstanding gates; publication did not turn those gates into passing results.

## Implemented in this branch

- Strict packet, worker report, and review contracts; ten registered MCP tools; a bundled Node CLI with task, cancellation, artifact, and diagnostic commands.
- SQLite single-writer records with scoped idempotency, event cursors, pagination, frozen prompts and workspace baselines, immutable backend launch configuration, durable queue admission, resource reservations, exact session and message intents, and follow-up execution records. Existing databases needing schema repair receive a pre-migration SQLite snapshot, including committed WAL data; backup failure stops the upgrade.
- A coordinator that creates and reconciles exact sessions, dispatches once after a committed intent, applies queue and execution deadlines, observes turns and input requests, retains ownership through uncertain cancellation, captures reports, and finalizes durable outcomes. Ambiguous creation, dispatch, and reply acknowledgements are observed without blind resubmission.
- File reports from both bounded worker profiles, artifact staging and startup reconciliation, report and summary validation, final manifests, and accepted-review checks tied to execution-owned artifact hashes.
- Read-only diagnostics for an explicitly configured loopback OpenCode endpoint. Attached dispatch stays disabled; probes never submit work or stop the external server.
- Optional private managed-worker stderr capture (`OPENCODE_AGENTS_CAPTURE_DIAGNOSTICS=1`) retains at most 64 KiB per execution for seven days, with hourly idle cleanup. After the cap, byte counts are batched instead of rewriting the retained log for each stderr chunk. Explicit `get_task` diagnostic cursors return 2 KiB chunks with size and truncation metadata; default task results contain no raw log text. After a hard process crash, the recorded total may omit up to one second of later stderr, while the captured bytes and first truncation marker remain durable.
- V2 skill guidance, worker profiles, pinned bundle inputs, a read-only installed-bundle smoke script, and a Node evaluation harness for twelve v2 scenarios with explicit acceptance checks. The old Python launcher, import interface, comparison runner, packaging scripts, and pytest suite have been retired. Python files under `evaluation/fixtures` are sample project inputs and local unit tests used by some scenarios.

The implementation used bounded OpenCode code and review subagents with `llama.cpp/laguna-s-21`; the parent inspected and tested their changes. Job evidence is under `.work/v2/impl` and compatibility probes under `.work/v2/compat-cert`.

## Compatibility gate

Live probes against OpenCode 1.18.35 and the configured port-8124 Laguna endpoint verified exact session creation and lookup, caller-assigned message correlation, async turns, permission enumeration and `allow_once`, abort acknowledgement and completion races, SSE reconnect with snapshot recovery, effective bounded profile permissions, and external file reports. Structured output failed on message retrieval; native questions remain disabled. The user authorized use of the existing port forward but prohibited initiating SSH tunnels. An earlier `ssh -G` locally inspected SSH configuration without connecting; it was an unnecessary direct invocation and was not repeated. No test created or changed a tunnel. A listener inspection later confirmed an existing `ssh` process owned port 8124; the destination behind it was not independently verified.

The plugin control boundary is an accepted known issue for now, with a FIXME in `managed-server.ts`. A disposable project plugin executed during a turn under `opencode serve --pure` even when `config.get` reported no plugins. Managed launch rejects plugin roots and JSON/JSONC declarations present at launch, disables inherited MCP entries, applies execution-specific bounded report permissions, freezes the effective provider route and policy at admission, and rejects later config drift. A plugin file introduced after preflight can still load lazily during inference. A local macOS sandbox probe showed that simple path read denial can be bypassed through a symlinked plugin directory; a private immutable sanitized configuration namespace or an upstream loader fix remains the later repair. The user authorized proceeding with this boundary documented; the execution flag remains false while the separate release checks below are incomplete. See [probe evidence](../.work/v2/compat-cert/summary.md) and [isolated v2 execution evidence](../.work/v2/live-2026-10-12/summary.md). Codex CLI 0.162.0 resolved the plugin-relative MCP command in a local marketplace test. The later campaign verified Git-backed installation of the historical pushed `v2.0.0-dev.0` tag using Codex 0.162.1; installation of the changed final candidate tag remains pending.

An operator can now set `development_execution.enabled: true` with an exact canonical `trusted_workspaces` entry in the private runtime config. Admission and follow-ups require that match; managed launch and coordinator still require the recorded 1.18.35 binary/SDK/OpenAPI pair, required capabilities, and frozen effective policy. This development route does not alter `compatibility.json`, `doctor.backend.certifiedPairs`, or `doctor.backend.executionTested`. Removing the opt-in stops new admissions and follow-ups; already admitted executions retain their frozen config for recovery and cancellation. A public MCP [live opt-in probe](../.work/v2/live-2026-10-12/dev-opt-in.md) completed with a valid report and accepted review while the source manifest and doctor stayed uncertified.

## Verification and remaining release work

The [release evidence campaign](release-validation.md) records results in
[ledger.json](releases/v2-evidence/ledger.json). Commit `494efb6` passes 93 runtime
tests, five release-runner tests, nine packaging tests, five evaluation
harness tests, frozen-fixture validation, deterministic packaging, and relocated
read-only installation in all four macOS 15/Ubuntu 24.04 CI jobs on Node 24.15.0
and 24.21.0. Local macOS arm64 runs also passed at `ceb4c27`. This automated
matrix does not certify live Linux execution or WSL2; their operator handoffs are
[Linux](linux-release-check.md) and [WSL2](wsl2-release-check.md).

All 30 applicable fault cases now have direct coverage under the configured
trusted-workspace boundary. T20 includes a real worker request to execute the
parent review probe, denied by the parent, with zero review mutations before the
parent review. The configured worker MCP exclusion is separately tested. This is
not plugin suppression or protection from hostile same-user operating-system
access. T28 remains excluded from v2-only scope. The campaign also found and fixed
idle backend retention, failure to replace a proven-dead owned backend, and a
concurrent supervisor bind loser unlinking the winner's socket. Supervisor socket
ownership is now elected before SQLite initialization or reconciliation. A later
Ubuntu CI run exposed an unhandled EPIPE when a timed-out RPC client disconnected;
the fix preserves durable work and keeps the supervisor serving subsequent clients.
All four CI jobs and fresh live reconnect/restart cases passed after that fix.

All ten macOS live cases have recorded passing observations and parent reviews.
Cases 1, 2 and 4–10 were rerun with the repaired runtime. Case 3 retains its earlier
accepted concurrency run with exact original provenance, reports, reviews and
verified artifact hashes in [historical-live3](releases/v2-evidence/historical-live3/review.md).
Supervisor restart completed with the same identities; permission denial and
backend restart reached proven terminal stops with ownership released. Missing
reports were rejected as deliverables while the specified operational cases passed.
Failed-check acceptance was refused. Failed fixture attempts remain alongside the
successful records.

All twelve evaluation scenarios now have actual attempt records and aggregate
[quality measurements](releases/v2-evidence/quality-summary.json). 10 scenarios
have passing reviewed outcomes, including expected rejection of the failed-check
deliverable; 9 deliverables are accepted. See the
[quality review](releases/v2-evidence/quality-review.md) for remaining cases and
retained failures.
Infrastructure failures, parent permission delays, incorrect runner assumptions,
invalid reports and unresolved cancellation are retained separately from successes.
The wire correction includes an explicit parent-feedback mistake, exposed by the
worker and preserved in its review. No first-attempt quality success is inferred
from an eventual correction. Exact-turn token counters are recorded where available;
unknown usage and verified billing cost remain null.

The one-hour/1,000-execution soak passed: p95 admission 83.6 ms, cached read
1.08 ms, and material-event visibility 8.34 ms. All 1,020 backends including
warmups closed, and final median RSS stayed within the agreed limit. See the
[resource review](releases/v2-evidence/soak/parent-review.json).

Upgrade/rollback rehearsal passed with committed WAL data, historical task and
artifact preservation, drained writers, matching-backup restoration, and refusal
of newer schemas. Both selected runtimes use schema 3; migration snapshots and
backup-failure paths have separate deterministic tests. Historical pushed-tag
installation passed, but a changed candidate still needs its own immutable tag
verification. WSL2 is assigned to the operator using the
[prepared evidence runner](wsl2-release-check.md). The release is published;
`execution_supported: false` remains until the outstanding execution-certification
checks pass.

The isolated 2026-10-12 test-only manifest enabled real v2 dispatch without changing the source compatibility gate. A read-only task and a declared-write task both completed with valid file reports and accepted parent reviews. The write used a scoped `allow_once` reply, changed only the declared target, and preserved pre-existing dirty content. A separate fixture ran two independent workspaces concurrently and recovered an active task with the same execution/session/message after an MCP client reconnect; both reports and parent reviews were valid. An exact-session correction produced a valid accepted follow-up while preserving the predecessor artifact. A controlled supervisor restart recovered the same active execution/session/message with one dispatch intent, but that worker finished without a report; an accepted review was correctly rejected. A fresh cancellation case used a same-server abort acknowledgement plus a separate exact-turn snapshot to prove stop, finalize `cancelled`, and release ownership. Another cancellation interrupted an active approved script, preserved its partial write, and captured that file as an immutable artifact. A backend restart recovered the exact recorded session/message with no observed replay, but remained unresolved and retained its reservation. An older denied-permission case also remains `cancelling/unknown` after a restart, with its reservation held. All fixture supervisors were stopped without clearing unresolved records or resubmitting prompts. The live run also found and fixed a non-Git report-permission root mismatch, a missing JSON Schema in the frozen prompt, and deadline-abort outcome classification. Exact IDs and artifacts are in the [first isolated run](../.work/v2/live-2026-10-12/summary.md), [concurrent and reconnect checks](../.work/v2/live-2026-10-12/extra.md), [correction and restart checks](../.work/v2/live-2026-10-12/extra2.md), and [cancellation and backend-restart checks](../.work/v2/live-2026-10-12/extra4.md).

The final manifest now separates baseline-relative file additions, modifications, and deletions and captures changed file bytes, but it does not produce a textual patch relative to pre-existing dirty edits. Git ignored paths outside declared targets and undeclared non-Git paths remain explicit coverage limits under spec §5.2. The v2 release has no legacy import or continuation surface; existing stored bytes are left untouched during upgrade. Keep `execution_supported: false` until the remaining release gates pass. The accepted plugin boundary FIXME remains documented separately and does not count as a passed certification check.
