# Evaluation quality review

The twelve frozen scenarios have 40 recorded attempts, with
10 passing scenario outcomes and 9 accepted deliverables.
The failed-check scenario passes by preserving its failed test and withholding
acceptance. Operational completion, evaluator markers, and deliverable acceptance
are separate results. The original attempts remain available.

| Scenario | Attempts | Reviewed outcome | Accepted deliverables |
| --- | ---: | --- | ---: |
| lookup-timeout | 2 | passed | 1 |
| log-regression | 2 | passed | 1 |
| retry-clamp | 5 | passed | 1 |
| wire-serialization | 3 | passed | 1 |
| policy-contradiction | 6 | incomplete | 0 |
| negative-auth-claim | 3 | passed | 1 |
| stale-snapshot | 2 | passed | 1 |
| scope-growth | 3 | passed | 1 |
| dirty-checkout | 3 | passed | 1 |
| false-completion | 4 | incomplete | 0 |
| context-reconcile | 2 | passed | 1 |
| failed-checks | 5 | passed | 0 |

## Measurements

| Measurement | Observed sum | Measured attempts | Unavailable attempts |
| --- | ---: | ---: | ---: |
| input_tokens | 2642454 | 30 | 10 |
| output_tokens | 216936 | 30 | 10 |
| total_tokens | 2476750 | 25 | 15 |
| elapsed_ms | 8076647 | 40 | 0 |
| parent_context_bytes | 424547 | 30 | 10 |
| parent_review_elapsed_ms | 2589430 | 30 | 10 |

There were 0 recorded duplicate-dispatch attempts,
1 zero-dispatch attempts, 18
missing or invalid reports, 7 pending reports, and
6 unresolved attempts. No first attempt was accepted.
Of 11 explicit same-task corrections, 5
produced accepted deliverables. Assisted fresh attempts are separately marked.
These counts include provider-route outages, runner defects, missed permission
deadlines and parent scheduling gaps; they do not measure model quality in isolation.

Parent review caught an overstated policy contradiction, an incorrect completed
outcome for a failed check, an insufficient bounded-negative marker and incomplete
log coverage. The final false-completion report exposed missing evidence but
misidentified a file-existence probe as an assigned unittest and overstated the
prior narrative. Generic parent guidance about a unittest was inapplicable to
that fixture and contributed ambiguity. None of those reports was accepted
without resolving the material issue. The accepted
wire report explicitly rejected unrelated retry feedback accidentally supplied by
the parent. Its acceptance does not make that feedback correct.

No false acceptance was identified in the reviewed accepted deliverables. This is
a bounded manual review conclusion, not an automated proof or a production error
rate. Scope-growth acceptance covers the required bounded assessment and request
for a parent decision; it does not authorize the requested feature expansion.
Unresolved executions retain uncertainty and ownership records; no missing final
manifest is fabricated, and no partial report is treated as immutable final evidence.

Input, output and raw total counters have different coverage and therefore must
not be added or reconciled as if they covered identical turns. Billing cost remains
unknown. Execution elapsed sums overlap and include permission waits. Parent
review elapsed time includes concurrent parent work; context bytes measure review
material, not model tokens or focused labor. No claim is made that persistent
processes improve answer quality.

## Recovery and remaining work

The ten macOS live cases have passing reviewed observations, with historical case
3 explicitly identified. Reconnect and supervisor restart were rerun after the RPC
repair: exact execution/session/message identities, one dispatch and valid reports.
Backend-restart and cancellation cases achieved proven stops with ownership released.
Their missing deliverables remain rejected. Old unresolved attempts are preserved.

Repeated policy corrections ended in an overstated report or missing reports;
the final policy attempt reached a proven timeout stop. The final false-completion
report requires accurate check attribution. The opencode-agents skill directs
local adjudication after repeated failed corrections: both remain unaccepted,
rather than starting another review loop or substituting parent-authored reports.
A future bounded correction must state that no unittest is assigned in these two
fixtures, identify actual read/existence checks accurately, and preserve source
ambiguity. Original fixtures and acceptance criteria must remain unchanged.

The policy and false-completion scenarios must have complete reviewed evidence
before being counted as passed. Linux live and WSL2 certification await operator
results; installation of the final immutable candidate tag is also pending. Keep
the development label and execution_supported=false.
