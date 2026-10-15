# Recovery and follow-ups

Retain the original `scope_id`, task and execution IDs, operation key, and latest revision. If a tool call times out or MCP disconnects, query `opencode_list_tasks` and `opencode_get_task` before acting. Repeat a mutation only with the identical operation key and semantic payload. Never submit an ambiguous prompt under a new key.

Events after `after_cursor` describe material changes; a stream gap can omit transient progress. The current task snapshot is authoritative for phase, pending requests, and operational resolution. A quiet session or HTTP acknowledgement is not completion.

For a current permission request, use its exact request ID and revision. Reply only within established authorization and record a concise basis. If it expired, observe again. Cancellation has two steps: request stop, then observe confirmed stopping or an explicitly unresolved outcome. Keep the workspace reserved while stopping is uncertain; a replacement could conflict with a still-running worker.

`opencode_continue_task` requires a predecessor that is terminal **and** operationally resolved. `finalizing` is not eligible. `resume` continues the recorded backend/session/workspace tuple; `fresh` makes a new session with a curated handoff. Both create a new execution and report location. A changed objective, workspace, model destination, or permission profile needs a new linked task.

## Progress gaps

Retain scope, task, execution, and the separate opaque progress cursor. A progress read never repairs history or queries the backend. After restart, disconnect, retention/aggregate overflow, or terminal-buffer expiry, a gap explicitly marks missed history. Consume the optional bounded snapshot, advance to the returned head cursor, and continue with future checkpoints. A missing snapshot or unavailable channel does not authorize replacement work or cancellation. Final reports and review evidence remain durable through the existing workflow.
