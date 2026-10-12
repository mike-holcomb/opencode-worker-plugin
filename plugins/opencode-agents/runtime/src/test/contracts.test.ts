import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskPacketSchema, WorkerReportSchema } from "../contracts.js";

test("task packet rejects undeclared nested authority", () => {
  const packet = {
    title: "Inspect", objective: "Inspect one file", tier: "lightweight",
    authoritative_inputs: [{ reference: "src/a.ts", kind: "file", purpose: "Source" }],
    context: { verified_facts: [], rejected_assumptions: [], exclusions: [] },
    allowed_writes: [], acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [],
  };
  assert.equal(TaskPacketSchema.safeParse(packet).success, true);
  assert.equal(TaskPacketSchema.safeParse({ ...packet, context: { ...packet.context, allow_network: true } }).success, false);
  assert.equal(TaskPacketSchema.safeParse({ ...packet, authoritative_inputs: [{ ...packet.authoritative_inputs[0], permission: "write" }] }).success, false);
});

test("worker report cannot omit check outcome", () => {
  const report = {
    schema_version: 2, task_id: "task-1", execution_id: "exec-1", outcome: "completed",
    summary: "Done", coverage: [], gaps: [], findings: [], changes: [],
    checks: [{ id: "check-1", status: "passed", exit_code: 0, evidence: [], explanation: "Ran" }],
    blockers: [], next_action: "Review",
  };
  assert.equal(WorkerReportSchema.safeParse(report).success, true);
  assert.equal(WorkerReportSchema.safeParse({ ...report, checks: [{ ...report.checks[0], status: "unclear" }] }).success, false);
});
