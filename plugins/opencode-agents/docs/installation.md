# Installation, update, and rollback

## Development package

`2.0.0-dev.0` is a development build, not a published release tag. Build and smoke the pinned bundle as shown in the [README](../README.md). Release execution requires certification in the compatibility manifest; the private development opt-in below permits testing the pinned pair without changing that certification status. Install Node.js 24.15+ within 24.x and configure OpenCode and the chosen provider/model independently; installation does not download models or run inference.

Known plugin boundary FIXME: managed OpenCode 1.18.35 can load a project plugin introduced after the toolkit's launch-time inspection. Continued development uses trusted workspaces under the user's accepted exception; this does not certify plugin suppression or remove the remaining release checks. Do not treat worker tool permissions as containment for plugin code.

For a trusted local test workspace, add this field to the operator's private `config.json` alongside `project_roots`, `opencode_binary`, and `models`:

```json
"development_execution": {
  "enabled": true,
  "trusted_workspaces": ["/absolute/canonical/project"]
}
```

Only the exact resolved workspace is trusted; listing its parent does not trust children. This opt-in applies to managed OpenCode 1.18.35 with the pinned SDK and matching OpenAPI digest. It does not bypass required capabilities, frozen provider routing, worker permissions, MCP disablement, plugin preflight, or report policy. Attached execution stays disabled. `doctor.backend.certifiedPairs` and `doctor.backend.executionTested` remain false, and `compatibility.json` remains execution-disabled. Removing the field blocks new starts and follow-ups; already admitted executions retain their frozen authorization and must be cancelled explicitly if they should stop.

The Codex plugin declares one bundled stdio MCP server in `.mcp.json`, with a relative argument pointing to `bin/opencode-agents.mjs`. The read-only bundle smoke test exercises that command from the plugin directory, but host resolution of plugin-relative MCP commands remains a release gate. Until the installed Codex host behavior is verified, configure a dedicated MCP entry with the absolute installed executable path and `mcp` argument. The `opencode-agents:opencode-agents` skill describes the ten v2 MCP tools. State defaults to platform application data and may be moved with `OPENCODE_AGENTS_STATE_DIR`; keep state, credentials, reports, and task workspaces outside the installed plugin.

Use `opencode-agents doctor` for read-only prerequisites. The executable does not compile TypeScript or run `npm install` at startup. The installed bundle includes compiled JavaScript, compatibility data, schemas, worker profiles, and dependency license notices.

An operator can add `attached_backend` to the private configuration for read-only inspection: `{ "url": "http://127.0.0.1:4096/", "workspace": "/absolute/project", "storage_namespace": "/absolute/opencode/state", "password_env": "OPENCODE_SERVER_PASSWORD" }`. The URL must be a literal loopback HTTP origin; `password_env` is optional and names an environment variable containing the server password. `doctor` and `opencode_health` only GET health, path, effective configuration, and OpenAPI identity. They report unreachable endpoints and workspace, storage, or policy mismatches. Attached execution remains disabled because runtime plugin suppression and exact session ownership are not certified; the toolkit never changes or stops an attached server.

## Upgrade and rollback

Reconcile active tasks and drain the supervisor before activating an incompatible runtime. Preserve the state database and reports. When an existing database needs a schema upgrade, the runtime writes a SQLite snapshot under the state directory's `backups/` before changing its schema and aborts if that snapshot fails. Keep an independent operator backup for rollback. Do not run old and new supervisors against one state directory. Rollback uses a matching runtime and backup after reconciliation. Uninstall does not cancel accepted work or delete evidence.

The v2 installation has no legacy job import or launcher. New work starts through the MCP task API. Existing user files and database rows are left untouched during upgrade; back up the state database before schema changes.

See [validation](validation.md) for the current development evidence and remaining release checks.
