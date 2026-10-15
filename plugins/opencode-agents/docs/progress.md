# Native worker checkpoints

Managed OpenCode/SDK 1.19.0 workers can call `report_progress` in bounded build
and read-only inspection assignments. The tool is staged in a private, hashed
directory, with no dependency installation or project writes. Completed tool
metadata is admitted only after verifying the current assistant turn's session,
message, parent message and part identity. Artifact and request references must
belong to the execution. Attribution responses are capped at 256 KiB.

Checkpoints contain a stage, short summary, completed and remaining items, an
optional blocker, and evidence IDs. They cannot reply to requests, complete tasks,
change permissions or replace final reports. The existing final report and parent
review remain authoritative. OpenCode may persist its own native tool messages;
the supervisor creates no durable checkpoint log or per-checkpoint files.

## Reading progress

Call `opencode_get_progress` with `scope_id`, `task_id` and `execution_id`.
Pass the returned opaque `next_cursor` as `after_cursor` on the next call. Reads
are exclusive, retryable and advisory: they perform no inference, lifecycle
mutation, consumer acknowledgement or history eviction. Empty reads preserve the
cursor. `include_snapshot` is false by default; ordinary reads return unseen
checkpoints only. The JSON schemas and [tool reference](../skills/opencode-agents/references/tools.md)
describe the fields.

`opencode_wait_tasks` accepts `execution_id` and `after_progress_cursor` on a
target and wakes on a new checkpoint or gap. Wait and task responses include
compact availability/cursor hints, without checkpoint bodies. Runtime observations
have timestamps and describe cached backend/request/task observations. A stream
disconnect does not assert that the backend is unreachable.

Restart, disconnect, attribution or publication failure, retention, aggregate
eviction and terminal expiry can produce an explicit `gap`. Attribution and
publication failures use the reason `attribution_failure` while the event stream
remains connected. A gap reports missed history and supplies a recovery cursor at the
current head, with the latest snapshot when available. Retain that cursor rather
than replaying old history. Malformed, future and cross-execution cursors fail.

## Limits

- Each checkpoint is at most 4,096 UTF-8 bytes, with at most five completed,
  remaining and evidence entries. Workers should report roughly once per minute
  and at material milestones or blocker transitions.
- Per execution: 100 retained records and a 256 KiB accounting budget, including
  bounded deduplication and rate metadata. At most 60 admissions per minute,
  with 12 slots reserved for blocker transitions. `dropped_count` counts rejected
  submissions and failed attribution or publication attempts; intentional shutdown
  aborts are excluded. No error bodies are retained.
- The coordinator reserves 15 MiB for buffers and 1 MiB for bounded runtime
  observations. These are accounting budgets, not measurements of V8 heap usage.
  Terminal buffers expire after 30 minutes through supervisor maintenance.
- Pages default to five updates and 8,192 bytes; maximums are 20 and 32,768.
  The byte limit includes the full structured response, runtime metadata, cursors
  and snapshots. If an explicit snapshot leaves no room for the next checkpoint,
  increase `max_bytes` or disable `include_snapshot`.

## Local validation, October 15, 2026

OpenCode 1.19.0, SDK 1.19.0, Node 24.19.0 and `llama.cpp/muse-glimmer-30b`
were used against the operator's authorized loopback provider. A frozen read-only
audit produced two checkpoints before completion and a valid final report; parent
review stayed pending. Cursor advancement produced an empty delta, and waits
delivered hints only.

The wait-driven fixture measured 1,170 bytes of checkpoint records, 4,984 bytes
across five progress responses, and 44,764 bytes across all parent-visible MCP
responses (start, task, wait, progress and final report). These are serialized JSON
response sizes for one run, not token counts or a transcript savings comparison.

The live lifecycle runner passed same-session continuation, supervisor restart
with exact identity recovery, active cancellation with partial artifacts retained,
and backend restart followed by exact cancellation. Each recorded one dispatch.
Permission denial was acknowledged, but that fixture timed out without a final
report; this establishes denial delivery and deadline enforcement, not successful
worker completion. Cancellation fixtures intentionally had no final report.

From `runtime`, after building, reproduce on an authorized local provider:

```bash
node scripts/release/progress.mjs --execute --out /tmp/progress-evidence-new \
  --binary /absolute/path/opencode --model muse-glimmer-30b --route http://127.0.0.1:8124/v1
node scripts/release/live.mjs --execute --out /tmp/lifecycle-evidence-new \
  --binary /absolute/path/opencode --model muse-glimmer-30b \
  --cases live4,live6,live7,live8,live9
```

Output paths must be new. The progress runner records byte metrics and validates
final reports without reading a full worker conversation. Full cross-platform
execution and host/plugin discovery certification remains pending; these local
checks do not enable `execution_supported` or attached execution.
