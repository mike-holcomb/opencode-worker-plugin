# OpenCode Worker Plugin marketplace

Public repository marketplace for [OpenCode Agents](plugins/opencode-agents/README.md),
published by Mike Holcomb under the MIT License.

## Release 2.1.0

The 2.1.0 release candidate resolves cancellation issues [#2](https://github.com/mike-holcomb/opencode-worker-plugin/issues/2)
and [#4](https://github.com/mike-holcomb/opencode-worker-plugin/issues/4), and adds
incremental worker progress checkpoints from [#3](https://github.com/mike-holcomb/opencode-worker-plugin/issues/3).
Plugin and runtime versions both identify as `2.1.0`. See the
[release notes](docs/releases/v2.1.0.md) for changes, validation and upgrade guidance.

After the `v2.1.0` tag is published, install Node.js 24.15 or later within the
24.x line and select it from the marketplace:

```bash
codex plugin marketplace add mike-holcomb/opencode-worker-plugin --ref v2.1.0
codex plugin add opencode-agents@opencode-worker-plugin
```

Until publication, [v2.0.0](https://github.com/mike-holcomb/opencode-worker-plugin/releases/tag/v2.0.0)
remains the current published release; use `--ref v2.0.0` to install it.
Start a fresh Codex session and select `opencode-agents:opencode-agents`
(**OpenCode Agents**). The 2.1.0 candidate includes the bundled Node MCP runtime,
durable task records, eleven tools, and the v2 skill. OpenCode and its
provider/model configuration are separate prerequisites. No Python or runtime
`npm install` is required.

## Execution setup

Follow the [installation and configuration guide](plugins/opencode-agents/docs/installation.md).
Release 2.1.0 targets OpenCode and SDK 1.19.0. Its compatibility manifest has
`execution_supported: false`; live tasks require the private
`development_execution` opt-in for an exact trusted workspace. Managed workers
isolate custom-tool discovery and disable project configuration discovery;
full host/plugin discovery containment and execution certification remain pending.
Attached execution and native questions remain disabled.
See [validation](plugins/opencode-agents/docs/validation.md) and the
[implementation status](docs/v2-implementation.md) for measured results and open checks.

## Distribution

The GitHub release includes a plugin ZIP, per-file manifest, and SHA-256 checksums.
The repository marketplace and GitHub release are separate from OpenAI's public
plugin directory. The earlier `v0.1.0` release remains available by selecting that
ref explicitly.

The catalog is [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json)
and the canonical plugin source is [plugins/opencode-agents](plugins/opencode-agents).
See [evaluation](plugins/opencode-agents/docs/evaluation.md) for the evaluation approach.
