# OpenCode Agents

A Codex plugin for bounded delegation to an independently installed OpenCode CLI.
The parent retains control and verifies deliverables; workers use separate sessions
and durable private job artifacts. Runtime: Python 3.11+ standard library and POSIX.
Publisher: Mike Holcomb. License: [MIT](LICENSE).

## Install

```bash
codex plugin marketplace add mike-holcomb/opencode-worker-plugin --ref v0.1.0
codex plugin add opencode-agents@opencode-worker-plugin
```

Start a fresh Codex session, then select
`opencode-agents:opencode-agents` (**OpenCode Agents**) from the skill picker.
See [installation and updates](docs/installation.md) for pinning, upgrades,
uninstall, and rollback.

## Use

Install OpenCode independently, configure an authorized provider/model, and inspect
`opencode run --help`. The wrapper neither selects an endpoint nor installs models.
The tested versions and limits are recorded in [validation](docs/validation.md).

The skill guides Codex through choosing whether to delegate, selecting a
[lightweight](skills/opencode-agents/assets/task-lite.md),
[standard](skills/opencode-agents/assets/task-template.md), or
[full](skills/opencode-agents/assets/task-full.md) packet, previewing the job,
monitoring its process, and independently accepting its result.

Read [operations](skills/opencode-agents/references/operations.md) for complete
commands, path bases, exits, privacy, recovery and troubleshooting. Resolve the
helper from the installed skill directory; use absolute task/output paths and an
explicit consuming-project `--cwd`. Runtime files never belong in the plugin.

```bash
python3 "$SKILL_DIR/scripts/opencode_agent.py" run \
  --cwd "$PROJECT_DIR" --model "$MODEL" \
  --task-file "$PRIVATE_DIR/tasks/check.md" --out "$PRIVATE_DIR/check-01"
```

Set the variables to actual absolute paths and a configured model first. This is a
preview; add `--execute` within established authorization. The output directory must
be new. Keep the foreground tool handle. `status --watch` expiration leaves the job
running. Continue only an exact recorded session after process/write reconciliation.

## Evidence and limits

The 0.1.0 release preserves the original runner byte-for-byte and adds tiered
handoffs, context/state guidance, and parent-owned acceptance. Synthetic tests,
installed execution, real-CLI smoke work, and a 12-case A/B/C diagnostic pilot are
documented in [validation](docs/validation.md) and [evaluation](docs/evaluation.md).
The pilot supports conservative local-execution defaults; it does not establish
universal quality, latency, context, or cost improvements.

No queues, retries, automatic routing, worktree/sandbox management, distributed
rate limiting, recursive delegation, messaging callbacks or Windows process
management are included. Prompt write restrictions are not enforced isolation.
OpenCode may store sessions/logs outside the job directory and configured providers
control where prompts are sent. Exit success, worker assessment and parent
acceptance are separate outcomes.

## Development

From the plugin directory (`plugins/opencode-agents` in the public repository):

```bash
python3 -m venv /absolute/development-environments/opencode-agents
/absolute/development-environments/opencode-agents/bin/python -m pip install pytest PyYAML
/absolute/development-environments/opencode-agents/bin/python -m pytest
python3 scripts/build_bundle.py --check
python3 scripts/build_bundle.py --out /absolute/new/opencode-agents-0.1.0.zip
```

Keep the development environment outside the plugin root. Release archives use
the strict `bundle-files.txt` allowlist. Pytest and PyYAML are development-only;
the runtime has no Python package dependency. The builder rejects missing runtime
resources, unsafe links and paths, symlinks, and existing output files, then writes
a deterministic archive for inspection.
