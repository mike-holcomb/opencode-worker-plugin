import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskPacket } from "./contracts.js";

export type FileSnapshot = { path: string; sha256: string; byteLength: number; untracked: boolean };
export type WorkspaceBaseline = {
  workspace: string;
  projectRoots: string[];
  readRoots: string[];
  inputFiles: string[];
  writeTargets: string[];
  writeTargetState: Array<{ path: string; kind: "file" | "directory"; existed: boolean; sha256: string | null }>;
  files: FileSnapshot[];
  git: null | { repositoryIdentity: string; head: string; trackedDiffSha256: string; stagedDiffSha256: string };
  coverageLimits: string[];
  sha256: string;
};

export class WorkspaceError extends Error {
  constructor(readonly code: "OUTSIDE_CONFIGURED_ROOT" | "INVALID_INPUT" | "STALE_INPUT", message: string) { super(message); }
}

function hash(data: Uint8Array | string): string { return createHash("sha256").update(data).digest("hex"); }
function inside(path: string, root: string): boolean { return path === root || path.startsWith(root + sep); }

function nearestExisting(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new WorkspaceError("INVALID_INPUT", `no existing ancestor for ${path}`);
    candidate = parent;
  }
  return realpathSync(candidate);
}

function canonicalPath(path: string): string {
  if (!isAbsolute(path)) throw new WorkspaceError("INVALID_INPUT", "workspace and configured roots must be absolute");
  return realpathSync(path);
}

export function canonicalWorkspace(path: string, projectRoots: string[]): string {
  if (!projectRoots.length) throw new WorkspaceError("OUTSIDE_CONFIGURED_ROOT", "no permitted project roots configured");
  const workspace = canonicalPath(path);
  if (!statSync(workspace).isDirectory()) throw new WorkspaceError("INVALID_INPUT", "workspace is not a directory");
  const roots = projectRoots.map(canonicalPath);
  if (!roots.some((root) => inside(workspace, root))) throw new WorkspaceError("OUTSIDE_CONFIGURED_ROOT", `workspace is outside permitted roots: ${workspace}`);
  return workspace;
}

export function resolveDeclaredPath(workspace: string, path: string, roots: string[]): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  const existing = nearestExisting(absolute);
  if (!roots.some((root) => inside(existing, root) && inside(absolute, root))) {
    throw new WorkspaceError("OUTSIDE_CONFIGURED_ROOT", `declared path escapes configured roots: ${path}`);
  }
  if (existsSync(absolute)) return realpathSync(absolute);
  return absolute;
}

function git(workspace: string, args: string[]): Buffer {
  try { return execFileSync("git", ["-C", workspace, ...args], { encoding: "buffer", maxBuffer: 50 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { throw new WorkspaceError("INVALID_INPUT", `cannot inspect Git state with ${args[0]}`); }
}

function isGitWorkspace(workspace: string): boolean {
  try { git(workspace, ["rev-parse", "--is-inside-work-tree"]); return true; }
  catch { return false; }
}

function isTracked(workspace: string, path: string): boolean {
  const result = spawnSync("git", ["-C", workspace, "ls-files", "--error-unmatch", "--", relative(workspace, path)],
    { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
  return result.status === 0;
}

export function captureBaseline(input: {
  workspace: string;
  projectRoots: string[];
  readRoots?: string[];
  packet: Pick<TaskPacket, "authoritative_inputs" | "allowed_writes">;
}): WorkspaceBaseline {
  const workspace = canonicalWorkspace(input.workspace, input.projectRoots);
  const projectRoots = input.projectRoots.map(canonicalPath);
  const readRoots = [...projectRoots, ...(input.readRoots ?? []).map(canonicalPath)];
  const inputFiles = input.packet.authoritative_inputs.filter((item) => item.kind === "file").map((item) =>
    resolveDeclaredPath(workspace, item.reference, readRoots));
  const writeTargets = input.packet.allowed_writes.map((item) => resolveDeclaredPath(workspace, item.path, [workspace]));
  const writeTargetState = writeTargets.map((path, index) => {
    const kind = input.packet.allowed_writes[index]!.kind;
    const existed = existsSync(path);
    const sha256 = existed && kind === "file" && lstatSync(path).isFile() ? hash(readFileSync(path)) : null;
    return { path, kind, existed, sha256 };
  });
  const gitWorkspace = isGitWorkspace(workspace);
  const files: FileSnapshot[] = inputFiles.map((path) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkspaceError("INVALID_INPUT", `declared input is not a regular file: ${path}`);
    const bytes = readFileSync(path);
    let untracked = false;
    if (gitWorkspace && inside(path, workspace)) {
      untracked = !isTracked(workspace, path);
    }
    return { path, sha256: hash(bytes), byteLength: bytes.byteLength, untracked };
  });
  let gitState: WorkspaceBaseline["git"] = null;
  if (gitWorkspace) {
    const common = git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString("utf8").trim();
    gitState = {
      repositoryIdentity: canonicalPath(common),
      head: git(workspace, ["rev-parse", "HEAD"]).toString("utf8").trim(),
      trackedDiffSha256: hash(git(workspace, ["diff", "--binary", "HEAD", "--"])),
      stagedDiffSha256: hash(git(workspace, ["diff", "--cached", "--binary", "--"])),
    };
  }
  const coverageLimits = ["Only declared file inputs and write targets are individually hashed; ignored and undeclared content is not swept."];
  if (writeTargetState.some((target) => target.kind === "directory")) coverageLimits.push("Declared write directories are not recursively snapshotted.");
  if (!gitWorkspace) coverageLimits.push("Non-Git baseline has no repository-wide tracked-change snapshot.");
  const manifest = { workspace, projectRoots, readRoots, inputFiles, writeTargets, writeTargetState, files, git: gitState, coverageLimits };
  return { ...manifest, sha256: hash(JSON.stringify(manifest)) };
}

export function compareBaseline(baseline: WorkspaceBaseline): { fresh: boolean; changed: string[]; code: "CURRENT" | "STALE_INPUT" } {
  const changed: string[] = [];
  for (const file of baseline.files) {
    try {
      const stat = lstatSync(file.path);
      if (!stat.isFile() || stat.isSymbolicLink() || hash(readFileSync(file.path)) !== file.sha256) changed.push(file.path);
    } catch { changed.push(file.path); }
  }
  for (const target of baseline.writeTargetState) {
    const exists = existsSync(target.path);
    if (exists !== target.existed) { changed.push(target.path); continue; }
    if (exists && target.sha256 !== null) {
      try {
        const stat = lstatSync(target.path);
        if (!stat.isFile() || stat.isSymbolicLink() || hash(readFileSync(target.path)) !== target.sha256) changed.push(target.path);
      } catch { changed.push(target.path); }
    }
  }
  if (baseline.git) {
    try {
      if (git(baseline.workspace, ["rev-parse", "HEAD"]).toString("utf8").trim() !== baseline.git.head) changed.push("git:HEAD");
      if (hash(git(baseline.workspace, ["diff", "--binary", "HEAD", "--"])) !== baseline.git.trackedDiffSha256) changed.push("git:tracked-diff");
      if (hash(git(baseline.workspace, ["diff", "--cached", "--binary", "--"])) !== baseline.git.stagedDiffSha256) changed.push("git:staged-diff");
    } catch { changed.push("git:unavailable"); }
  }
  return { fresh: changed.length === 0, changed, code: changed.length ? "STALE_INPUT" : "CURRENT" };
}
