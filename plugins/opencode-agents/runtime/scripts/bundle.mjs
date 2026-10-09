import { build } from "esbuild";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const output = resolve(import.meta.dirname, "../../bin/opencode-agents.mjs");
const result = await build({
  entryPoints: [resolve(import.meta.dirname, "../src/cli.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "external",
  metafile: true,
});

const roots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const marker = `${resolve(import.meta.dirname, "../node_modules")}/`;
  const absolute = resolve(input);
  if (!absolute.startsWith(marker)) continue;
  const parts = absolute.slice(marker.length).split("/");
  const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  if (name) roots.add(resolve(import.meta.dirname, "../node_modules", name));
}
const mit = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n";
const notices = [];
for (const root of [...roots].sort()) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"].map((name) => resolve(root, name)).find(existsSync);
  if (!licenseFile && pkg.license !== "MIT") throw new Error(`Missing license notice for ${pkg.name}`);
  notices.push(`===== ${pkg.name}@${pkg.version} (${pkg.license ?? "license in file"}) =====\n${licenseFile ? readFileSync(licenseFile, "utf8") : mit}`);
}
writeFileSync(resolve(import.meta.dirname, "../../bin/THIRD_PARTY_LICENSES.txt"), `${notices.join("\n\n").trimEnd()}\n`);
