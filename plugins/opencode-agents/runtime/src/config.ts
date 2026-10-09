import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const AbsolutePath = z.string().min(1).refine(isAbsolute, "must be absolute");

export const UserConfigSchema = z.object({
  schema_version: z.literal(1),
  project_roots: z.array(AbsolutePath).min(1),
  read_roots: z.array(AbsolutePath),
  opencode_binary: AbsolutePath,
  models: z.record(z.string().min(1), z.object({
    provider_id: z.string().min(1),
    model_id: z.string().min(1),
    destination: z.string().min(1),
  }).strict()),
  limits: z.object({
    concurrency: z.number().int().min(1).max(16).default(2),
    queue_timeout_seconds: z.number().int().positive().default(600),
    execution_timeout_seconds: z.number().int().positive().default(1800),
    artifact_bytes: z.number().int().positive().default(50 * 1024 * 1024),
  }).strict().default({ concurrency: 2, queue_timeout_seconds: 600, execution_timeout_seconds: 1800, artifact_bytes: 50 * 1024 * 1024 }),
}).strict();

export type UserConfig = z.infer<typeof UserConfigSchema>;

export function stateDirectory(): string {
  if (process.env.OPENCODE_AGENTS_STATE_DIR) return process.env.OPENCODE_AGENTS_STATE_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "opencode-agents");
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-agents");
}

export function configurationPath(): string {
  return process.env.OPENCODE_AGENTS_CONFIG ?? join(stateDirectory(), "config.json");
}

export function loadConfiguration(path = configurationPath()): UserConfig {
  return UserConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
