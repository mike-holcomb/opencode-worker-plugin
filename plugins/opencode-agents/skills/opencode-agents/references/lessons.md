# Lessons for bounded qualitative work

These are engineering cautions from qualitative experience, not measured universal
benefits. The diagnostic pilot and its limits are recorded in the plugin docs.

- Freeze source/output packets and reference shared evidence once. Do not silently
  truncate coverage to fit context. Assign exact units and disjoint report paths.
- Ask for supported findings, persistence, regressions and uncertainty; asking a
  worker to verify improvement biases the verdict.
- Ground adopted claims in original sources, not another model's extraction or
  earlier review. Historical outputs are comparisons, not truth.
- Distinguish actors, dates, planned/completed activity, conflicting source sections,
  individual recommendations and collective decisions. Apply the consuming project's
  definitions rather than generalizing one historical example.
- Numeric agreement alone does not establish sound reasoning. Changed outputs on
  unchanged input require source/rationale checks before being called regressions.
- Same-model workers are not independent ground-truth validators. Verify coverage
  declarations and adopted claims. A broad “no problems” verdict needs broad evidence.
- Pilot one representative claim. Correct with a minimal source counterexample and
  ask for accept/refute/uncertain. Preserve the original; repeated mistakes justify
  local adjudication, not more agents or repeated prompts toward a desired result.
- Save source hashes, events, stderr, exact sessions and exits. Separate attempts
  from completed responses, structural validity from factual quality, and sources
  read from claims verified. Transport failure is not a qualitative finding.
- Reconcile process/endpoint activity before another bounded attempt. Concurrency
  can increase contention and parent review time. Never bypass an execution denial.
