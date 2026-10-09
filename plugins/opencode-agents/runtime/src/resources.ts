import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function compatibilityPath(): string {
  for (const relative of ["../../compatibility.json", "../compatibility.json"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error("bundled compatibility.json is missing");
}
