import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync, constants } from "node:fs";
import { basename, join, resolve } from "node:path";

export type ArtifactRegistration = {
  artifactId: string;
  executionId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  path: string;
};

export class ArtifactStore {
  private readonly staging: string;
  private readonly objects: string;

  constructor(readonly root: string, readonly maxBytes = 50 * 1024 * 1024) {
    this.staging = join(root, "staging");
    this.objects = join(root, "objects");
    mkdirSync(this.staging, { recursive: true, mode: 0o700 });
    mkdirSync(this.objects, { recursive: true, mode: 0o700 });
  }

  captureBytes(executionId: string, bytes: Uint8Array, mediaType: string, register: (entry: ArtifactRegistration) => void): ArtifactRegistration {
    if (bytes.byteLength > this.maxBytes) throw new Error(`artifact exceeds ${this.maxBytes} bytes`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactId = `artifact_${randomUUID()}`;
    const stagedPath = join(this.staging, `${artifactId}.tmp`);
    const finalPath = join(this.objects, sha256);
    const fd = openSync(stagedPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const entry = { artifactId, executionId, sha256, byteLength: bytes.byteLength, mediaType, path: finalPath };
    try {
      register(entry);
      if (existsSync(finalPath)) {
        if (createHash("sha256").update(readFileSync(finalPath)).digest("hex") !== sha256) throw new Error("artifact hash collision or corrupt object");
        rmSync(stagedPath);
      } else {
        renameSync(stagedPath, finalPath);
        this.syncDirectory(this.objects);
      }
      return entry;
    } catch (error) {
      if (existsSync(stagedPath)) rmSync(stagedPath);
      throw error;
    }
  }

  read(entry: ArtifactRegistration, offset = 0, maxBytes = 16_384): { bytes: Uint8Array; nextOffset: number | null } {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) {
      throw new RangeError("invalid artifact read range");
    }
    if (resolve(entry.path) !== join(this.objects, entry.sha256) || basename(entry.path) !== entry.sha256) throw new Error("artifact path is outside store");
    const stat = lstatSync(entry.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.byteLength) throw new Error("artifact changed");
    const all = readFileSync(entry.path);
    if (createHash("sha256").update(all).digest("hex") !== entry.sha256) throw new Error("artifact changed");
    const bytes = all.subarray(offset, offset + maxBytes);
    const nextOffset = offset + bytes.byteLength < all.byteLength ? offset + bytes.byteLength : null;
    return { bytes, nextOffset };
  }

  stagedFiles(): string[] {
    return readdirSync(this.staging).filter((name) => name.endsWith(".tmp"));
  }

  /** Reconcile the file/SQLite publication window before admitting new work. */
  reconcile(lookup: (artifactId: string) => ArtifactRegistration | null,
    registered: ArtifactRegistration[] = []): { published: string[]; removed: string[] } {
    const published: string[] = [];
    const removed: string[] = [];
    for (const name of this.stagedFiles()) {
      const artifactId = name.slice(0, -4);
      const path = join(this.staging, name);
      const entry = lookup(artifactId);
      if (!entry) { rmSync(path); removed.push(artifactId); continue; }
      if (resolve(entry.path) !== join(this.objects, entry.sha256)) throw new Error(`artifact path mismatch: ${artifactId}`);
      const staged = readFileSync(path);
      if (staged.byteLength !== entry.byteLength || createHash("sha256").update(staged).digest("hex") !== entry.sha256)
        throw new Error(`staged artifact differs from committed registration: ${artifactId}`);
      if (existsSync(entry.path)) {
        const final = readFileSync(entry.path);
        if (final.byteLength !== entry.byteLength || createHash("sha256").update(final).digest("hex") !== entry.sha256)
          throw new Error(`published artifact differs from committed registration: ${artifactId}`);
        rmSync(path);
      } else {
        renameSync(path, entry.path);
        this.syncDirectory(this.objects);
      }
      published.push(artifactId);
    }
    for (const entry of registered) {
      if (resolve(entry.path) !== join(this.objects, entry.sha256)) throw new Error(`registered artifact path mismatch: ${entry.artifactId}`);
      try {
        const stat = lstatSync(entry.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.byteLength)
          throw new Error("not a regular file with recorded size");
      } catch { throw new Error(`registered artifact is missing or changed: ${entry.artifactId}`); }
    }
    return { published, removed };
  }

  private syncDirectory(path: string): void {
    const fd = openSync(path, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
