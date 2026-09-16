# Standard delegated task

## Goal and scope
One deliverable, included files/IDs, and explicit exclusions.

## Context and authority
Fresh or exact-session continuation; predecessor job if any. State verified
decisions and necessary rationale. Name authoritative inputs separately from
generated interpretations and historical references. Give an absolute working
directory. Carry applicable project rules and authorization; reference the launch
record for model/provider/destination and execution limits.

## State and dependencies
For mutable inputs: base revision plus relevant dirty snapshot/patch/hashes; stable
read dependencies; required interfaces and failure behavior; shared mutable
resources; parent freshness/integration check. Omit irrelevant fields.

## Allowed writes
Exact source/test/deliverable paths and one summary path outside the installed
bundle. Name any permitted service/database mutations. Preserve existing edits
and predecessor reports. Do not overwrite helper records or parent acceptance.

## Acceptance checks
Observable criteria and commands, required coverage, and supporting source
locations. Include failure/negative cases. State what would disprove completion.

## Boundaries and stop conditions
No additional agents, inference, endpoints, network, commits, or publication
unless explicitly included in authorization. Stop dependent work on missing
inputs, stale interfaces, conflicting instructions, repeated failure, or a need
for broader writes/authority. Return the concrete gap and useful partial coverage.
Prompt boundaries are not a filesystem sandbox.

## Return
Write the assigned summary: outcome (completed/partial/blocked/no supported
finding), coverage and gaps, changes/findings and caveats, checks actually run
(and relevant checks not run), evidence paths/symbols/lines and next action.
Aim for 250 words without hiding material blockers. Link supporting artifacts
only when needed. Final text names the summary path and material blockers.
Parent acceptance is a separate parent-owned decision.
