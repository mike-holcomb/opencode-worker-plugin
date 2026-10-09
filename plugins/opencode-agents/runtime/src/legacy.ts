import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export type LegacyInspection = {
  originalDirectory: string;
  canonicalDirectory: string;
  records: Array<{ name: string; sha256: string; byteLength: number }>;
  job: { schemaVersion: number | null; cwd: string | null; taskSha256: string | null; model: string | null; sessionArgument: string | null };
  operational: { state: string; returnCode: number | null; terminal: boolean; sessionIds: string[] };
  parentReview: "pending" | "record_present_unverified";
  warnings: string[];
};

const RECORDS = ["job.json", "exit.json", "task.md", "events.jsonl", "stderr.log", "acceptance.md", "acceptance.json"] as const;

function readRecord(directory: string, name: string): Buffer | null {
  const path = join(directory, name);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`legacy record is not a regular file: ${name}`);
  return readFileSync(path);
}

function jsonObject(bytes: Buffer | null, name: string, warnings: string[]): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* reported below */ }
  warnings.push(`${name} is malformed or not an object`);
  return null;
}

function commandValue(value: unknown, flag: string): string | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  const index = value.indexOf(flag);
  const candidate = index >= 0 ? value[index + 1] : null;
  return typeof candidate === "string" ? candidate : null;
}

export function inspectLegacyJob(directory: string): LegacyInspection {
  const canonicalDirectory = realpathSync(directory);
  if (!lstatSync(canonicalDirectory).isDirectory()) throw new Error("legacy job path is not a directory");
  const bytes = new Map<string, Buffer>();
  const records: LegacyInspection["records"] = [];
  for (const name of RECORDS) {
    const content = readRecord(canonicalDirectory, name);
    if (!content) continue;
    bytes.set(name, content);
    records.push({ name, sha256: createHash("sha256").update(content).digest("hex"), byteLength: content.byteLength });
  }
  const warnings: string[] = [];
  const job = jsonObject(bytes.get("job.json") ?? null, "job.json", warnings);
  const exit = jsonObject(bytes.get("exit.json") ?? null, "exit.json", warnings);
  if (!job) warnings.push("job identity and original workspace are unverified");
  if (!bytes.has("exit.json")) warnings.push("no exit record; saved PID is not stopping evidence and process outcome is unreconciled");
  if (bytes.has("exit.json") && !exit) warnings.push("malformed exit record cannot establish an operational outcome");
  const sessionIds = Array.isArray(exit?.session_ids) ? exit.session_ids.filter((id): id is string => typeof id === "string") : [];
  if (sessionIds.length) warnings.push("historical session IDs require backend, storage, and workspace verification before continuation");
  const acceptancePresent = bytes.has("acceptance.md") || bytes.has("acceptance.json");
  if (acceptancePresent) warnings.push("parent acceptance record is preserved but its authority and evidence have not been verified");
  const terminal = Boolean(exit && typeof exit.state === "string" && typeof exit.returncode === "number");
  return {
    originalDirectory: directory,
    canonicalDirectory,
    records,
    job: {
      schemaVersion: typeof job?.schema_version === "number" ? job.schema_version : null,
      cwd: typeof job?.cwd === "string" ? job.cwd : null,
      taskSha256: typeof job?.task_sha256 === "string" ? job.task_sha256 : null,
      model: commandValue(job?.command, "--model"),
      sessionArgument: commandValue(job?.command, "--session"),
    },
    operational: {
      state: terminal ? exit!.state as string : "unreconciled",
      returnCode: terminal ? exit!.returncode as number : null,
      terminal,
      sessionIds,
    },
    parentReview: acceptancePresent ? "record_present_unverified" : "pending",
    warnings,
  };
}
