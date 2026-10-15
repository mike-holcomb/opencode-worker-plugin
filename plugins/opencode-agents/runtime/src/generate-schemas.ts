import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { CheckpointInputSchema, ProgressReadSchema } from "./progress.js";
import { ReviewSchema, TaskPacketSchema, WorkerReportSchema } from "./contracts.js";

const directory = resolve(import.meta.dirname, "../../schemas");
mkdirSync(directory, { recursive: true });
for (const [name, schema] of [
  ["task-packet", TaskPacketSchema],
  ["worker-report", WorkerReportSchema],
  ["review", ReviewSchema],
  ["progress-checkpoint", CheckpointInputSchema],
  ["progress-read", ProgressReadSchema],
] as const) {
  writeFileSync(resolve(directory, `${name}.schema.json`), `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`);
}
