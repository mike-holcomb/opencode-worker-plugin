# Invocation, monitoring and recovery

Requires Python 3.11+, POSIX process groups, an independently installed OpenCode
CLI and an already configured provider/model. The helper uses standard libraries
only and neither configures providers nor checks credentials. A model label alone
does not establish endpoint routing. Verify configuration within project policy.
Check the installed `opencode run --help` for compatibility.

## Paths and preview

Set these to real absolute paths supplied by the installed skill and task context;
these are user-supplied examples, not shell-discoverable defaults:

```bash
SKILL_DIR='/absolute/installed/skills/opencode-agents'
PROJECT_DIR='/absolute/consuming-project'
PRIVATE_DIR='/absolute/private-job-parent'
MODEL='configured-provider/configured-model'
(
  umask 077
  mkdir -p "$PRIVATE_DIR/tasks" "$PRIVATE_DIR/reports"
  cp "$SKILL_DIR/assets/task-lite.md" "$PRIVATE_DIR/tasks/check.md"
)
```

Fill in the task before launch. The helper/template paths are relative to the
installed skill location. `--cwd` selects the worker directory. Relative task-file
and out paths resolve from the invoking process directory, **not** `--cwd`.
The task must exist and job directory must be new. Keep the bundle read-only.

```bash
python3 "$SKILL_DIR/scripts/opencode_agent.py" run \
  --cwd "$PROJECT_DIR" --model "$MODEL" \
  --task-file "$PRIVATE_DIR/tasks/check.md" --out "$PRIVATE_DIR/check-01"
```

Preview prints the plan without creating a directory or launching a process.
Repeat with `--execute` within established authorization. Execution timeout is
1800 seconds by default; `--timeout-seconds` accepts finite positive values.
Binary lookup is explicit `--opencode`, then PATH, then `~/.opencode/bin/opencode`.

Launch uses `run --pure --format json`, explicit model, `--agent build` by default,
and a frozen task attachment. No `--auto`, sharing, endpoint override, or global
continuation is added. OpenCode permissions remain in force. Task write boundaries
are instructions, not filesystem enforcement. Provider configuration controls data
destination. Task bodies stay out of arguments/status, but paths, titles and command
metadata are visible; avoid secrets in them. OpenCode may retain sessions/logs
outside the job directory.

## Observation

Keep and poll the foreground terminal/tool process handle. Separately:

```bash
python3 "$SKILL_DIR/scripts/opencode_agent.py" status "$PRIVATE_DIR/check-01"
python3 "$SKILL_DIR/scripts/opencode_agent.py" status \
  "$PRIVATE_DIR/check-01" "$PRIVATE_DIR/check-02" \
  --watch --interval 5 --wait-seconds 30
```

Status reads local records and verifies process start/command identity with `ps`,
not just the saved PID. Denied inspection means unknown, not dead. Missing exit
record means unconfirmed outcome even if the child disappeared. Quiet logs and
`step_finish` events do not prove exit. Status never prints raw tool text/reasoning.

Watch expiration returns 2 and leaves workers running. Execution timeout or
interruption terminates the helper-owned process group and records the outcome
when possible. Server-side generation may still require reconciliation. There is
no automatic retry, daemon, queue, rate limiter or stop-by-saved-PID API.

## Artifacts and exits

The new job directory is 0700; helper-created files are 0600. Recursively created
intermediate directories do not inherit the leaf's mode; prepare a private parent.
Worker-created reports have their own permissions. Keep real packets, credentials,
logs, reports, data and machine configuration out of source/distribution.

| Artifact | Meaning |
| --- | --- |
| task.md | Frozen assignment |
| job.json | Command, cwd, task hash and process identity |
| events.jsonl | Private raw JSON event stream |
| stderr.log | Private child diagnostics |
| exit.json | Child exit, wrapper outcome and event summary |

| Command outcome | Exit code |
| --- | --- |
| Run process success; deliverable still needs review | 0 |
| Zero child exit with top-level event error, malformed complete lines, empty/incomplete output | 1 |
| Child failure | Child code; signal converted to 128 + signal |
| Invalid invocation or existing destination | 2 |
| Execution timeout | 124 |
| Launch/I/O failure | 127 |
| Interruption | 130 |
| Status: terminal success or matching live process in one-shot mode | 0 |
| Status: recorded failed job | 1 |
| Status: unconfirmed state or watch expiration | 2 |

Recoverable tool errors are counted separately and can coexist with process
success. Review delivered work regardless of exit status.

## Follow-up and historical jobs

Reconcile the original process, edits and reports. After confirming its outcome,
copy the exact recorded `session_ids` value from status. Prepare a bounded new task
and a new output directory, then use `--session` with that ID, intended model and
`--execute` within authorization. Never guess IDs, use global `--continue` among
workers, or replace a worker solely because observation timed out.

Historical job records remain inspectable; leave their stored paths unchanged.
They are audit records, not commands to replay. Continue with the current helper
and recorded ID only if that OpenCode session still exists in the same environment.
For deliberate blind work choose a fresh session without earlier verdicts.

## Troubleshooting

- Unsupported flag: compare CLI version/help with documented tested versions.
- Permission failure: inspect the specific denial and authorized write paths; do
  not add automatic approval flags to bypass policy.
- No summary despite exit 0: inspect events for the relevant tool failure; record
  awaiting evidence or needs correction, not accepted.
- Unknown status: inspect the original handle and identity, do not kill by saved PID.
- Stale source: recheck affected evidence before accepting; fresh context does not
  reset a checkout or shared service.
