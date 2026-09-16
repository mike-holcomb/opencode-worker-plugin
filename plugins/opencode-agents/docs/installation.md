# Installation, updates and rollback

## Public marketplace

The public repository is a Codex marketplace named `opencode-worker-plugin`.
Install the 0.1.0 release and plugin with Codex 0.154.0 or a compatible newer CLI:

```bash
codex plugin marketplace add mike-holcomb/opencode-worker-plugin --ref v0.1.0
codex plugin add opencode-agents@opencode-worker-plugin
```

The repository catalog is `.agents/plugins/marketplace.json`; its local source is
`./plugins/opencode-agents`. Start a fresh Codex session after installation and
select `opencode-agents:opencode-agents`. The plugin does not install OpenCode or a
model provider; configure and authorize those separately.

To follow the current main branch instead of a release tag, use `--ref main`. Refresh
that Git marketplace and reinstall its plugin after an update:

```bash
codex plugin marketplace upgrade opencode-worker-plugin
codex plugin add opencode-agents@opencode-worker-plugin
```

For a pinned release, remove the marketplace source and add it again with the new
tag before reinstalling. Check current CLI help because marketplace behavior can
change.

## Local development

The default personal marketplace lives at `~/.agents/plugins/marketplace.json` and
is discovered implicitly. A local source entry uses `./plugins/opencode-agents`
relative to `~/.agents`. Read its validated name and install with:

```bash
python3 "$PLUGIN_CREATOR/scripts/read_marketplace_name.py"
codex plugin add opencode-agents@personal
```

`PLUGIN_CREATOR` is the installed `plugin-creator` skill directory. If the printed
marketplace name differs, use it. For a source already referenced by that catalog,
use the supported cachebuster and reinstall flow:

```bash
python3 "$PLUGIN_CREATOR/scripts/update_plugin_cachebuster.py" "$PLUGIN_ROOT"
codex plugin add opencode-agents@personal
```

A development cachebuster does not replace semantic release versioning. Start a
new Codex session after every install or update.

## Remove or roll back

Reconcile any live helper and worker processes before changing installations.
Preserve job directories and reports: package rollback does not establish an
inference outcome.

```bash
codex plugin remove opencode-agents@opencode-worker-plugin
codex plugin marketplace remove opencode-worker-plugin
```

To roll back, add the public marketplace again with the desired release tag,
install the plugin, and start a new session. Never replay a recorded historical
command; use the installed helper and an available exact session when continuation
is appropriate.

Official guidance: [Codex plugins](https://developers.openai.com/codex/plugins/).
