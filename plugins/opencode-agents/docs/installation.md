# Installation, update, and rollback

## Install the published release

[OpenCode Agents v2.0.0](https://github.com/mike-holcomb/opencode-worker-plugin/releases/tag/v2.0.0)
is the current full GitHub release. Its tagged plugin/runtime manifests still
identify the package as `2.0.0-dev.0`. Select the release with `--ref v2.0.0` even
if the installed package displays that internal version.

1. Install Node.js 24.15 or later within the 24.x line. The `node` on the Codex
   host's PATH must resolve to that supported line; Node 25/26 are not supported.
2. Install OpenCode 1.18.35 and configure the authorized provider/model separately
   if you intend to execute tasks. Installation does not install OpenCode,
   download models, or run inference.
3. Install from the repository marketplace:

   ```bash
   codex plugin marketplace add mike-holcomb/opencode-worker-plugin --ref v2.0.0
   codex plugin add opencode-agents@opencode-worker-plugin
   ```

4. Start a fresh Codex session and select `opencode-agents:opencode-agents`.
   Configure the runtime below before submitting live tasks.

The release also provides a prebuilt ZIP, a per-file manifest, and a `.sha256`
sidecar. End-user installation needs no Python, TypeScript compilation, or
`npm install`. Source build instructions are in the [README](../README.md).

## Configure execution

The shipped compatibility manifest has `execution_supported: false`. Publishing
v2.0.0 did not change that setting. Live managed tasks require the private
`development_execution` opt-in described below; without it, ordinary task
admission returns `UNSUPPORTED_BACKEND`.

Store runtime configuration in `config.json` inside the state directory:

- macOS: `~/Library/Application Support/opencode-agents/`
- Linux/WSL2: `$XDG_STATE_HOME/opencode-agents/`, or
  `~/.local/state/opencode-agents/` when `XDG_STATE_HOME` is unset.

`OPENCODE_AGENTS_STATE_DIR` overrides the state directory;
`OPENCODE_AGENTS_CONFIG` selects a separate configuration file. Set overrides in
the environment inherited by the Codex host. Keep state and credentials outside
the installed plugin.

The configuration requires `schema_version: 1`, `project_roots`, `read_roots`,
`opencode_binary` (an absolute path), and `models`. Model entries contain
`provider_id`, `model_id`, and `destination` matching the operator's authorized
OpenCode route. Optional `limits` control concurrency, timeouts, and artifact size.

Known plugin boundary FIXME: managed OpenCode 1.18.35 can load a project plugin introduced after the toolkit's launch-time inspection. Use only trusted workspaces under the documented exception; plugin suppression and the outstanding certification checks remain unverified. Do not treat worker tool permissions as containment for plugin code.

For a trusted local test workspace, add this field to the operator's private `config.json` alongside `project_roots`, `opencode_binary`, and `models`:

```json
"development_execution": {
  "enabled": true,
  "trusted_workspaces": ["/absolute/canonical/project"]
}
```

Only the exact resolved workspace is trusted; listing its parent does not trust children. This opt-in applies to managed OpenCode 1.18.35 with the pinned SDK and matching OpenAPI digest. It does not bypass required capabilities, frozen provider routing, worker permissions, MCP disablement, plugin preflight, or report policy. Attached execution stays disabled. `doctor.backend.certifiedPairs` and `doctor.backend.executionTested` remain false, and `compatibility.json` remains execution-disabled. Removing the field blocks new starts and follow-ups; already admitted executions retain their frozen authorization and must be cancelled explicitly if they should stop.

The Codex plugin declares one bundled stdio MCP server in `.mcp.json`, with a relative argument pointing to `bin/opencode-agents.mjs`. A read-only bundle smoke test exercises that command from the plugin directory. In an isolated local marketplace install, Codex CLI 0.162.0 resolved the MCP working directory to its plugin cache and ran the bundled diagnostic under Node 24.19.0. Codex CLI 0.162.1 also passed Git-backed installation from the historical `v2.0.0-dev.0` tag. Marketplace installation from `v2.0.0` remains unverified; the published ZIP passed a separate read-only installed-bundle smoke test. Ensure that the host's `node` resolves to a supported Node 24.x version before launching the plugin. The `opencode-agents:opencode-agents` skill describes the ten v2 MCP tools. State defaults to platform application data and may be moved with `OPENCODE_AGENTS_STATE_DIR`; keep state, credentials, reports, and task workspaces outside the installed plugin.

Use `opencode_health` from Codex for read-only prerequisites. From an extracted plugin directory, run `node ./bin/opencode-agents.mjs doctor`; installing the plugin does not add a global shell executable. The executable does not compile TypeScript or run `npm install` at startup. The installed bundle includes compiled JavaScript, compatibility data, schemas, worker profiles, and dependency license notices.

An operator can add `attached_backend` to the private configuration for read-only inspection: `{ "url": "http://127.0.0.1:4096/", "workspace": "/absolute/project", "storage_namespace": "/absolute/opencode/state", "password_env": "OPENCODE_SERVER_PASSWORD" }`. The URL must be a literal loopback HTTP origin; `password_env` is optional and names an environment variable containing the server password. `doctor` and `opencode_health` only GET health, path, effective configuration, and OpenAPI identity. They report unreachable endpoints and workspace, storage, or policy mismatches. Attached execution remains disabled because runtime plugin suppression and exact session ownership are not certified; the toolkit never changes or stops an attached server.

## Cancelling a managed execution

`opencode_cancel_task` commits cancellation intent and continues reconciling the exact execution. Abort acknowledgement alone does not release workspace or shared-resource reservations. Pending requests are refreshed during cancellation; `opencode_respond_to_request` accepts permission `deny` replies until forced termination begins, but cannot authorize more work. A stale revision or binding requires a fresh observation. An uncertain reply is never automatically sent again.

If stopping remains unconfirmed 30 seconds after cancellation was recorded, the supervisor automatically terminates its exclusively owned managed worker process group. It sends SIGTERM, allows up to five seconds, then sends SIGKILL and allows another five seconds for confirmed exit. Reservations remain held until exit is proven and evidence finalization completes. Normal completion observed before termination keeps its completed or failed outcome; cancelled work resolves as `cancelled`, or `timed_out` for cancellation originating from the execution deadline.

Read `cancellation_diagnostic` events through `opencode_get_task` or `opencode_wait_tasks` for status, active-tool and pending-request counts, fresh abort proof, backend availability, and recovery blockers. Changed observations and a 30-second heartbeat are recorded without raw worker output or credentials; the optional raw `diagnostic_cursor` log is separate. Recovery intent and exit confirmation are durable. If the original process handle is lost before exit confirmation, the task stays unresolved with `owned_process_handle_unavailable`; a replacement process cannot prove the original worker stopped. The supervisor never discovers process credentials, signals an attached server, or clears reservations to conceal missing proof. Detached subprocesses that deliberately leave the managed process group are outside this recovery mechanism.

## Upgrade and rollback

Reconcile active tasks and drain the supervisor before activating an incompatible runtime. Preserve the state database and reports. When an existing database needs a schema upgrade, the runtime writes a SQLite snapshot under the state directory's `backups/` before changing its schema and aborts if that snapshot fails. Keep an independent operator backup for rollback. Do not run old and new supervisors against one state directory. Rollback uses a matching runtime and backup after reconciliation. Uninstall does not cancel accepted work or delete evidence.

The v2 installation has no legacy job import or launcher. New work starts through the MCP task API. Existing user files and database rows are left untouched during upgrade; back up the state database before schema changes.

See [validation](validation.md) for the recorded evidence and remaining certification checks.
