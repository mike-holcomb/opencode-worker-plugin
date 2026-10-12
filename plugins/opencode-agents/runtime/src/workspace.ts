import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskPacket } from "./contracts.js";

export type FileSnapshot = { path: string; sha256: string; byteLength: number; untracked: boolean };
export type EvidenceEntry = { path: string; kind: "file" | "directory" | "symlink" | "other" | "absent";
  sha256: string | null; byteLength: number | null };
export type EvidenceIndex = { entries: EvidenceEntry[]; complete: boolean; gaps: string[];
  coverageLimits: string[] };
export type WorkspaceBaseline = {
  workspace: string;
  projectRoots: string[];
  readRoots: string[];
  inputFiles: string[];
  writeTargets: string[];
  writeTargetState: Array<{ path: string; kind: "file" | "directory"; existed: boolean; sha256: string | null }>;
  files: FileSnapshot[];
  git: null | { repositoryIdentity: string; head: string; trackedDiffSha256: string; stagedDiffSha256: string };
  evidenceIndex: EvidenceIndex;
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

function hashRegularFile(path: string): { sha256: string; byteLength: number } {
  const fd = openSync(path, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("not a regular file");
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (!count) break;
      digest.update(chunk.subarray(0, count));
      size += count;
    }
    const after = fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino)
      throw new Error("file changed during evidence scan");
    return { sha256: digest.digest("hex"), byteLength: size };
  } finally { closeSync(fd); }
}

/** Index Git tracked/unignored paths plus every declared output subtree, including ignored files. */
export function captureEvidenceIndex(workspace: string,
  writeTargets: WorkspaceBaseline["writeTargetState"], gitWorkspace: boolean): EvidenceIndex {
  const entries = new Map<string, EvidenceEntry>();
  const gaps: string[] = [];
  const coverageLimits = gitWorkspace
    ? ["Ignored workspace content outside declared write targets is not change indexed."]
    : ["Non-Git change indexing covers declared write targets only; other workspace paths are not swept."];
  const maxEntries = 100_000;
  let limitHit = false;
  const add = (path: string): void => {
    const name = relative(workspace, path);
    if (name === ".." || name.startsWith(`..${sep}`)) { gaps.push(`evidence path outside workspace: ${path}`); return; }
    if (entries.has(name)) return;
    if (entries.size >= maxEntries) {
      if (!limitHit) gaps.push(`evidence index exceeds ${maxEntries} entries`);
      limitHit = true;
      return;
    }
    try {
      let stat;
      try { stat = lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          entries.set(name, { path: name, kind: "absent", sha256: null, byteLength: null });
          return;
        }
        throw error;
      }
      if (stat.isFile()) {
        const file = hashRegularFile(path);
        entries.set(name, { path: name, kind: "file", ...file });
      } else if (stat.isDirectory()) entries.set(name, { path: name, kind: "directory", sha256: null, byteLength: null });
      else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        entries.set(name, { path: name, kind: "symlink", sha256: hash(target), byteLength: Buffer.byteLength(target) });
      } else entries.set(name, { path: name, kind: "other", sha256: null, byteLength: null });
    } catch (error) { gaps.push(`cannot index ${name}: ${String(error)}`); }
  };
  const walk = (path: string): void => {
    if (limitHit) return;
    add(path);
    const name = relative(workspace, path);
    if (entries.get(name)?.kind !== "directory") return;
    try {
      for (const child of readdirSync(path).sort()) {
        if (limitHit) break;
        if (path === workspace && child === ".git") continue;
        walk(resolve(path, child));
      }
    } catch (error) { gaps.push(`cannot enumerate ${name}: ${String(error)}`); }
  };
  if (gitWorkspace) {
    try {
      const paths = git(workspace, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"])
        .toString("utf8").split("\0").filter(Boolean);
      for (const name of paths) add(resolve(workspace, name));
    } catch (error) { gaps.push(`cannot enumerate Git tracked and untracked paths: ${String(error)}`); }
  }
  for (const target of writeTargets) {
    if (target.kind === "directory") walk(target.path);
    else add(target.path);
  }
  return { entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
    complete: gaps.length === 0, gaps, coverageLimits };
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
  const evidenceIndex = captureEvidenceIndex(workspace, writeTargetState, gitWorkspace);
  const coverageLimits = [...evidenceIndex.coverageLimits, ...evidenceIndex.gaps];
  const manifest = { workspace, projectRoots, readRoots, inputFiles, writeTargets, writeTargetState, files, git: gitState,
    evidenceIndex, coverageLimits };
  return { ...manifest, sha256: hash(JSON.stringify(manifest)) };
}

export function compareBaseline(baseline: WorkspaceBaseline): { fresh: boolean; changed: string[]; code: "CURRENT" | "STALE_INPUT" } {
  const changed: string[] = [];
  if (!baseline.evidenceIndex?.complete) changed.push("evidence:baseline-index-incomplete");
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
  const directories = baseline.writeTargetState.filter((target) => target.kind === "directory");
  if (directories.length && baseline.evidenceIndex) {
    const current = captureEvidenceIndex(baseline.workspace, directories, false);
    if (!current.complete) changed.push("evidence:directory-scan-incomplete");
    const relevant = (entry: EvidenceEntry) => directories.some((target) =>
      inside(resolve(baseline.workspace, entry.path), target.path));
    const before = new Map(baseline.evidenceIndex.entries.filter(relevant).map((entry) => [entry.path, entry]));
    const after = new Map(current.entries.map((entry) => [entry.path, entry]));
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(path);
      const latest = after.get(path);
      if (!previous || !latest || previous.kind !== latest.kind || previous.sha256 !== latest.sha256 ||
        previous.byteLength !== latest.byteLength) changed.push(resolve(baseline.workspace, path));
    }
  }
  if (baseline.git) {
    try {
      if (git(baseline.workspace, ["rev-parse", "HEAD"]).toString("utf8").trim() !== baseline.git.head) changed.push("git:HEAD");
      if (hash(git(baseline.workspace, ["diff", "--binary", "HEAD", "--"])) !== baseline.git.trackedDiffSha256) changed.push("git:tracked-diff");
      if (hash(git(baseline.workspace, ["diff", "--cached", "--binary", "--"])) !== baseline.git.stagedDiffSha256) changed.push("git:staged-diff");
    } catch { changed.push("git:unavailable"); }
  }
  const unique = [...new Set(changed)];
  return { fresh: unique.length === 0, changed: unique, code: unique.length ? "STALE_INPUT" : "CURRENT" };
}
