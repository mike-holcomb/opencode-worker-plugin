# V2 MCP operations

The plugin registers eleven `opencode_` tools. Use their exposed input schemas for field spelling. `scope_id` is a durable parent workflow label. Generate a distinct 16–128 character `idempotency_key` for each mutation and reuse the exact key and payload when acknowledgement is lost. Read-only observation never starts inference.

| Tool | Use |
| --- | --- |
| `opencode_health` | Check runtime, backend compatibility, queue, and storage without inference. |
| `opencode_start_task` | Preview with `dry_run: true`, or admit one packet and return durable identities. |
| `opencode_get_task` | Read current execution state, pending requests, artifacts, review, and events after a cursor. |
| `opencode_get_progress` | Read bounded unseen checkpoints for the required exact execution, using an execution-bound progress cursor. |
| `opencode_list_tasks` | Recover task identities in a scope with filters and pagination. |
| `opencode_wait_tasks` | Wait up to 30 seconds for a material change; expiration does not stop work. |
| `opencode_continue_task` | Create a follow-up execution after a resolved predecessor, with `resume` or `fresh` context. |
| `opencode_cancel_task` | Record a stop request; inspect again for confirmed stopping. |
| `opencode_respond_to_request` | Reply to an exact current request with its revision and authorization basis. |
| `opencode_read_artifact` | Read a bounded range of a captured immutable artifact. |
| `opencode_record_review` | Append the parent's criterion-by-criterion evidence decision. |

Start and continue return after durable acceptance, which may still be queued. Keep the returned IDs, revision, and event cursor. Permission replies are `allow_once` or `deny`; `allow_once` is not a standing permission. Native questions may be unavailable on a backend. Treat `UNSUPPORTED_BACKEND` and `POLICY_MISMATCH` as dispatch gates, not prompts to use the old runner.

For event pagination, repeat `opencode_get_task` with `after_cursor` while `has_more_events` is true. An oversized event carries `detailTruncated.cursor`; pass it as `event_detail_cursor` to `opencode_get_task` and follow `event_detail.nextDetailCursor` until null. Decode and concatenate the base64 chunks to recover the exact durable detail. The preview is not the full blocker text.

The diagnostic executable supports `opencode-agents doctor` and the documented daemon, task, and artifact commands when installed. It uses the same durable services as MCP. Keep configuration, reports, state, and credentials outside the installed plugin; `OPENCODE_AGENTS_STATE_DIR` selects a private state location. OpenCode and its provider/model must be installed and configured separately.

Keep each execution's `next_cursor` after consuming a progress page. `after_cursor` is exclusive; unchanged streams return empty deltas. Retrying the same retained cursor deliberately replays its page. Progress cursors are opaque strings, distinct from numeric lifecycle event cursors, and cannot cross executions or continuations. Defaults are five updates/8 KiB, with caps of twenty/32 KiB. The byte budget covers the structured progress response; MCP framing adds transport overhead. Use `include_snapshot` only when needed; a large snapshot plus checkpoint may require a larger byte budget.

Progress is memory-first advisory data. Restart, disconnect, attribution or publication failure, and eviction return an explicit gap and a head recovery cursor, plus the latest snapshot when available. Attribution and publication failures use `attribution_failure` and increment `dropped_count` without reconnecting the event stream or changing the task lifecycle. Advance to the recovery cursor to consume future checkpoints. V1 does not recover checkpoints from message history. `unsupported` or `not_enabled` availability does not block normal execution. Runtime observation and last-checkpoint timestamps are separate; silence is not a stalled verdict.

To wake a wait for checkpoints, supply `execution_id` and `after_progress_cursor` on that target. The wait returns only a progress hint, never checkpoint bodies. Read unseen checkpoints when coordination benefits; avoid tight polling. The read endpoint contains no steering/reply operation and invokes no model or backend inspection.
