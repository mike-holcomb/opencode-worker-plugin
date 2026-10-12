import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { WorkerReportSchema } from "./contracts.js";
import type { TaskPacket } from "./contracts.js";
import type { WorkspaceBaseline } from "./workspace.js";
import { workerProfilePath } from "./resources.js";

export type FrozenPrompt = { text: string; sha256: string };

/** The prompt is a reproducible rendering of an admitted execution contract. */
export function renderPrompt(input: {
  taskId: string;
  executionId: string;
  profile: "bounded-build" | "bounded-inspect";
  packet: TaskPacket;
  baseline: WorkspaceBaseline;
  outputDirectory: string;
}): FrozenPrompt {
  const { taskId, executionId, profile, packet, baseline, outputDirectory } = input;
  const profileText = readFileSync(workerProfilePath(profile), "utf8");
  const profileHash = createHash("sha256").update(profileText).digest("hex");
  const text = [
    `# ${packet.title}`,
    `Task ID: ${taskId}`,
    `Execution ID: ${executionId}`,
    `Profile: ${profile}`,
    `Profile SHA-256: ${profileHash}`,
    `Workspace: ${baseline.workspace}`,
    `Starting state SHA-256: ${baseline.sha256}`,
    "",
    "## Worker profile",
    profileText,
    "",
    "## Objective",
    packet.objective,
    "",
    "## Authoritative inputs",
    JSON.stringify(packet.authoritative_inputs, null, 2),
    "",
    "## Verified context",
    JSON.stringify(packet.context, null, 2),
    "",
    "## Allowed project writes",
    JSON.stringify(packet.allowed_writes, null, 2),
    "",
    "## Acceptance criteria and checks",
    JSON.stringify({ acceptance_criteria: packet.acceptance_criteria, checks: packet.checks }, null, 2),
    "",
    "## Constraints and stop conditions",
    JSON.stringify({ constraints: packet.constraints, stop_conditions: packet.stop_conditions }, null, 2),
    "",
    "## Output contract",
    `Write a WorkerReport schema_version 2 as ${outputDirectory}/result.json and a readable summary as ${outputDirectory}/summary.md.`,
    "The result.json must match this exact JSON Schema. Include every required field and no extra fields:",
    JSON.stringify(z.toJSONSchema(WorkerReportSchema)),
    "Use the exact task and execution IDs above. Report failed or unrun checks, gaps, uncertainty, and blockers honestly.",
    "The report is evidence for parent review; do not claim parent acceptance or invoke the parent-facing toolkit.",
    "",
  ].join("\n");
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}
