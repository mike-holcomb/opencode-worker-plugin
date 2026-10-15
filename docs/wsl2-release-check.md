# WSL2 release evidence

Run inside an actual WSL2 Linux distribution, from its Linux filesystem. Keep this
checkout and all evidence outside `/mnt/c`; this campaign certifies the native
Linux filesystem in WSL2. Native Windows and Windows-mounted workspace paths are
not covered. The runner verifies the WSL2 kernel and records it in `result.json`.

Use branch `release/2.1.0` from the repository and record `git rev-parse HEAD`.
The historical handoff bundle at `ceb4c272a91120baee02a995178e79ae7b558945`
does not contain the 2.1.0 changes; use the current candidate for both automated
and live checks. See the [Linux live handoff](linux-release-check.md) for
the private-state handling and parent-review requirements that also apply here.

From the repository root, install the locked development dependencies once:

```sh
cd plugins/opencode-agents/runtime
npm ci
cd ../../..
```

Select Node **24.15.0**, then run:

```sh
node plugins/opencode-agents/runtime/scripts/release/platform.mjs --require-wsl2 --out /tmp/v2-wsl2-node-24.15.0
```

Repeat under Node **24.21.0**, with output `/tmp/v2-wsl2-node-24.21.0`.
Each output path must be new. Return both evidence directories, including the
command logs, result JSON, ZIP, inventory, and checksum sidecars. Record the Git
commit you checked out. A failed command keeps its evidence and exits nonzero;
use a new output directory for any rerun.

These commands perform no inference. Managed live certification is a separate
required check. Once OpenCode 1.19.0 and the authorized existing route at
`http://127.0.0.1:8124/v1` are available in WSL2, the current live-gap runner is:

```sh
node plugins/opencode-agents/runtime/scripts/release/live.mjs --execute --binary /absolute/path/to/opencode --out /tmp/v2-wsl2-live --cases live,t20 --permission-decisions /tmp/v2-parent-decisions.json
node plugins/opencode-agents/runtime/scripts/release/usage.mjs /tmp/v2-wsl2-live
node plugins/opencode-agents/runtime/scripts/release/export.mjs /tmp/v2-wsl2-live /tmp/v2-wsl2-portable
```

The runner covers all ten live cases and the review-channel attempt. Parent
review of the exported artifacts is required before any case passes. Do not
create a tunnel to make this command work. It requires a route already authorized and reachable from WSL2.
Keep live evidence private: it includes execution state, provider configuration,
and local transport identity. Share redacted summaries and immutable report
artifacts, not credentials or the complete private state directory. Inspect and
return `/tmp/v2-wsl2-portable`; the exporter excludes private runtime directories
and verifies exported artifact hashes. Keep the original campaign locally for recovery.

The execution-disabled compatibility flag stays in place until the returned
results and all remaining certification gates have passed parent review.

Watch for `parent_permission_needed` and record an explicit scoped decision as
described in [additional permission requests](release-validation.md#additional-permission-requests).
Do not approve an unfamiliar command merely to keep the suite moving.
