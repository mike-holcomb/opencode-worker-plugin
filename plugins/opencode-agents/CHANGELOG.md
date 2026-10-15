# Changelog

## 2.1.0 — release candidate

- Fix concurrent observations restoring `running` or `waiting_input` after durable cancellation intent; keep cancellation actionable while preserving normal-completion races ([#2](https://github.com/mike-holcomb/opencode-worker-plugin/issues/2), PR #5).
- Refresh pending permissions during cancellation, allow exact permission denial until forced termination begins, renew fresh abort proof after recovery, and expose bounded stop-confirmation diagnostics ([#4](https://github.com/mike-holcomb/opencode-worker-plugin/issues/4), PR #6).
- Recover unconfirmed stops after 30 seconds by terminating the exclusively owned managed worker process group; release reservations only after proven exit and finalization. Persist worker identity and recovery evidence, and snapshot existing SQLite state before schema repair.
- Add native `report_progress` worker checkpoints and the read-only `opencode_get_progress` MCP tool, bringing the parent toolkit to eleven tools ([#3](https://github.com/mike-holcomb/opencode-worker-plugin/issues/3), PR #7).
- Bound checkpoint memory, payloads, rate and retention; use execution-bound incremental cursors, explicit snapshots and recovery gaps after restart, disconnect, attribution failure or eviction. Progress remains advisory; final reports and parent review remain durable and authoritative.
- Let bounded waits wake for checkpoints without replaying their content. Freeze and isolate the bundled native tool; disable project configuration discovery for managed workers.
- Target OpenCode and SDK 1.19.0 with exact API-pair checks. Align plugin, runtime, diagnostic and MCP versions to `2.1.0`.

See [2.1.0 release notes](https://github.com/mike-holcomb/opencode-worker-plugin/blob/main/docs/releases/v2.1.0.md) for upgrade instructions,
validation and remaining execution-certification limits. Publication is pending.

## 2.0.0-dev.0 — development

- Add a TypeScript/Node MCP runtime with durable task admission, exact session recovery, bounded worker profiles, artifact capture, and parent review.
- Add ten MCP tools and a shared diagnostic CLI.
- Package a deterministic Node-built archive with a read-only installed smoke test.
- Add twelve v2 evaluation scenarios and a Node preparation/check harness.
- Remove the Python job launcher, legacy import/inspection commands, and comparison tooling.

Release certification is pending; see [validation](docs/validation.md).
