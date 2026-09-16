---
name: opencode-agents
description: Delegate bounded work to an independently installed OpenCode CLI, monitor jobs, recover exact sessions, and verify deliverables. Use when OpenCode delegation or agent coordination is requested, not for unrelated code changes.
---

# OpenCode agents

The parent owns decomposition, integration, acceptance, and the final response.
Workers receive explicit assignments, not the parent's conversation or authority.
The Python 3.11+ POSIX helper requires a configured OpenCode provider/model.

## Decide, then prepare

Delegate independent work when isolating substantial output or parallel effort
outweighs handoff and verification cost. Keep quick lookups and tightly coupled
decisions local. Complexity is not independence. Pilot uncertain qualitative work
before expanding it; worker count follows dependencies and endpoint capacity.
A full packet can describe complex work, but it never makes coupled work suitable
for delegation by itself.

Read applicable project guidance. Resolve scope, provider/model, data destination,
and execution limits before launching; honor authorization already established.
Do not request the same approval again. The helper does not configure providers,
authorize inference, isolate files, or manage shared endpoint capacity.

Load only the smallest sufficient template:

- [Lightweight](assets/task-lite.md): focused lookup/check or obvious small change.
- [Standard](assets/task-template.md): bounded implementation or several criteria.
- [Full](assets/task-full.md): ambiguous review or bounded coordinated work.

Every packet names goal, authoritative inputs, working directory, exact allowed
writes including summary path, acceptance checks, stop boundaries, and relevant
authorization/project constraints. A tier never broadens permission. Keep tasks,
reports, and logs outside this read-only installed bundle.

Select fresh context for independent/blind work; resume an exact recorded session
for reliable useful progress. For takeover after wrong assumptions, carry verified
facts, current edits, rejected assumptions, and remaining checks into a fresh task.
Reconcile the original process and writes before continuation or replacement.

For mutable inputs, record revision plus relevant dirty-state snapshot/hashes,
read dependencies, shared resources, interface expectations, and a freshness check.
Disjoint writes alone do not establish independence. Load
[orchestration](references/orchestration.md) for context/state coordination and
[lessons](references/lessons.md) for qualitative investigations.

## Launch and reconcile

Resolve `scripts/opencode_agent.py` relative to this skill's supplied location.
Read [operations](references/operations.md) for exact commands and exit codes.
Preview `run` with explicit `--cwd`, `--model`, `--task-file`, and new `--out`;
add `--execute` within authorization. Task/out relative paths resolve from the
invoking process, not `--cwd`. Prefer absolute paths.

Keep and poll the foreground tool/process handle. `status` reads local records;
bounded `status --watch` expiration does not cancel or relaunch the worker.
Missing exit records or denied process inspection mean unconfirmed outcome.
Inspect the original handle, identity, and artifacts before another job. Continue
with `--session` using the exact recorded ID, a new task, and new output directory;
never use global `--continue` or replay a historical command blindly.

## Inspect summary, then evidence

Require a compact summary: outcome; actual coverage and gaps; changes/findings
including contradictions, uncertainty and failed checks; verification performed;
precise evidence pointers and next action. Negative findings state inspected bounds.
Material caveats must survive summarization. Progress is provisional.

Read the summary first, then the complete submitted diff and relevant checks, or
original sources supporting each qualitative claim you adopt. Check freshness and
unintended writes; open detailed reports or raw logs when a decision needs them.
Do not repeat the entire investigation by default or treat sampling as exhaustive.

Record a parent-owned acceptance decision separately from process exit and worker
assessment. Workers cannot accept their own work. Use the
[reporting guide](references/reporting.md) for evidence expansion and a compact
acceptance record. Preserve original reports through bounded corrections. If
corrections repeatedly fail, adjudicate locally rather than adding reviewers.
If a required deliverable or acceptance check is absent, record needs correction,
rejection, or awaiting evidence; do not accept the objective merely because a
partial assessment is useful.
