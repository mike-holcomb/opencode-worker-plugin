#!/usr/bin/env node
/** Prepare and check the twelve frozen v2 scenarios. This tool never launches inference. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, 'v2-cases.json');
const packetSchemaPath = join(here, '..', 'schemas', 'task-packet.schema.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}
function die(message) { throw new Error(message); }
function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function hasPath(path) { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function safeRelative(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\') || value.includes('\0') ||
      value.split('/').some(part => !part || part === '.' || part === '..')) die(`unsafe relative path: ${String(value)}`);
  return value;
}
function safePath(root, relativePath) {
  const parts = safeRelative(relativePath).split('/');
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${sep}`)) die(`path escapes root: ${relativePath}`);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (hasPath(current) && lstatSync(current).isSymbolicLink()) die(`symlink in scenario path: ${current}`);
  }
  return target;
}
function fileHash(path) { return hash(readFileSync(path)); }
const schemaKeywords = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minLength', 'enum']);
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validateSchema(schema, path = 'packet schema') {
  if (!plainObject(schema) || !['object', 'array', 'string', 'boolean'].includes(schema.type) ||
      Object.keys(schema).some(key => !schemaKeywords.has(key))) die(`unsupported ${path}`);
  if (schema.type === 'object') {
    if (!plainObject(schema.properties) || !Array.isArray(schema.required) || schema.additionalProperties !== false ||
        schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key)) ||
        new Set(schema.required).size !== schema.required.length ||
        ['items', 'minLength', 'enum'].some(key => Object.hasOwn(schema, key))) die(`unsupported ${path}`);
    for (const [key, child] of Object.entries(schema.properties)) validateSchema(child, `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (!plainObject(schema.items) || ['properties', 'required', 'additionalProperties', 'minLength', 'enum'].some(key => Object.hasOwn(schema, key)))
      die(`unsupported ${path}`);
    validateSchema(schema.items, `${path}[]`);
  } else if (schema.type === 'string') {
    if (['properties', 'required', 'additionalProperties', 'items'].some(key => Object.hasOwn(schema, key)) ||
        (Object.hasOwn(schema, 'minLength') && (!Number.isInteger(schema.minLength) || schema.minLength < 0)) ||
        (Object.hasOwn(schema, 'enum') && (!Array.isArray(schema.enum) || !schema.enum.length ||
          schema.enum.some(value => typeof value !== 'string')))) die(`unsupported ${path}`);
  } else if (Object.keys(schema).some(key => key !== 'type' && key !== '$schema')) die(`unsupported ${path}`);
}
function validatePacketValue(value, schema, path) {
  if (schema.type === 'object') {
    if (!plainObject(value)) die(`${path} must be an object`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) die(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) die(`${path}.${key} is not allowed`);
      validatePacketValue(child, schema.properties[key], `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) die(`${path} must be an array`);
    value.forEach((item, index) => validatePacketValue(item, schema.items, `${path}[${index}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength !== undefined && [...value].length < schema.minLength) ||
        (schema.enum && !schema.enum.includes(value))) die(`${path} must match the packet schema`);
  } else if (typeof value !== 'boolean') die(`${path} must be a boolean`);
}
function snapshot(root) {
  const result = {};
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '__pycache__' || entry.name === '.pytest_cache') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = safePath(root, rel);
      if (entry.isSymbolicLink()) die(`symlink in scenario workspace: ${path}`);
      if (entry.isDirectory()) visit(path, rel);
      else if (entry.isFile()) result[rel] = fileHash(path);
      else die(`unsupported workspace entry: ${path}`);
    }
  }
  visit(root);
  return result;
}
function loadManifest() {
  const bytes = readFileSync(manifestPath);
  const manifest = JSON.parse(bytes.toString('utf8'));
  const packetSchemaBytes = readFileSync(packetSchemaPath);
  const packetSchema = JSON.parse(packetSchemaBytes.toString('utf8'));
  validateSchema(packetSchema);
  if (manifest.schema_version !== 2 || manifest.manifest_status !== 'frozen-before-run' || !Array.isArray(manifest.cases) || manifest.cases.length !== 12)
    die('expected twelve frozen v2 scenarios');
  const ids = new Set();
  let checks = 0, fixtures = 0;
  for (const scenario of manifest.cases) {
    if (typeof scenario.id !== 'string' || !/^[a-z0-9-]+$/.test(scenario.id) || ids.has(scenario.id)) die('duplicate or unsafe scenario id');
    ids.add(scenario.id);
    if (scenario.fixture !== `fixtures/${scenario.id}` || !scenario.packet || !Array.isArray(scenario.frozen_checks)) die(`invalid scenario: ${scenario.id}`);
    const packet = scenario.packet;
    validatePacketValue(packet, packetSchema, `scenario ${scenario.id} packet`);
    if (!packet.objective || !packet.title || !['lightweight', 'standard', 'full'].includes(packet.tier)) die(`invalid packet: ${scenario.id}`);
    const checkIds = scenario.frozen_checks.map(check => check.id);
    if (checkIds.length === 0 || new Set(checkIds).size !== checkIds.length ||
        checkIds.some(id => typeof id !== 'string' || !id)) die(`duplicate or empty check id: ${scenario.id}`);
    if (hash(canonical(scenario.frozen_checks)) !== scenario.frozen_checks_sha256) die(`frozen checks changed: ${scenario.id}`);
    const criteria = packet.acceptance_criteria?.map(criterion => criterion.id);
    if (!Array.isArray(criteria) || criteria.length !== checkIds.length || new Set(criteria).size !== criteria.length ||
        criteria.some(id => !checkIds.includes(id))) die(`packet/check mismatch: ${scenario.id}`);
    for (const item of packet.allowed_writes ?? []) safeRelative(item.path);
    safeRelative(scenario.result);
    if ((packet.allowed_writes ?? []).some(item => item.path === scenario.result))
      die(`result artifact must not be a project write: ${scenario.id}`);
    const fixtureRoot = safePath(here, scenario.fixture);
    if (!hasPath(fixtureRoot) || !lstatSync(fixtureRoot).isDirectory()) die(`fixture directory missing: ${scenario.id}`);
    const inputs = packet.authoritative_inputs?.filter(item => item.kind === 'file').map(item => safeRelative(item.reference));
    if (!Array.isArray(inputs) || !inputs.length || new Set(inputs).size !== inputs.length) die(`invalid fixture inputs: ${scenario.id}`);
    if (Object.keys(scenario.fixture_files_sha256 ?? {}).length !== inputs.length) die(`fixture hash map mismatch: ${scenario.id}`);
    for (const input of inputs) {
      const source = safePath(fixtureRoot, input);
      if (!hasPath(source) || !lstatSync(source).isFile() || fileHash(source) !== scenario.fixture_files_sha256[input])
        die(`fixture changed or missing: ${scenario.id}/${input}`);
      fixtures++;
    }
    for (const check of scenario.frozen_checks) {
      if (!['file_exists', 'text_contains', 'text_contains_any', 'unchanged_paths', 'allowed_changed_paths', 'command', 'parent_review'].includes(check.kind))
        die(`unknown frozen check kind: ${scenario.id}/${check.id}`);
      if (check.path) safeRelative(check.path);
      for (const path of check.paths ?? []) safeRelative(path);
      if (check.kind === 'command' && (check.argv?.[0] !== 'python3' || check.argv?.[1] !== '-m' || check.argv?.[2] !== 'unittest' ||
          !check.argv.every(value => typeof value === 'string') || !Number.isInteger(check.expect_exit)))
        die(`unsupported frozen command: ${scenario.id}/${check.id}`);
    }
    checks += checkIds.length;
  }
  return { manifest, sha256: hash(bytes), packetSchemaSha256: hash(packetSchemaBytes), checks, fixtures };
}
function chosen(manifest, id) {
  const scenario = manifest.cases.find(item => item.id === id);
  if (!scenario) die(`unknown scenario: ${id}`);
  return scenario;
}
function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key?.startsWith('--') || !args[index + 1] || Object.hasOwn(result, key.slice(2))) die(`invalid option: ${key}`);
    result[key.slice(2)] = args[index + 1];
  }
  return result;
}
function absoluteOption(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) die(`${label} must be an absolute path`);
  return resolve(value);
}
function prepare(loaded, opt) {
  const scenario = chosen(loaded.manifest, opt.case);
  const out = absoluteOption(opt.out, '--out');
  const state = absoluteOption(opt.state, '--state');
  if (!opt['run-id'] || !/^[A-Za-z0-9_.-]+$/.test(opt['run-id'])) die('--run-id is required and must be a simple identifier');
  if (hasPath(out) || hasPath(state)) die('refusing to reuse an existing workspace or state file');
  if (state === out || state.startsWith(`${out}${sep}`)) die('state must stay outside the worker workspace');
  if (out.startsWith(`${here}${sep}`)) die('prepared workspace must stay outside the source evaluation directory');
  mkdirSync(out, { mode: 0o700, recursive: true });
  const fixtureRoot = safePath(here, scenario.fixture);
  const files = scenario.packet.authoritative_inputs.filter(item => item.kind === 'file').map(item => item.reference);
  for (const name of files) {
    const destination = safePath(out, name);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(safePath(fixtureRoot, name), destination);
  }
  writeFileSync(join(out, 'task.md'), `${scenario.packet.objective.trimEnd()}\n`, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(out, 'scenario-input.json'), `${JSON.stringify({ schema_version: 2, scenario_id: scenario.id,
    run_id: opt['run-id'], tier: scenario.packet.tier, context_mode: scenario.context_mode,
    context_basis: scenario.context_basis, task_file: 'task.md', fixture_files: files }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const baseline = { schema_version: 2, scenario_id: scenario.id, run_id: opt['run-id'],
    prepared_workdir: realpathSync(out), manifest_sha256: loaded.sha256,
    packet_schema_sha256: loaded.packetSchemaSha256,
    frozen_checks_sha256: scenario.frozen_checks_sha256, initial_files: snapshot(out) };
  mkdirSync(dirname(state), { recursive: true, mode: 0o700 });
  writeFileSync(state, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { scenario_id: scenario.id, run_id: opt['run-id'], workdir: out, task_file: join(out, 'task.md'),
    state_file: state, result_artifact_name: scenario.result, packet: scenario.packet, checks_materialized: false };
}
function commandCheck(root, check) {
  const timeout = Number.isInteger(check.timeout_seconds) && check.timeout_seconds > 0 ? Math.min(check.timeout_seconds, 120) : 30;
  const run = spawnSync(check.argv[0], check.argv.slice(1), { cwd: root, encoding: 'utf8', timeout: timeout * 1000,
    maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (run.error) return { passed: false, detail: String(run.error) };
  return { passed: run.status === check.expect_exit,
    detail: `exit=${run.status}; stdout=${JSON.stringify(run.stdout?.slice(-400) ?? '')}; stderr=${JSON.stringify(run.stderr?.slice(-400) ?? '')}` };
}
function evaluate(root, scenario, baseline, check, resultFile) {
  const id = check.id, kind = check.kind;
  let passed, detail;
  if (kind === 'parent_review') return { id, kind, status: 'review_required', detail: check.reason ?? 'parent review required' };
  if (kind === 'file_exists') {
    const path = check.path === scenario.result ? resultFile : safePath(root, check.path);
    passed = hasPath(path) && lstatSync(path).isFile(); detail = check.path === scenario.result ? `verified result artifact: ${check.path}` : check.path;
  } else if (kind === 'text_contains' || kind === 'text_contains_any') {
    const path = check.path === scenario.result ? resultFile : safePath(root, check.path);
    const text = hasPath(path) && lstatSync(path).isFile() ? readFileSync(path, 'utf8').toLocaleLowerCase() : '';
    const matches = (check.values ?? []).map(value => text.includes(String(value).toLocaleLowerCase()));
    passed = kind === 'text_contains' ? matches.every(Boolean) : matches.some(Boolean);
    detail = `searched ${check.path} for ${matches.length} frozen marker(s)`;
  } else if (kind === 'unchanged_paths') {
    const current = snapshot(root); const changed = (check.paths ?? []).filter(path => current[path] !== baseline.initial_files[path]);
    passed = changed.length === 0; detail = `changed=${JSON.stringify(changed)}`;
  } else if (kind === 'allowed_changed_paths') {
    const current = snapshot(root); const initial = baseline.initial_files;
    const changed = [...new Set([...Object.keys(initial), ...Object.keys(current)])].filter(path => initial[path] !== current[path]).sort();
    const allowed = scenario.packet.allowed_writes ?? [];
    const unauthorized = changed.filter(path => !allowed.some(item => item.kind === 'directory' ?
      path === item.path || path.startsWith(`${item.path}/`) : path === item.path));
    passed = unauthorized.length === 0; detail = `changed=${JSON.stringify(changed)}; unauthorized=${JSON.stringify(unauthorized)}`;
  } else if (kind === 'command') ({ passed, detail } = commandCheck(root, check));
  else die(`unsupported check: ${kind}`);
  return { id, kind, status: passed ? 'pass' : 'fail', detail };
}
function check(loaded, opt) {
  const scenario = chosen(loaded.manifest, opt.case);
  const workdir = absoluteOption(opt.workdir, '--workdir');
  const state = absoluteOption(opt.state, '--state');
  const resultFile = absoluteOption(opt['result-file'], '--result-file');
  if (!hasPath(workdir) || !lstatSync(workdir).isDirectory() || !hasPath(state)) die('prepared workspace or external state is missing');
  const root = realpathSync(workdir);
  if (state === root || state.startsWith(`${root}${sep}`)) die('state must stay outside the worker workspace');
  if (resultFile === root || resultFile.startsWith(`${root}${sep}`) || !hasPath(resultFile) ||
      !lstatSync(resultFile).isFile() || lstatSync(resultFile).isSymbolicLink())
    die('result artifact must be an existing regular file outside the worker workspace');
  if (!/^[a-f0-9]{64}$/.test(opt['result-sha256'] ?? '') || fileHash(resultFile) !== opt['result-sha256'])
    die('exported result artifact SHA-256 does not match the supplied immutable artifact hash');
  const baseline = JSON.parse(readFileSync(state, 'utf8'));
  if (baseline.schema_version !== 2 || baseline.scenario_id !== scenario.id || baseline.prepared_workdir !== root ||
      baseline.manifest_sha256 !== loaded.sha256 || baseline.packet_schema_sha256 !== loaded.packetSchemaSha256 ||
      baseline.frozen_checks_sha256 !== scenario.frozen_checks_sha256 ||
      !baseline.initial_files || typeof baseline.initial_files !== 'object') die('baseline does not match frozen scenario and workspace');
  const results = scenario.frozen_checks.map(item => evaluate(root, scenario, baseline, item, resultFile));
  const failed = results.some(item => item.status === 'fail');
  const reviews = results.some(item => item.status === 'review_required');
  return { result: { schema_version: 2, scenario_id: scenario.id, result_artifact_sha256: opt['result-sha256'],
    status: failed ? 'fail' : reviews ? 'review_required' : 'pass',
    parent_review_required: reviews, checks: results }, exit: failed ? 1 : reviews ? 2 : 0 };
}
try {
  const [command, ...args] = process.argv.slice(2);
  const loaded = loadManifest();
  if (command === 'validate' && args.length === 0) output({ schema_version: 2, scenario_count: loaded.manifest.cases.length,
    frozen_check_count: loaded.checks, fixture_file_count: loaded.fixtures, manifest_sha256: loaded.sha256,
    packet_schema_sha256: loaded.packetSchemaSha256, inference_started: false });
  else if (command === 'list' && args.length === 0) output(loaded.manifest.cases.map(item => ({ id: item.id, title: item.packet.title, tier: item.packet.tier })));
  else if (command === 'prepare') output(prepare(loaded, options(args)));
  else if (command === 'check') { const value = check(loaded, options(args)); output(value.result); process.exitCode = value.exit; }
  else die('usage: harness.mjs validate|list|prepare --case ID --run-id ID --out ABS --state ABS|check --case ID --workdir ABS --state ABS --result-file ABS --result-sha256 SHA256');
} catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 3; }
