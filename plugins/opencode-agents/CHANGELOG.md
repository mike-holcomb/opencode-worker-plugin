# Changelog

## Unreleased

- Target OpenCode and SDK 1.19.0 with exact API-pair checks.
- Add native worker checkpoint publication, bounded memory buffers, opaque incremental cursors, explicit recovery gaps, and the read-only `opencode_get_progress` MCP tool.
- Let bounded waits wake for checkpoints without replaying their content.
- Freeze and isolate the bundled native tool and document advisory progress boundaries.

## 2.0.0-dev.0 — development

- Add a TypeScript/Node MCP runtime with durable task admission, exact session recovery, bounded worker profiles, artifact capture, and parent review.
- Add ten MCP tools and a shared diagnostic CLI.
- Package a deterministic Node-built archive with a read-only installed smoke test.
- Add twelve v2 evaluation scenarios and a Node preparation/check harness.
- Remove the Python job launcher, legacy import/inspection commands, and comparison tooling.

Release certification is pending; see [validation](docs/validation.md).
