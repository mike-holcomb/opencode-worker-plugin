# OpenCode Worker Plugin marketplace

Public repository marketplace for [OpenCode Agents](plugins/opencode-agents/README.md),
published by Mike Holcomb under the MIT License.

## Available release

Version `0.1.0` is the published release:

```bash
codex plugin marketplace add mike-holcomb/opencode-worker-plugin --ref v0.1.0
codex plugin add opencode-agents@opencode-worker-plugin
```

Start a fresh Codex session and select
`opencode-agents:opencode-agents` (**OpenCode Agents**). OpenCode, its model
provider, and execution authorization are configured separately.

## V2 prerelease preparation

Version `2.0.0-dev.0` is a development candidate on the v2 branch. Its GitHub prerelease and tag have not been published. The v2 package includes a Node MCP runtime, durable task records, ten tools, and a v2-only skill. Normal execution remains gated by `compatibility.json`; a private exact-workspace opt-in exists for development testing. See the [prerelease notes](docs/releases/v2.0.0-dev.0.md) and [implementation status](docs/v2-implementation.md) before trying it.

The repository marketplace points to the local plugin source. For an isolated local install test, add this checkout as a marketplace and install `opencode-agents@opencode-worker-plugin`. A future tagged prerelease can be selected with `--ref v2.0.0-dev.0` after that tag is published. The repository marketplace and GitHub prerelease are separate from OpenAI's public plugin directory.

The catalog is [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json)
and the canonical plugin source is [plugins/opencode-agents](plugins/opencode-agents).
See its [installation guide](plugins/opencode-agents/docs/installation.md),
[validation](plugins/opencode-agents/docs/validation.md), and diagnostic
[evaluation](plugins/opencode-agents/docs/evaluation.md).
