import { z } from "zod";

const Id = z.string().min(1);
const Text = z.string().min(1);
const TextLine = z.string();

const AuthoritativeInputSchema = z
	.object({
		reference: Text,
		kind: z.enum(["file", "artifact", "url", "inline"]),
		purpose: Text,
		expected_sha256: z.string().optional(),
	})
	.strict();

const TaskContextSchema = z
	.object({
		verified_facts: z.array(Text),
		rejected_assumptions: z.array(Text),
		exclusions: z.array(Text),
		predecessor_task_id: Id.optional(),
	})
	.strict();

const AllowedWriteSchema = z
	.object({
		path: Text,
		kind: z.enum(["file", "directory"]),
		purpose: Text,
	})
	.strict();

const AcceptanceCriterionSchema = z
	.object({
		id: Id,
		requirement: Text,
		evidence_required: Text,
		required: z.boolean(),
	})
	.strict();

const WorkerCheckSchema = z
	.object({
		id: Id,
		description: Text,
		argv: z.array(TextLine).optional(),
		cwd: z.string().optional(),
	})
	.strict();

const SharedResourceSchema = z
	.object({
		key: Text,
		access: z.enum(["read", "write"]),
	})
	.strict();

export const TaskPacketSchema = z
	.object({
		title: Text,
		objective: Text,
		tier: z.enum(["lightweight", "standard", "full"]),
		authoritative_inputs: z.array(AuthoritativeInputSchema),
		context: TaskContextSchema,
		allowed_writes: z.array(AllowedWriteSchema),
		acceptance_criteria: z.array(AcceptanceCriterionSchema),
		checks: z.array(WorkerCheckSchema),
		constraints: z.array(Text),
		stop_conditions: z.array(Text),
		shared_resources: z.array(SharedResourceSchema),
	})
	.strict();

export type AuthoritativeInput = z.infer<typeof AuthoritativeInputSchema>;
export type TaskContext = z.infer<typeof TaskContextSchema>;
export type AllowedWrite = z.infer<typeof AllowedWriteSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type WorkerCheck = z.infer<typeof WorkerCheckSchema>;
export type SharedResource = z.infer<typeof SharedResourceSchema>;

export type TaskPacket = z.infer<typeof TaskPacketSchema>;

const FindingSchema = z
	.object({
		id: Id,
		claim: Text,
		evidence: z.array(TextLine),
		caveats: z.array(Text),
	})
	.strict();

const ChangeSchema = z
	.object({
		path: Text,
		description: Text,
	})
	.strict();

const ReportCheckSchema = z
	.object({
		id: Id,
		status: z.enum(["passed", "failed", "not_run"]),
		exit_code: z.number().nullable(),
		evidence: z.array(TextLine),
		explanation: Text,
	})
	.strict();

export const WorkerReportSchema = z
	.object({
		schema_version: z.literal(2),
		task_id: Id,
		execution_id: Id,
		outcome: z.enum([
			"completed",
			"partial",
			"blocked",
			"no_supported_finding",
		]),
		summary: Text,
		coverage: z.array(Text),
		gaps: z.array(Text),
		findings: z.array(FindingSchema),
		changes: z.array(ChangeSchema),
		checks: z.array(ReportCheckSchema),
		blockers: z.array(Text),
		next_action: Text,
	})
	.strict();

export type Finding = z.infer<typeof FindingSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type ReportCheck = z.infer<typeof ReportCheckSchema>;

export type WorkerReport = z.infer<typeof WorkerReportSchema>;

export const ReviewDispositionSchema = z.enum([
	"pending",
	"accepted",
	"needs_correction",
	"rejected",
	"awaiting_evidence",
]);

const ReviewCriterionSchema = z
	.object({
		id: Id,
		result: z.string().min(1),
		evidence: z.array(TextLine),
	})
	.strict();

export const ReviewSchema = z
	.object({
		disposition: ReviewDispositionSchema,
		rationale: Text,
		criteria: z.array(ReviewCriterionSchema),
		starting_state_sha256: z.string().min(1),
		final_manifest_sha256: z.string().min(1),
		freshness: z.string().min(1),
		integration_checks: z.array(TextLine),
		coverage_limits: z.array(TextLine),
		unresolved_issues: z.array(TextLine),
		next_action: Text,
	})
	.strict();

export type ReviewCriterion = z.infer<typeof ReviewCriterionSchema>;

export type Review = z.infer<typeof ReviewSchema>;
