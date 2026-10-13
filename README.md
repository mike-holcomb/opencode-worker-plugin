# OpenCode Worker Plugin marketplace

Public repository marketplace for [OpenCode Agents](plugins/opencode-agents/README.md),
published by Mike Holcomb under the MIT License.

## Install v2.0.0

[OpenCode Agents v2.0.0](https://github.com/mike-holcomb/opencode-worker-plugin/releases/tag/v2.0.0)
is the current published release. Install Node.js 24.15 or later within the 24.x
line before installing the plugin:

```bash
codex plugin marketplace add mike-holcomb/opencode-worker-plugin --ref v2.0.0
codex plugin add opencode-agents@opencode-worker-plugin
```

Start a fresh Codex session and select
`opencode-agents:opencode-agents` (**OpenCode Agents**). The release includes the
Node MCP runtime, durable task records, ten tools, and the v2 skill. OpenCode and
its provider/model configuration are separate prerequisites. No Python or runtime
`npm install` is required.

## Execution setup and package version

The published `v2.0.0` tag retains internal plugin/runtime version `2.0.0-dev.0`;
that is the version an installed package may display. The GitHub release is a
full release, but its compatibility manifest still has `execution_supported: false`.
Live tasks require the private `development_execution` opt-in for an exact trusted
workspace. Installation alone does not enable execution.

Follow the [installation and configuration guide](plugins/opencode-agents/docs/installation.md).
Managed execution uses OpenCode 1.18.35. A known plugin-loading race limits its
use to trusted workspaces; attached execution and native questions remain disabled.
See [validation](plugins/opencode-agents/docs/validation.md) and the
[implementation status](docs/v2-implementation.md) for measured results and open
certification checks.

## Distribution

The GitHub release includes a plugin ZIP, per-file manifest, and SHA-256 checksums.
The repository marketplace and GitHub release are separate from OpenAI's public
plugin directory. The earlier `v0.1.0` release remains available by selecting that
ref explicitly.

The catalog is [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json)
and the canonical plugin source is [plugins/opencode-agents](plugins/opencode-agents).
See [evaluation](plugins/opencode-agents/docs/evaluation.md) for the evaluation approach.
