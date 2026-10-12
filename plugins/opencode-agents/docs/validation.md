# V2 development validation

Version `2.0.0-dev.0` is not release certified. The source compatibility manifest has `execution_supported: false`. An exact trusted workspace can use the private development opt-in described in [installation](installation.md).

On macOS arm64 with Node 24.19.0, the TypeScript runtime builds and all 87 runtime tests pass. Nine Node packaging tests and five evaluation harness tests pass. The deterministic, allowlisted archive contains 72 files with a per-file manifest and SHA-256 sidecar. A relocated read-only smoke test verified those hashes, discovered ten MCP tools, left bundle bytes unchanged, and wrote state outside the bundle. These tests perform no model inference. The [evaluation harness](../evaluation/README.md) validates twelve v2 scenarios, 69 frozen checks, and 31 fixture files; the scenario runs have not been completed.

Authorized live checks against OpenCode 1.18.35 and the configured provider/model used the existing local port forward. They exercised task starts, reports, concurrent workspaces, reconnect, exact-session follow-up, permission handling, cancellation, and restart reconciliation. Some restart and permission cases remain unresolved, and no suite-wide release claim is made. The OpenCode plugin lazy-load race is an accepted development FIXME for trusted workspaces.

Remaining release work includes the partial fake-backend cases T20 and T27, incomplete live cases, installed-host MCP path resolution, Linux and WSL2 checks, the twelve v2 scenario runs, performance targets, and the one-hour soak. See the source repository's `docs/v2-implementation.md` for detailed evidence and current limits.
