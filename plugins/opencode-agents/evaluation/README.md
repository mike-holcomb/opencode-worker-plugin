# Comparative orchestration pilot inputs

This directory contains a diagnostic pilot of twelve synthetic tasks. It is
evaluation-only: it does not change the runtime plugin, add a worker admission
controller, create worktrees, launch inference, or enforce a reporting format.
The fixtures are deliberately small, but each task exercises a coordination or
verification decision that can be missed by a format-only test.

## What is frozen before a run

`cases.json` is the pilot manifest. Its `task` and fixture paths are the only
inputs copied into a prepared work directory. Objective checks are in the same
manifest but are never copied into the work directory or included in `task.md`.
The checks must be reviewed and frozen before looking at a worker answer. Do not
edit them after the first condition is run; if a check is wrong, record the
manifest revision, stop the comparison, and rerun all affected conditions from
fresh work directories.

Automated checks inspect only observable artifacts: files, bounded command exit
codes, changed paths, and explicit report markers. Markers are triage signals;
they do not establish that a claim is true. Every case therefore includes a
`parent_review` criterion for source support and acceptance judgment. The
checker reports it as `review_required`, never silently grading it as a pass.
The checker does not run model inference and does not claim a result for an
unrun condition.

## Prepare and check

All commands use Python's standard library and refuse to reuse an existing
output directory. Run them from this directory or pass absolute paths:

```text
python3 prepare.py --case lookup-timeout --condition A --run-id pilot-01 \
  --out /tmp/pilot-01-A-lookup-timeout \
  --state /tmp/pilot-01-A-lookup-timeout.state.json
python3 check.py --case lookup-timeout \
  --workdir /tmp/pilot-01-A-lookup-timeout \
  --state /tmp/pilot-01-A-lookup-timeout.state.json
```

`prepare.py` creates `task.md`, the fixture files, `pilot-input.json`, and an
authoritative baseline at the separately supplied `--state` path. The baseline
is outside the worker workdir, so a worker cannot clear unauthorized edits by
rewriting its own snapshot. It does not copy `cases.json`, objective checks,
expected strings, or a hidden solution into the work directory. `check.py`
reads the manifest and external baseline, evaluates the frozen checks, and
writes JSON to stdout. A successful automated-only check exits 0; an automated
failure exits 1; a case with any required parent review exits 2; usage or
manifest/state errors are reported as CLI errors (normally exit 2 for argument
errors and exit 1 for a missing or invalid manifest).

For a fair comparison, prepare a new directory for every case × condition.
Never copy a worker's source edits, report, session, or task directory between
conditions. The runner may receive the prepared directory as its explicit
working directory, but the parent must supply the task file and reporting path
as part of its normal launch procedure.

## Twelve cases

| ID | Representative work | Tier / context | Automated observation |
| --- | --- | --- | --- |
| `lookup-timeout` | narrow lookup with a caller | lightweight / fresh | report cites defining symbol and caller |
| `log-regression` | verbose log investigation | standard / fresh | report identifies bounded request IDs and timeout count |
| `retry-clamp` | independent code change | standard / fresh | fixture tests pass and only allowed source changes occur |
| `wire-serialization` | coupled producer/consumer interface | full / fresh | round trip and legacy compatibility tests pass |
| `policy-contradiction` | qualitative review with conflicting evidence | full / fresh | parent review of contradiction and coverage |
| `negative-auth-claim` | unsupported negative claim | lightweight / fresh | bounded no-finding language and search bounds |
| `stale-snapshot` | missing or stale evidence | standard / fresh | report identifies revision mismatch and requests recheck |
| `scope-growth` | dependency discovered mid-task | standard / fresh | no unauthorized source edit and explicit escalation |
| `dirty-checkout` | preserve pre-existing edits | standard / fresh | pre-existing marker survives and target behavior changes |
| `false-completion` | process success with incomplete deliverable | standard / fresh (simulated predecessor) | required artifact and separate parent acceptance are visible |
| `context-reconcile` | continued versus fresh context choice | full / fresh (simulated predecessor) | parent review of verified versus unverified carry-over |
| `failed-checks` | implementation with a failing check | standard / fresh | failing command is reported with its exit status |

The last two columns describe the frozen check intent, not a fabricated result.
No inference is run as part of preparing this package.

The source-test fixtures have deterministic starting outcomes, recorded in the
manifest and verified locally: `retry-clamp` is 3 tests / 2 failures;
`wire-serialization` is 2 tests / 1 error; `dirty-checkout` is 1 test / 1
failure; and `failed-checks` is 2 tests / 1 error. These are baseline fixture
properties, not worker or model results.

## A/B/C comparison protocol

Run each cell from an equivalent newly prepared input directory.

* **A — local parent:** the parent performs the task directly with the same
  parent model, source snapshot, task text, permissions, and checks. No worker
  is launched.
* **B — historical standard:** the parent uses the existing skill and its
  general task template. Keep the task decomposition, model, permissions,
  input state, and acceptance checks identical to C.
* **C — proposed tiers:** the parent uses the new lightweight, standard, or
  full tier, selected in `cases.json`, with its fresh or simulated-predecessor
  context policy and progressive reporting. Keep decomposition and all other
  inputs identical to B.

Before the first inference, record exact parent and worker model IDs, endpoint,
plugin/skill revision, and the operational wall-time limit. The model IDs are
intentionally not invented in this fixture package. Use one fixed parent model
in A/B/C and one fixed worker model in B/C; a model change starts a new pilot.
The runner does not enforce a token ceiling, so token-matched comparison is
unavailable until a separately authorized runner enforces one. Record actual
parent, worker, summarization, and correction usage separately, along with the
fixed wall-time limit below.

```json
{
  "token_budget": null,
  "matched_token_comparison": "unavailable until enforced by the runner",
  "parent_wall_time_seconds": {"A": 360, "B": 360, "C": 360},
  "worker_wall_time_seconds": {"B": 180, "C": 180}
}
```

Report, per condition and case: accepted deliverables and missed requirements;
false acceptance and unnecessary rejection; parent context added (handoffs,
summaries, selected evidence, diagnostics, corrections); total inference and
cost; wall time and endpoint contention; repeated discovery/correction and
parent verification effort; and stale-input, ownership, and interface failures.
Keep parent context and cumulative billed input as separate measures. Preserve
raw private evidence outside these fixtures. Classify failures as unclear
assignment, lost context, wrong assumption, missing evidence, stale state,
premature completion, or incorrect verification. A successful process exit is
not parent acceptance, and a compact worker report is not source evidence.

Every case's `parent_review` requires inspection of the task result and relevant
fixture evidence. Review full source support, exact counts, correlation versus
causation, ownership of acceptance, state freshness, and whether the parent
rejected false completion. The CLI makes these cases visible but cannot make
those judgments.
