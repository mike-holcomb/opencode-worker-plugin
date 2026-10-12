// Aggregate recorded measurements; never infer parent acceptance from worker text.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
const read = path => JSON.parse(readFileSync(path));
const ids = read(new URL('../../../evaluation/v2-cases.json', import.meta.url)).cases.map(c => c.id);
const attempts = [], seen = new Set();
for (const campaign of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
  for (const id of ids) {
    const dir = join(root, campaign.name, id);
    if (!existsSync(join(dir, 'metrics.json')) || !existsSync(join(dir, 'final.json'))) continue;
    const m = read(join(dir, 'metrics.json')), f = read(join(dir, 'final.json'));
    assert(!seen.has(f.executionId), `Duplicate execution record: ${f.executionId}`); seen.add(f.executionId);
    const review = existsSync(join(dir, 'review.json')) ? read(join(dir, 'review.json')) : null;
    const checks = existsSync(join(dir, 'checks.json')) ? read(join(dir, 'checks.json')).checks : [];
    const usage = existsSync(join(dir, 'observed-usage.json')) ? read(join(dir, 'observed-usage.json')) : null;
    attempts.push({ scenario: id, evidence: `${campaign.name}/${id}/`, execution_id: f.executionId,
      created_at: f.createdAt, phase: f.phase, terminal: f.terminal, report_validity: f.reportValidity,
      accepted: review?.result?.reviewStatus === 'accepted', parent_review: m.parent_review,
      failed_frozen_checks: checks.filter(c => c.status === 'fail').map(c => c.id),
      dispatches: m.dispatches ?? null, duplicate_dispatch: Number.isInteger(m.dispatches) ? m.dispatches > 1 : null,
      elapsed_ms: m.elapsed_ms ?? null, parent_context_bytes: m.parent_context_bytes ?? null,
      parent_review_elapsed_ms: m.parent_review_elapsed_ms ?? null,
      context_mode: f.contextMode, predecessor_execution_id: f.predecessorExecutionId,
      assisted_fresh: existsSync(join(dir, 'parent-guidance.json')),
      input_tokens: usage?.input_tokens ?? null, output_tokens: usage?.output_tokens ?? null,
      total_tokens: usage?.total_tokens ?? null, reported_cost: null });
  }
}
attempts.sort((a, b) => a.created_at.localeCompare(b.created_at));
const sumKnown = key => {
  const values = attempts.map(a => a[key]).filter(Number.isFinite);
  return { observed_sum: values.length ? values.reduce((a, b) => a + b, 0) : null,
    measured_attempts: values.length, unavailable_attempts: attempts.length - values.length };
};
const scenarios = ids.map(id => {
  const runs = attempts.filter(a => a.scenario === id);
  return { id, attempts: runs.length, first_attempt_accepted: runs[0]?.accepted ?? false,
    accepted_deliverables: runs.filter(a => a.accepted).length,
    latest_phase: runs.at(-1)?.phase ?? null,
    accepted_evidence: runs.filter(a => a.accepted).map(a => a.evidence) };
});
const result = { schema_version: 1, generated_at: new Date().toISOString(),
  scenarios_recorded: scenarios.filter(s => s.attempts).length, required_scenarios: ids.length,
  attempts: attempts.length, accepted_deliverables: attempts.filter(a => a.accepted).length,
  scenarios_with_accepted_deliverable: scenarios.filter(s => s.accepted_deliverables).length,
  first_attempt_accepted: scenarios.filter(s => s.first_attempt_accepted).length,
  duplicate_dispatch_attempts: attempts.filter(a => a.duplicate_dispatch).length,
  zero_dispatch_attempts: attempts.filter(a => a.dispatches === 0).length,
  missing_or_invalid_report_attempts: attempts.filter(a => ['missing', 'invalid'].includes(a.report_validity)).length,
  pending_report_attempts: attempts.filter(a => a.report_validity === 'pending').length,
  unresolved_attempts: attempts.filter(a => !a.terminal).length,
  correction_attempts: attempts.filter(a => a.predecessor_execution_id).length,
  accepted_corrections: attempts.filter(a => a.predecessor_execution_id && a.accepted).length,
  measurements: Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens', 'elapsed_ms',
    'parent_context_bytes', 'parent_review_elapsed_ms'].map(k => [k, sumKnown(k)])),
  billing_cost: null,
  limits: ['Accepted means an explicit recorded parent review, not worker self-assessment.',
    'Elapsed sums include concurrent attempts, permission waits and host scheduling gaps; they are not campaign wall time.',
    'Parent review elapsed time includes other parent work; it is not focused labor time. Context is measured in bytes, not tokens.',
    'Token sums cover only exact-turn observed counters; missing counters and verified billing costs remain unavailable.',
    'First attempts include retained infrastructure and harness failures. Corrections do not replace failed attempts.',
    'False acceptance requires qualitative parent audit; this aggregation does not certify it.'],
  scenarios, records: attempts };
writeFileSync(join(root, 'quality-summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ scenarios: result.scenarios_recorded, attempts: result.attempts,
  accepted: result.accepted_deliverables, unresolved: result.unresolved_attempts }));
