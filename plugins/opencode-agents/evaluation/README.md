# V2 evaluation scenarios

This directory holds twelve small, frozen scenarios for the v2 task interface. The Node harness prepares isolated workspaces and checks observable results. It never starts OpenCode, an MCP client, or model inference. A parent runs a v2 task separately, inspects its immutable artifacts, and owns the review decision.

`v2-cases.json` contains each task packet, fixture file hashes, and 69 frozen checks. The harness validates every packet against the bundled `schemas/task-packet.schema.json` and verifies the schema and fixture hashes before every command. The file scenarios cover narrow lookup, log investigation, retry bounds, a coupled v2 wire format, contradictory evidence, bounded negative findings, stale evidence, scope growth, dirty state, false completion, context reconciliation, and failed checks. Python files under `fixtures/` are sample project code and local unit tests, not an execution backend for the toolkit.

## Prepare one scenario

Use Node 24.15+ and a new workspace and state path for each run:

```sh
node harness.mjs validate
node harness.mjs list
node harness.mjs prepare --case lookup-timeout --run-id trial-01 \
  --out /private/tmp/v2-eval-trial-01-work \
  --state /private/tmp/v2-eval-trial-01-baseline.json
```

`prepare` refuses to reuse either path. It copies only the named fixture files and a short task description into the worker workspace. It writes the baseline outside that workspace. Its JSON output contains the frozen v2 packet to submit with the workspace path, configured model, limits, scope, and idempotency key through `opencode_start_task`. It does not copy the hidden check definitions into the worker workspace. A manifest or packet schema change after preparation makes the check reject the old baseline; start a fresh run instead of rewriting checks after seeing an answer.

The task's authoritative `summary.md` belongs to the execution report directory, not the project workspace. The packet's `allowed_writes` names only project outputs. After the task ends, export its immutable summary artifact to a parent-controlled file outside the worker workspace and retain the artifact SHA-256 from `opencode_get_task`. For example, the toolkit CLI can export the exact artifact:

```sh
opencode-agents artifacts export SCOPE TASK_ID EXECUTION_ID SUMMARY_ARTIFACT_ID /private/tmp/v2-eval-trial-01-summary.md
node harness.mjs check --case lookup-timeout \
  --workdir /private/tmp/v2-eval-trial-01-work \
  --state /private/tmp/v2-eval-trial-01-baseline.json \
  --result-file /private/tmp/v2-eval-trial-01-summary.md \
  --result-sha256 SUMMARY_ARTIFACT_SHA256
```

The harness rejects an exported result whose bytes do not match the supplied immutable artifact hash. `check` runs the frozen local `python3 -m unittest` commands where specified, with no shell interpolation and a bounded timeout. It checks result text, fixture changes, and write scope; it does not infer an answer. Its exit codes are 0 for all automated checks passing without parent review, 1 for an automated failure, 2 when automated checks pass but parent review is required, and 3 for invalid input or a broken frozen manifest. Every current scenario requires parent review, so exit 2 is the expected automated success state.

Parent review must inspect the report, final manifest, changed files, and source evidence. Text markers only show that a claim was written; they do not prove the claim. Record the review separately through `opencode_record_review` when its structural requirements are met. A completed worker turn, passing local command, or `review_required` checker result does not imply acceptance. Keep exact model/destination, revisions, elapsed time, observed usage or `not_captured`, artifacts, and decision for each run.
