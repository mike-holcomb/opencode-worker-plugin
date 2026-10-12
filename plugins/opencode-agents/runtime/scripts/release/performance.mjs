// Release fixture: real MCP client/service/store/coordinator; programmable in-process backend.
// No provider or OpenCode process is used. Output is external to the installed bundle.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, realpathSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { connect as connectSocket } from 'node:net';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer } from '../../dist/mcp.js';
import { SupervisorService } from '../../dist/service.js';
import { ExecutionCoordinator } from '../../dist/coordinator.js';
import { SqliteTaskStore } from '../../dist/store.js';
import { ArtifactStore } from '../../dist/artifacts.js';

const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const count = Number(option('--count', '1000'));
const duration = Number(option('--duration-seconds', '3600'));
assert(Number.isInteger(count) && count > 0 && Number.isFinite(duration) && duration >= 0);
const out = resolve(option('--out', ''));
assert(args.includes('--out'), '--out must name a new evidence directory');
mkdirSync(out); const root = realpathSync(out);
const workspace = join(root, 'workspace'); mkdirSync(workspace);
writeFileSync(join(workspace, 'input.txt'), 'violet\n');
const state = join(root, 'state'); mkdirSync(state);
process.env.OPENCODE_AGENTS_CONFIG = join(root, 'config.json');
process.env.OPENCODE_AGENTS_STATE_DIR = state;
writeFileSync(process.env.OPENCODE_AGENTS_CONFIG, JSON.stringify({ schema_version: 1,
  project_roots: [workspace], read_roots: [], opencode_binary: process.execPath,
  development_execution: { enabled: true, trusted_workspaces: [workspace] },
  models: { fixture: { provider_id: 'fake', model_id: 'short', destination: 'local' } },
  limits: { concurrency: 1, queue_timeout_seconds: 60, execution_timeout_seconds: 60,
    finalization_timeout_seconds: 10, artifact_bytes: 1000000 } }));
