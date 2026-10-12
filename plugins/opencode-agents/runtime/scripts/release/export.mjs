// Export portable release evidence; private runtime state is never traversed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [sourceArg, targetArg] = process.argv.slice(2);
assert(sourceArg && targetArg, 'Usage: node export.mjs CAMPAIGN NEW_OUTPUT');
const source = resolve(sourceArg), target = resolve(targetArg);
assert(source !== target && !target.startsWith(source + '/'), 'Output must be outside the private campaign');
mkdirSync(target, { mode: 0o700 }); // Deliberately refuse an existing destination.
const inventory = [];
function copy(from, to) {
  assert(lstatSync(from).isFile(), `Refusing non-regular evidence: ${from}`);
  const bytes = readFileSync(from);
  copyFileSync(from, to);
  inventory.push({ path: to.slice(target.length + 1), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
}
function fixture(from, to) {
  assert(lstatSync(from).isDirectory(), `Refusing linked fixture root: ${from}`);
  mkdirSync(to);
  for (const name of readdirSync(from)) {
    if (['.git', '__pycache__', '.pytest_cache'].includes(name)) continue;
    const path = join(from, name), stat = lstatSync(path);
    assert(!stat.isSymbolicLink(), `Review fixture symlink before export: ${path}`);
    if (stat.isDirectory()) fixture(path, join(to, name));
    else copy(path, join(to, name));
  }
}
const files = ['metrics.json', 'final.json', 'exports.json', 'packet.json', 'checks.json',
  'decision.json', 'review.json', 'parent-assertions.json', 'review-context.json',
  'rejection-context.json', 'rejection-measurement.json', 'summary.md', 'runtime-hashes.json',
  'continuation.json', 'observed-usage.json', 'predecessor-observed-usage.json', 'events.jsonl',
  'baseline.json', 'preparation.json', 'predecessor.json', 'peer-final.json',
  'assertion-error.json', 'error.json', 'parent-guidance.json'];
for (const name of ['campaign.json', 'blocked.json']) {
  if (existsSync(join(source, name))) copy(join(source, name), join(target, name));
}
for (const name of readdirSync(source)) {
  const dir = join(source, name);
  if (!lstatSync(dir).isDirectory() || !existsSync(join(dir, 'packet.json'))) continue;
  const out = join(target, name); mkdirSync(out);
  const exports = existsSync(join(dir, 'exports.json')) ? JSON.parse(readFileSync(join(dir, 'exports.json'))) : [];
  const names = new Set(files);
  for (const artifact of exports) {
    assert(artifact.path === basename(artifact.path), 'Artifact path must be a basename');
    const path = join(dir, artifact.path);
    assert(lstatSync(path).isFile(), 'Artifact must be a regular file');
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), artifact.sha256);
    names.add(artifact.path);
  }
  for (const file of names) if (existsSync(join(dir, file))) copy(join(dir, file), join(out, file));
  // Continuations refer to the original isolated fixture. Never copy its parent/state.
  const final = existsSync(join(dir, 'final.json')) ? JSON.parse(readFileSync(join(dir, 'final.json'))) : null;
  const workspace = final?.workspace ?? join(dir, 'workspace');
  if (existsSync(workspace)) fixture(workspace, join(out, 'workspace'));
  if (existsSync(join(dir, 'peer'))) fixture(join(dir, 'peer'), join(out, 'peer'));
}
writeFileSync(join(target, 'inventory.json'), JSON.stringify({ source, exported_at: new Date().toISOString(),
  warning: 'Inspect fixture/report content for secrets before sharing. Private HOME/XDG/state/config/transport are excluded.',
  files: inventory }, null, 2));
console.log(JSON.stringify({ output: target, files: inventory.length }));
