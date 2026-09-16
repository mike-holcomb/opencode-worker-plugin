# OpenCode Worker Plugin marketplace

Public Codex marketplace for [OpenCode Agents](plugins/opencode-agents/README.md),
published by Mike Holcomb under the MIT License.

## Install release 0.1.0

```bash
codex plugin marketplace add mike-holcomb/opencode-worker-plugin --ref v0.1.0
codex plugin add opencode-agents@opencode-worker-plugin
```

Start a fresh Codex session and select
`opencode-agents:opencode-agents` (**OpenCode Agents**). OpenCode, its model
provider, and execution authorization are configured separately.

The catalog is [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json)
and the canonical plugin source is [plugins/opencode-agents](plugins/opencode-agents).
See its [installation guide](plugins/opencode-agents/docs/installation.md),
[validation](plugins/opencode-agents/docs/validation.md), and diagnostic
[evaluation](plugins/opencode-agents/docs/evaluation.md).
