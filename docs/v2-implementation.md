# V2 implementation status

This branch begins the implementation of [spec-v2.md](spec-v2.md). It is a development branch, not a v2 release. The v1 plugin remains the installed execution path until the v2 release gates pass.

## Implemented

- Strict task packet, worker report, and parent review contracts with generated JSON Schemas.
- Exact-version OpenCode SDK adapter, a compatibility manifest, and live probes against OpenCode 1.18.35 using `llama.cpp/laguna-s-21`.
- SQLite single-writer task records, revisions, scoped idempotency, dispatch intents, exact session binding, resource reservations, event cursors, artifact hashes, and structural review acceptance checks.
- A private local RPC supervisor, ten MCP tool definitions, read-only diagnostics, dry-run start validation, a bundled Node CLI, workspace baseline checks, and read-only v1 record inspection.
- Automated tests for the implemented contracts and storage/transport behavior on Node 24.15.0 and the development host.

The implementation used bounded OpenCode subagent assignments with model `llama.cpp/laguna-s-21`. The schema worker's deliverable was reviewed and integrated. The compatibility worker returned partial findings used for parent-led probes. The legacy and workspace workers exhausted their turns without deliverables; their work was not accepted or integrated. Private job records and reviews are under `.work/v2/delegation`.

## Current gate

`start_task` with `dry_run: true` validates the packet, configured model, limits, workspace roots, and starting-state manifest without inference or durable admission. A real start returns `UNSUPPORTED_BACKEND`. `continue_task`, `cancel_task`, and `respond_to_request` are also disabled. The compatibility pair remains `execution_supported: false` in `plugins/opencode-agents/compatibility.json`.

The live adapter probes verified exact session creation/recovery, caller-assigned message correlation, async response, a completed Laguna turn, a pending permission request, and scoped rejection. A rejected tool-call step with no final assistant response is correctly classified as unresolved. These checks do not yet certify effective worker permissions, `allow_once`, cancellation races, question handling, structured output, or full event recovery. Neither an idle session nor a successful HTTP response is treated as parent acceptance.

## Next implementation steps

1. Finish the exact OpenCode compatibility probes and effective policy checks. Keep real dispatch disabled until the pair and worker profile are certified.
2. Implement durable queue admission, frozen prompts and baseline artifacts, dispatch reconciliation, deadlines, input requests, cancellation, report capture, and follow-up executions. Exercise the crash windows with a fake backend before enabling execution.
3. Complete the CLI operations, v1 import, plugin MCP packaging, skill/profile resources, read-only installed smoke test, and release manifest.
4. Run the full deterministic and real-OpenCode gates in §19 of the specification before changing the release status or replacing the v1 plugin path.
