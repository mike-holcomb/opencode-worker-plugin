# Compatibility and validation

## Runtime and synthetic checks

The extracted Python helper remains byte-identical to its frozen source baseline:

```text
SHA-256 70be598809228fa2c9926c9b3de7201c198c5545cf764b8c3766bb76d20f73ce
```

The source baseline passed 30 focused tests before extraction. The standalone
suite passes 44 tests and covers the retained CLI/artifact behavior plus unrelated
working directories, paths containing spaces, copied read-only bundles,
caller-relative path resolution, historical record inspection, deterministic
packaging, strict allowlisting, symlink rejection, and internal-link validation.

The runtime uses only Python 3.11+ standard-library modules. Development validation
used Python 3.12.13 with pytest 9.1.1 and PyYAML 6.0.3; live smoke work used Python
3.14.6 on macOS 26.6.2 arm64. The Codex plugin and skill validators passed.

## Installed Codex check

A personal-marketplace installation was tested with Codex 0.154.0 in a fresh
session. The catalog exposed `opencode-agents:opencode-agents`; the installed
helper and all three templates resolved from the plugin cache. An unrelated
temporary project ran preview, execution, status, and separate parent acceptance
through a synthetic CLI. The job exited zero, wrote the expected report, preserved
the task snapshot, and wrote nothing into the installed bundle.

## Real OpenCode smoke

OpenCode 1.18.30 was checked for the required `run` flags. Two authorized,
synthetic-source jobs used a configured local provider/model:

| Run | Process | Events | Errors | Elapsed |
| --- | --- | ---: | ---: | ---: |
| Fresh path-resolution check | exit 0 | 18 | 0 | 43.135 s |
| Exact-session bounded follow-up | exit 0 | 9 | 0 | 35.821 s |

Both wrote their assigned reports. Parent review checked source expressions, CLI
defaults, execution/observation branches, input hash, task snapshot, report content,
and write locations. The follow-up used the exact recorded session ID with a new
job directory; the original report stayed intact.

This verifies one OpenCode version and one local provider configuration. It does
not establish compatibility with other OpenCode versions, providers, native
Windows, or arbitrary model behavior. See [evaluation](evaluation.md) for the
separate orchestration pilot and its limits.

## Distribution checks

The release uses `bundle-files.txt` rather than recursive packaging. The builder
rejects unsafe or missing paths, symlinks, unlisted runtime resources, broken local
Markdown links, and existing outputs. Release verification builds the archive
twice, compares SHA-256 digests and entry metadata, scans the extracted allowlisted
content for private paths and credentials, and validates/tests a read-only
extraction from an unrelated directory. The published marketplace is also installed
from Git and checked in a fresh Codex session.
