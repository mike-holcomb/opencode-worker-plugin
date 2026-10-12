# V2 GitHub prerelease preparation

The intended first publication target is a GitHub prerelease tagged `v2.0.0-dev.0`, distributed through this repository's Codex marketplace. This does not submit the plugin to OpenAI's public directory. The tag and GitHub release are not yet published.

## Release decision

The [specification's release gates](spec-v2.md#19-verification-and-release-gates) still apply. The compatibility manifest remains execution-disabled until the remaining fake-backend, live, platform, evaluation, and performance evidence is complete. The accepted OpenCode plugin loading race must stay visible in the release notes. Do not label this build as execution-certified or as the latest stable release.

## Local artifact preparation

Use Node 24.15 or later within 24.x. From `plugins/opencode-agents`:

```bash
cd runtime
npm ci
npm run bundle
npm test
cd ..
node --test tests/packaging.test.mjs
node --test evaluation/harness.test.mjs
node evaluation/harness.mjs validate
node scripts/build_bundle.mjs --check
node scripts/build_bundle.mjs --out /private/tmp/opencode-agents-v2.0.0-dev.0.zip
node scripts/smoke_installed_bundle.mjs /private/tmp/opencode-agents-v2.0.0-dev.0.zip
```

The builder emits the ZIP, `.manifest.json`, and `.sha256` sidecars. Check the ZIP and manifest against the sidecar from the output directory, and keep all three together as release assets. Test a clean Git checkout or archive through the repository marketplace before tagging; the local source install only proves Codex CLI 0.162.0 behavior on the development host.

## Publication sequence after gates pass

1. Check that the Git tree is clean, the plugin manifest and runtime package versions agree, and the final tag points at the tested commit.
2. Push the commit and annotated tag through an authenticated HTTPS Git remote.
3. Create a **draft prerelease** using the existing remote tag, [these notes](releases/v2.0.0-dev.0.md), and the three built assets. GitHub CLI supports `--draft`, `--prerelease`, `--latest=false`, `--verify-tag`, and `--notes-file` for this step: [GitHub CLI release reference](https://cli.github.com/manual/gh_release_create).
4. Verify the draft's tag, notes, asset names, checksums, and marketplace install from the tagged repository. Publish the draft only after those checks.

No GitHub tag, draft, or release is created by the preparation steps above.
