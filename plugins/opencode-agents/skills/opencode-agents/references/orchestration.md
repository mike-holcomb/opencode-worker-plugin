# Delegation, context and shared state

## Delegation gate

Explain the expected benefit in one sentence. Independent implementation with
stable interfaces, large log investigations and bounded evidence inventories can
benefit from separate context. Keep quick targeted work local when handoff/checking
cost dominates. Keep tightly coupled decisions together or serialize them. Pilot
untested qualitative decomposition. Reassess after repeated clarification or
rediscovery; completing locally remains valid. Budget concurrency against actual
shared endpoint activity, not available agent slots.

Complexity selects packet detail; independence selects whether to delegate. Use
lightweight for a focused obvious check, standard for several acceptance criteria,
full for ambiguity/coverage/coordination that can still be bounded. All tiers carry
the same source-grounding, permission and acceptance obligations.
A full template documents complexity; it does not turn a coupled producer/consumer
or shared-state change into independent work. Keep that work local or stabilize and
serialize the interface first.

## Context policy

| Situation | Choice and required state |
| --- | --- |
| Independent or blind task | Fresh session; objective, sources, constraints, checks; omit earlier verdicts. |
| Reliable progress on same task | Exact recorded session; changed inputs, bounded next step, remaining checks, new report paths. |
| Repeated wrong assumptions or takeover | Consider fresh context with verified facts, current edits, rejected assumptions, reproducible failures and unresolved questions. |
| Planner delegates implementation | Validated design decisions, required interface, rationale and checks; no need to copy the conversation. |

Fresh context can increase rediscovery; continued context can preserve mistakes.
The helper supports fresh sessions and `--session`, not conversation forking or
selective-history machinery. Curated state is ordinary task-file content.

Before replacement or continuation reconcile the original process and writes.
Use a new job directory and identify the predecessor; preserve earlier results.
A new session is not a clean checkout and an unchecked summary is not authority.

## Repository and resource contract

Conversation state, files and external services are different. The helper separates
sessions only. Record relevant starting revision and dirty input hashes/snapshot,
read dependencies, permitted writes/resources, interface inputs/outputs/failures
and downstream consumer, plus freshness and integration checks. Commit ID alone
cannot identify a dirty checkout. Preserve pre-existing edits.

Changing a function return type and updating its callers are coupled even when
workers own different files. Stabilize the interface, serialize the tasks, or
prepare isolated checkouts with an explicit integration step. Worktrees do not
isolate test databases, services or shared model capacity.

When relevant inputs change, mark affected checks/conclusions potentially stale;
reinspect or rerun those checks before acceptance. Do not repeat unrelated checks
solely because another file changed. If broader scope is needed, the worker returns
the specific gap and useful partial work; only the parent changes the contract.
