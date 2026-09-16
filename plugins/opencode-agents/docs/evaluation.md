# Diagnostic orchestration pilot

## Method

The release pilot used twelve synthetic cases with objective checks frozen before
inference: lookup, log investigation, independent implementation, coupled
interfaces, qualitative contradiction, bounded negative findings, stale evidence,
scope growth, dirty state, false completion, context reconciliation, and failed
checks. Every case ran in a separate prepared directory.

Three conditions used fresh Codex parent sessions with the same parent model and
permissions:

- **A:** parent performed the task locally.
- **B:** parent used the historical single-template skill.
- **C:** parent used the proposed tiered/context/state guidance.

The matched phase required one whole-task worker in B and C. The end-to-end phase
allowed B and C to decide whether delegation was worthwhile. B/C shared one fixed
local OpenCode model, task decomposition, source state, and acceptance criteria in
the matched phase. The Python helper was byte-identical between B and C. Exact
commands, hashes, model identifiers, workdirs, raw events, reports, and checks were
preserved privately; no condition could inspect another condition or hidden checks.

All 72 parent processes completed with return code 0. Frozen checks then examined
observable files, commands, and write scope. Three independent read-only reviews
checked every deliverable and parent decision against the source fixtures. Semantic
review controls the outcome when a case-sensitive marker check disagrees with a
correctly supported statement.

## Results

### Matched delegation

| Condition | Correct outcomes | Correct parent decisions | False accepts | Parent elapsed | Parent input / output | Parent tool-output bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A — local | 12/12 | 12/12 | 0 | 881.145 s | 1,601,901 / 36,484 | 100,113 |
| B — historical | 10/12 | 12/12 | 0 | 1,794.517 s | 2,685,114 / 58,482 | 293,162 |
| C — proposed | 7/12 | 11/12 | 1 | 1,846.831 s | 2,862,315 / 58,426 | 421,869 |

B launched 12 workers, with 32,156 handoff bytes, 22,706 summary bytes across ten
present summaries, 450.341 seconds of worker time, and 142,741 reported final-step
tokens across ten available usage records. C launched 12 workers, with 40,295
handoff bytes, 21,182 summary bytes across eight present summaries, 474.856 seconds
of worker time, and 134,765 reported final-step tokens across ten records.

Seven matched outcomes failed: five worker/tool or endpoint failures left required
work missing; one qualitative answer made an unsupported inference; and one required
summary was missing. Parents rejected or repaired six. The C parent falsely accepted
the missing summary as a useful partial assessment. Four of eleven automated-check
failures were lexical false negatives after source review; the frozen results were
retained rather than rewritten.

### End-to-end decisions

| Condition | Correct outcomes | Correct parent decisions | False accepts | Parent elapsed | Parent input / output | Parent tool-output bytes | Workers launched |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A — local | 12/12 | 12/12 | 0 | 923.071 s | 1,890,872 / 41,852 | 154,700 | 0 |
| B — historical | 11/12 | 11/12 | 1 | 1,005.293 s | 1,954,118 / 43,060 | 250,074 | 2 |
| C — proposed | 12/12 | 12/12 | 0 | 974.510 s | 1,852,232 / 40,860 | 230,812 | 1 |

B delegated the log and qualitative-policy cases. Its worker handoffs totaled
4,892 bytes, summaries 7,170 bytes, worker time 38.389 seconds, and reported
final-step usage 30,096 tokens. C delegated only the coupled wire case; its handoff
was 3,091 bytes, summary 1,953 bytes, worker time 40.914 seconds, and final-step
usage 19,311 tokens. That C delegation succeeded but was borderline: keeping the
coupled interface local would have followed the gate more directly.

The one end-to-end failure was B's qualitative-policy result. The parent report
said it corrected an unsupported contradiction, but the submitted summary still
contained that claim and was falsely accepted. Eight automated-check failures were
lexical marker misses; source review found their required meaning present. This also
showed that structural checks cannot replace source-based acceptance.

## Interpretation and release decision

The matched run does not show a quality, latency, context, or usage advantage for
the proposed delegated protocol. It had more failures, a larger handoff, greater
parent tool-output volume, and slightly longer elapsed time than B. Several failures
were local worker/model availability events, so one run cannot attribute all of the
difference to instructions.

The end-to-end result supports the conservative delegation gate. C kept eleven
small or coupled tasks local and completed all twelve cases, with fewer workers and
slightly lower recorded parent input/output than A or B. This is evidence for
choosing local execution when handoff and verification dominate, not evidence that
delegation itself improves task quality. Useful delegation remains bounded work
whose output volume or parallelism has a concrete benefit and whose interfaces are
stable.

The observed failures produced two instruction changes for 0.1.0: a full packet is
not a reason to delegate coupled work, and a missing required artifact always blocks
objective acceptance even when a partial assessment is useful. Parent review must
inspect the final submitted artifact after any claimed correction.

A fresh three-cell `scope-growth` repeat was attempted after the guidance change.
The A and C parent sessions hit parent-model capacity errors; C failed before worker
launch or report creation. B completed, but the repeat was not comparable and no
result was substituted into the tables above. No automatic retry or selective
resampling was used.

## Measurement limits

- This is one diagnostic run over twelve small synthetic cases, not a statistical
  benchmark or a claim about other repositories, models, or providers.
- Token-matched comparison was unavailable. Codex input includes cached tokens.
- UTF-8 lengths measure artifact/context volume, not model tokens.
- OpenCode final-step usage is provider-reported session usage, was absent for some
  failed jobs, and is not summed billed usage. Zero local-provider cost fields were
  not interpreted as zero resource cost.
- Parent elapsed includes worker waiting and verification; worker time is therefore
  a component, not additional wall time.
- Correction, discovery, and verification counts were parent-reported with varying
  granularity. No correction worker or automatic retry was launched.
- Parent and worker model behavior can vary. Repeat cases before generalizing a
  task-class decision, and retain local execution as a valid outcome.