const store = new SqliteTaskStore(join(state, 'state.sqlite'));
const artifacts = new ArtifactStore(join(state, 'artifacts'));
const active = new Set(); let dispatches = 0, opened = 0, closed = 0, subscriptions = 0;
let eventAt = 0;
const coordinator = new ExecutionCoordinator(store, artifacts, async ({ backendId, workspace: path, launchContract }) => {
  opened++;
  const child = fork(new URL('./fake-process.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const [ready] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('fake backend exited during startup'); })]);
  const socket = connectSocket(ready.port, '127.0.0.1'); await once(socket, 'connect');
  socket.on('error', () => {});
  socket.on('data', () => wake?.());
  let finished = false, session, message, wake, stopped = false;
  const lease = { backendId, backend: {
    async inspectBackend() { return { version: 'fake', openapiDigest: 'fixture', backendId, workspace: path,
      configurationDigest: 'fixture', supportedForExecution: true,
      capabilities: { callerAssignedMessageId: true, permissionRequests: true, sessionRecovery: true,
        questionRequests: false, structuredOutput: false } }; },
    async findCreatedSession() { return null; },
    async createSession(marker) { session = `ses_${marker}`; return { id: session, backendId, workspace: path }; },
    async submitTurn(input) {
      assert.equal(message, undefined, 'duplicate submission'); message = input.messageId; dispatches++;
      const task = store.unresolved().find(t => t.userMessageId === message);
      assert(task);
      mkdirSync(launchContract.reportPath, { recursive: true });
      writeFileSync(join(launchContract.reportPath, 'summary.md'), 'input.txt contains violet.\n');
      writeFileSync(join(launchContract.reportPath, 'result.json'), JSON.stringify({ schema_version: 2,
        task_id: task.taskId, execution_id: task.executionId, outcome: 'completed', summary: 'Read input.txt',
        coverage: ['input.txt'], gaps: [], findings: [], changes: [], checks: [], blockers: [], next_action: 'Parent review' }));
    },
    async inspectTurn(s, m) { assert.equal(s, session); assert.equal(m, message);
      return { submitted: true, assistantMessageIds: finished ? ['assistant'] : [], activeTools: 0,
        status: finished ? 'idle' : 'busy', pendingRequests: [], finished, error: null }; },
    async *subscribeEvents({ signal }) {
      subscriptions++;
      const abort = () => wake?.(); signal.addEventListener('abort', abort, { once: true });
      try { while (!signal.aborted) { await new Promise(r => { wake = r; });
        if (!signal.aborted) yield { type: 'session.updated', sessionId: session, data: {} }; }
      } finally { signal.removeEventListener('abort', abort); subscriptions--; }
    },
    async readResult() { return { text: '', structured: null }; },
    async abortSession() { throw new Error('unexpected abort'); },
    async replyToRequest() { throw new Error('unexpected permission request'); },
  }, async close() { if (!stopped) {
      socket.destroy(); child.disconnect();
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      stopped = true; closed++; active.delete(lease);
    } },
    finish() { finished = true; eventAt = performance.now(); socket.write('material-event\n'); } };
  lease.pid = child.pid; active.add(lease); return lease;
});
const service = new SupervisorService(store, artifacts, coordinator, async (_binary, _workspace, reportPath) => ({
  reportPath, effectiveConfigSha256: reportPath,
  configContent: JSON.stringify({ provider: { fake: { options: { baseURL: 'http://127.0.0.1:1' }, models: { short: {} } } } }),
}));
let client, server;
async function connect() {
  client = new Client({ name: 'release-performance', version: '1' });
  server = createMcpServer((method, params) => service.handle(method, params));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
}
async function call(name, arguments_) {
  const value = await client.callTool({ name: `opencode_${name}`, arguments: arguments_ });
  assert(!value.isError, JSON.stringify(value)); return value.structuredContent;
}
const packet = { title: 'Short execution', objective: 'Read input.txt', tier: 'lightweight',
  authoritative_inputs: [{ reference: 'input.txt', kind: 'file', purpose: 'Source' }],
  context: { verified_facts: [], rejected_assumptions: [], exclusions: [] }, allowed_writes: [],
  acceptance_criteria: [], checks: [], constraints: [], stop_conditions: [], shared_resources: [] };
assert(Buffer.byteLength(JSON.stringify(packet)) < 16384);
const timings = [], resources = [];
const sample = () => { const value = { at: new Date().toISOString(), elapsed_ms: performance.now() - began,
  ...process.memoryUsage(), backend_pids: [...active].map(l => l.pid), active_backends: active.size, subscriptions, opened, closed,
  handles: process.getActiveResourcesInfo().sort() }; resources.push(value);
  appendFileSync(join(root, 'resources.jsonl'), JSON.stringify(value) + '\n'); };
const began = performance.now(); let sampler; let baselineSamples = [];
const quantile = (values, q) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*q)-1];
const median = values => quantile(values, .5);
try {
  await connect(); await coordinator.start();
  assert.equal((await client.listTools()).tools.length, 10);
  const digest = file => createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex');
  const metadata = { source_sha256: Object.fromEntries(['../../dist/coordinator.js','../../dist/service.js','../../dist/store.js','./performance.mjs','./fake-process.mjs'].map(f => [f, digest(f)])), node: process.version, platform: process.platform, arch: process.arch,
    commit: execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(),
    count, duration_seconds: duration, fixture: 'in-memory MCP transport; programmable backend with real loopback event sockets and owned child processes; real SQLite and evidence capture',
    limits: { start_p95_ms: 2000, get_p95_ms: 250, event_p95_ms: 1000, wait_slack_ms: 1000 },
    limitations: ['Fake child lifecycle, not the OpenCode executable; live cases cover the managed OpenCode launcher'] };
  writeFileSync(join(root, 'fixture.json'), JSON.stringify(metadata, null, 2));
  const warmup = 20; let measuredStart;
  sampler = setInterval(sample, 10000);
  for (let i = -warmup; i < count; i++) {
    if (i === 0) { measuredStart = performance.now(); sample(); baselineSamples = [resources.at(-1)]; }
    if (i >= 0) await sleep(Math.max(0, measuredStart + i * duration * 1000 / count - performance.now()));
    const startAt = performance.now();
    const task = await call('start_task', { scope_id: 'performance', idempotency_key: `performance-start-${i + warmup}`,
      workspace: { path: workspace, access: 'exclusive' }, model: { profile: 'fixture' }, profile: 'bounded-inspect',
      limits: { queue_timeout_seconds: 60, execution_timeout_seconds: 60 }, packet });
    const start_ms = performance.now() - startAt;
    const params = { scope_id: 'performance', task_id: task.taskId };
    let current;
    const deadline = performance.now() + 15000;
    do { current = await call('get_task', params); if (current.phase !== 'running') await sleep(5);
      assert(performance.now() < deadline, `dispatch timeout ${JSON.stringify(current)}`);
    } while (current.phase !== 'running');
    const getAt = performance.now(); await call('get_task', params); const get_ms = performance.now() - getAt;
    const waitAt = performance.now();
    const waited = await call('wait_tasks', { scope_id: 'performance', targets: [{ task_id: task.taskId, after_cursor: current.cursor }], timeout_ms: 10 });
    const wait_ms = performance.now() - waitAt; assert(waited.timed_out);
    if (i === 0) { const before = dispatches; await client.close(); await server.close(); await sleep(30);
      await connect(); assert.equal(dispatches, before, 'disconnect submitted more work'); }
    [...active].at(-1).finish();
    let visibleAt;
    do { current = await call('get_task', params);
      if (['finalizing','completed'].includes(current.phase)) visibleAt ??= performance.now();
      if (!current.terminal) await sleep(5);
      assert(performance.now() < deadline, `completion timeout ${JSON.stringify(current)}`);
    } while (!current.terminal);
    while (active.size) { assert(performance.now() < deadline, 'backend cleanup timed out'); await sleep(5); }
    assert.equal(current.phase, 'completed'); assert.equal(current.reportValidity, 'valid');
    if (i >= 0) { const row = { i, start_ms, get_ms, wait_ms, event_ms: visibleAt - eventAt };
      timings.push(row); appendFileSync(join(root, 'timings.jsonl'), JSON.stringify(row) + '\n'); }
    if (i % 100 === 0) console.log(JSON.stringify({ completed: i + 1, total: count, active: active.size, subscriptions }));
  }
  await sleep(Math.max(0, measuredStart + duration * 1000 - performance.now())); sample();
  const baseline = median(baselineSamples.map(s => s.rss));
  const finalSamples = resources.filter(s => s.elapsed_ms >= resources.at(-1).elapsed_ms - 600000);
  const finalRss = median(finalSamples.map(s => s.rss));
  const p95 = Object.fromEntries(['start_ms','get_ms','event_ms'].map(key => [key, quantile(timings.map(t => t[key]), .95)]));
  const passes = { latency: p95.start_ms <= 2000 && p95.get_ms <= 250 && p95.event_ms <= 1000,
    waits: timings.every(t => t.wait_ms <= 1010), dispatches: dispatches === count + warmup,
    memory: finalRss <= baseline + Math.max(baseline * .2, 32 * 1024 * 1024),
    backends: active.size === 0 && subscriptions === 0 && resources.every(s => s.active_backends <= 1 && s.subscriptions <= 1),
    resource_trend: resources.every(s => s.handles.length <= resources[0].handles.length + 12),
    duration: performance.now() - measuredStart >= duration * 1000 };
  writeFileSync(join(root, 'result.json'), JSON.stringify({ ...metadata, passes, p95,
    dispatches, baseline_rss: baseline, final_median_rss: finalRss,
    release_sized: count >= 1000 && duration >= 3600,
    status: Object.values(passes).every(Boolean) ? 'passed_fixture' : 'failed' }, null, 2));
  assert(Object.values(passes).every(Boolean), JSON.stringify(passes));
} catch (error) {
  writeFileSync(join(root, 'error.json'), JSON.stringify({ error: String(error), stack: error.stack }, null, 2));
  process.exitCode = 1;
} finally {
  clearInterval(sampler); await client?.close(); await server?.close(); await coordinator.close(); store.close();
}
