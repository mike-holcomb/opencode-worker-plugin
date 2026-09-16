# Progressive reporting and parent acceptance

## Worker return

Assign one summary path per task. Include outcome (completed, partial, blocked,
no supported finding), actual coverage and gaps, findings/changes with material
contradictions and uncertainty, checks actually performed and missing checks,
precise evidence pointers and next action. A negative finding states inspected
bounds. Soft targets are 150/250/400 words for lightweight/standard/full. Never
truncate material caveats to meet a word target or fill it with tool chronology.

Lightweight work usually needs only the summary and deliverable. Add a detailed
report when warranted; full reports contain an index and stable finding IDs.
References identify artifact sections or source path and symbol/line plus revision
or snapshot for mutable input. Short excerpts can resolve ambiguity. Generated
interpretations are not source proof.

Report paths are outside the installed bundle and disjoint between workers. Do not
pre-create the helper's new `--out` directory for a task/summary. Use a separate
private reports directory or explicitly assign additional files inside the job
after the helper creates it. Workers never overwrite `task.md`, `job.json`,
`events.jsonl`, `stderr.log`, `exit.json`, or parent acceptance.

Final worker text gives the summary path and material blockers, not a duplicate
report. Short tasks need no progress narration. Optional progress files hold new
coverage, provisional findings, blockers and next actions at meaningful checkpoints.
They are polled; they are not callbacks. Preserve original packets and reports
through correction jobs, explaining changes by reference.

## Parent inspection

1. Check operational status; running-job reports remain provisional.
2. Read the compact summary. Missing coverage or checks triggers targeted inspection.
3. Review the complete delivered diff and relevant behavior checks for code. For
   qualitative conclusions, inspect original sources for each claim adopted and
   investigate contrary evidence. Sampling does not prove exhaustive absence.
4. Expand reports/evidence when the decision depends on them, support is weak or
   conflicting, tests fail, or references are stale. Read raw logs for diagnosis.
5. Check relevant starting state and interfaces; revalidate affected stale results.
6. Record acceptance separately and retain concise decisions, limits and pointers.

## Three different outcomes

Process outcome in helper records describes execution only. Worker assessment in
the summary describes claimed coverage. Parent acceptance describes verified
fitness against the original objective. Exit zero cannot establish acceptance.
Missing required deliverables or acceptance evidence always block objective
acceptance, even when the parent can accept a partial assessment as useful input.

Write one compact entry in an existing task record or parent-owned `acceptance.md`:

```text
Job/report: exact paths; predecessor if relevant
Decision: accepted / needs correction / rejected / awaiting evidence
Criteria checked: requested observable requirements and results
Evidence inspected: diff, source locations, test/report artifacts
State: relevant revision and dirty snapshot; freshness/integration result
Limits and next action: unresolved gaps, excluded coverage, correction if needed
```

Workers must not author this decision. Do not reinterpret `exit.json` or invent a
new runtime schema. Structural validation can establish completeness, not truth.
Use deterministic checks where possible. If a bounded correction repeats the same
failure, adjudicate locally or obtain missing input rather than adding reviewers.
