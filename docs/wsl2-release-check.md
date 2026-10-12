# WSL2 release evidence

Run inside an actual WSL2 Linux distribution, from its Linux filesystem. Keep this
checkout and all evidence outside `/mnt/c`; this campaign certifies the native
Linux filesystem in WSL2. Native Windows and Windows-mounted workspace paths are
not covered. The runner verifies the WSL2 kernel and records it in `result.json`.

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
required check. Once OpenCode 1.18.35 and the authorized existing route at
`http://127.0.0.1:8124/v1` are available in WSL2, the current live-gap runner is:

```sh
node plugins/opencode-agents/runtime/scripts/release/live.mjs --execute --binary /absolute/path/to/opencode --out /tmp/v2-wsl2-live --cases live,t20
```

The runner covers all ten live cases and the review-channel attempt. Parent
review of the exported artifacts is required before any case passes. Do not
create a tunnel to make this command work. It requires a route already authorized and reachable from WSL2.
Keep live evidence private: it includes execution state, provider configuration,
and local transport identity. Share redacted summaries and immutable report
artifacts, not credentials or the complete private state directory.

The development label and compatibility flag stay in place until the returned
results and all remaining release gates have passed parent review.
