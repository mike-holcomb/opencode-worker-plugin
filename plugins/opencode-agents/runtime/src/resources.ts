import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function compatibilityPath(): string {
  for (const relative of ["../../compatibility.json", "../compatibility.json"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error("bundled compatibility.json is missing");
}

/** Resolve packaged worker instructions from either compiled source or the single-file bundle. */
export function workerProfilePath(profile: "bounded-build" | "bounded-inspect"): string {
  for (const relative of [`../../worker/${profile}.md`, `../worker/${profile}.md`]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error(`bundled worker profile is missing: ${profile}`);
}
