# GitHub release preparation

The next release is `v2.1.0`, distributed through this repository's Codex
marketplace. The release PR targets `main` and includes the issue #2, #3 and #4
implementations from `dev`. Release preparation does not submit the plugin to
OpenAI's public directory. A merged PR, pushed tag, draft release and published
release are separate steps.

## Release decision

Plugin, runtime, diagnostic and MCP versions must agree on `2.1.0`. The
[execution-certification gates](spec-v2.md#19-verification-and-release-gates)
remain open and `compatibility.json` remains execution-disabled. Publication
must preserve the trusted-workspace opt-in and the limits in the
[release notes](releases/v2.1.0.md); it does not certify execution.

## Local artifact preparation

Use Node 24.15 or later within 24.x. For the campaign-pinned platform runner,
select Node 24.15.0 or 24.21.0. From the repository root:

```bash
cd plugins/opencode-agents/runtime
npm ci
cd ../../..
node plugins/opencode-agents/runtime/scripts/release/platform.mjs --out /tmp/opencode-agents-2.1.0-evidence
node plugins/opencode-agents/scripts/build_bundle.mjs --out /tmp/opencode-agents-v2.1.0.zip
node plugins/opencode-agents/scripts/smoke_installed_bundle.mjs /tmp/opencode-agents-v2.1.0.zip
```

Each output path must be new. The platform runner builds the runtime and bundled
executable, runs runtime, release-runner, packaging and evaluation checks, validates
fixtures and inventory, and verifies a relocated read-only archive installation.
It performs no provider inference or marketplace installation. The release PR's
CI runs the same checks on macOS and Ubuntu, on both pinned Node versions.

The builder emits the ZIP, `.manifest.json` and `.sha256` sidecars. Verify the
archive and manifest checksums from their output directory and keep all three
as release assets. Build again from the final clean merge commit; local candidate
artifacts do not prove the eventual tag. Test the final immutable tag through the
repository marketplace before publishing.

## Publication sequence after PR merge

1. Confirm the final commit is clean, all versions are `2.1.0`, automated checks
   pass and the notes accurately state remaining certification limits.
2. Build and smoke-test the three assets from that commit. Push an annotated
   `v2.1.0` tag identifying the tested commit.
3. Create a draft GitHub release from the existing tag and the checked assets:

   ```bash
   gh release create v2.1.0 /tmp/opencode-agents-v2.1.0.zip \
     /tmp/opencode-agents-v2.1.0.zip.manifest.json \
     /tmp/opencode-agents-v2.1.0.zip.sha256 \
     --draft --verify-tag --latest=false --title 'OpenCode Agents v2.1.0' \
     --notes-file docs/releases/v2.1.0.md
   ```

4. Verify the draft's tag, notes, asset names and checksums, then test marketplace
   installation using `--ref v2.1.0`. Record that result independently of ZIP smoke.
   Publish after review and update release-status documentation to name v2.1.0
   as published. The candidate docs intentionally keep v2.0.0 as the current
   published release until this step.

The historical [2.0.0 development notes](releases/v2.0.0-dev.0.md) and
[v2.0.0 release](https://github.com/mike-holcomb/opencode-worker-plugin/releases/tag/v2.0.0)
remain available for provenance and rollback.
