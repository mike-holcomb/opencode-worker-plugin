# Linux live evidence handoff

The automated Ubuntu 24.04 x64 matrix already passed on Node 24.15.0 and 24.21.0
at commit `ceb4c272a91120baee02a995178e79ae7b558945`. See
[CI evidence](releases/v2-evidence/ci-38291901986/run.json).
This handoff covers the separate real managed-execution suite on Linux.

Use a trusted disposable Linux filesystem workspace, Node 24.21.0, and the
independently installed OpenCode 1.18.35 executable. Check out the evidence branch
and record the exact commit:

```sh
git clone --branch release-evidence/v2-20261012 https://github.com/mike-holcomb/opencode-worker-plugin.git
cd opencode-worker-plugin
git rev-parse HEAD
cd plugins/opencode-agents/runtime
npm ci
npm run build
cd ../../..
```

The already authorized model route must be reachable from this Linux host at
`http://127.0.0.1:8124/v1` and expose `laguna-s-21`. Do not create a tunnel or
silently substitute another endpoint/model. If the route is unavailable, return
that blocked result for operator resolution.

```sh
node plugins/opencode-agents/runtime/scripts/release/live.mjs --execute --binary /absolute/path/to/opencode --out /tmp/v2-linux-live --cases live,t20 --permission-decisions /tmp/v2-parent-decisions.json
node plugins/opencode-agents/runtime/scripts/release/usage.mjs /tmp/v2-linux-live
```

Use a new output directory for each run. The suite uses private isolated state
and an exact-workspace development opt-in; it does not enable release execution
in the source manifest. Preserve failed attempts and unresolved ownership records.

Return `campaign.json` and each case's final snapshot, metrics, events, exported
immutable artifacts, packet, runtime hashes, and observed-usage sidecar. Include
the `workspace` fixture files and original preparation/baseline records for
parent review, including the peer workspace for concurrency and the dirty
worktree for case 2. Do not send HOME/XDG state, provider configuration,
connection credentials, or the SQLite state directory. Keep those private for
exact recovery and recording the parent's review. Remove secrets if any arose;
do not modify immutable artifact bytes while claiming their original hashes.

The parent must inspect source support, identity continuity, denied actions,
stop proof, released reservations, preserved artifacts and dirty content, and
acceptance rejection in case 10. Automated completion alone does not pass the
gate. Use `review-context.mjs` and `review.mjs` as described in
[release validation](release-validation.md). The plugin-loading race remains an
accepted trusted-workspace limit, not a passing suppression test.

Watch for `parent_permission_needed` and record an explicit scoped decision as
described in [additional permission requests](release-validation.md#additional-permission-requests).
Do not approve an unfamiliar command merely to keep the suite moving.
