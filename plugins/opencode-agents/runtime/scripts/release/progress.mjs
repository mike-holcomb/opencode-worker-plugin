// Explicit live certification fixture: metadata checkpoints only, never transcript replay.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SqliteTaskStore } from '../../dist/store.js';
import { ArtifactStore } from '../../dist/artifacts.js';
import { ExecutionCoordinator } from '../../dist/coordinator.js';
import { SupervisorService } from '../../dist/service.js';
import { createMcpServer } from '../../dist/mcp.js';
const args = process.argv.slice(2);
const opt = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
assert(args.includes('--execute') && args.includes('--out') && args.includes('--binary'), 'Require --execute --out NEW_PATH --binary ABSOLUTE_PATH');
const out = resolve(opt('--out')); mkdirSync(out, { mode: 0o700 });
const workspace = join(out, 'workspace'), state = join(out, 'state');
for (const dir of [workspace, state, join(out, 'home'), join(out, 'config/opencode')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const route = opt('--route', 'http://127.0.0.1:8124/v1'), model = opt('--model', 'muse-glimmer-30b');
writeFileSync(join(workspace, 'README.md'), 'Read-only checkpoint audit fixture. Inspect the backend contract and distinguish lifecycle, progress, and acceptance.\n');
copyFileSync(new URL('../../src/backend.ts', import.meta.url), join(workspace, 'backend.ts'));
writeFileSync(join(out, 'config/opencode/opencode.json'), JSON.stringify({ provider: { 'llama.cpp': { npm: '@ai-sdk/openai-compatible', options: { baseURL: route }, models: { [model]: { limit: { context: 131072, output: 32768 } } } } } }));
writeFileSync(join(state, 'config.json'), JSON.stringify({ schema_version: 1, project_roots: [workspace], read_roots: [],
  opencode_binary: resolve(opt('--binary')), models: { local: { provider_id: 'llama.cpp', model_id: model, destination: route } },
  development_execution: { enabled: true, trusted_workspaces: [workspace] } }));
process.env.OPENCODE_AGENTS_STATE_DIR = state; process.env.OPENCODE_AGENTS_CONFIG = join(state, 'config.json');
process.env.XDG_CONFIG_HOME = join(out, 'config'); process.env.OPENCODE_CONFIG_DIR = join(out, 'config/opencode');
process.env.OPENCODE_TEST_HOME = join(out, 'home'); delete process.env.OPENCODE_CONFIG; delete process.env.OPENCODE_CONFIG_CONTENT;
const store = new SqliteTaskStore(join(state, 'state.sqlite')), artifacts = new ArtifactStore(join(state, 'artifacts'));
const coordinator = new ExecutionCoordinator(store, artifacts), service = new SupervisorService(store, artifacts, coordinator);
const server = createMcpServer((method, input) => service.handle(method, input));
const client = new Client({ name: 'progress-certification-parent', version: '1' });
const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]); await coordinator.start();
let parentBytes = 0, progressBytes = 0, progressReads = 0;
const call = async (name, input) => {
  const result = await client.callTool({ name, arguments: input });
  const bytes = Buffer.byteLength(JSON.stringify(result)); parentBytes += bytes;
  if (name === 'opencode_get_progress') { progressBytes += bytes; progressReads++; }
  assert(!result.isError, JSON.stringify(result)); return result.structuredContent;
};
let task;
try {
  const packet = { tier: 'lightweight', title: 'Native checkpoint audit',
    objective: 'Read README.md, then publish a meaningful report_progress milestone before reading backend.ts. Read backend.ts and publish a second checkpoint. Explain backend support and checkpoint capability in the exact assigned final WorkerReport and summary.md. Do not modify project files or run shell commands. Each checkpoint must include stage,summary,completed,remaining,blocker:null,evidence_refs:[]. Do not include raw excerpts or hidden reasoning.',
    authoritative_inputs: ['README.md', 'backend.ts'].map(reference => ({ kind: 'file', reference, purpose: 'Frozen audit source' })),
    context: { verified_facts: ['Native report_progress is advisory and available in shared-read mode.'], rejected_assumptions: [], exclusions: ['Implementation changes'] },
    allowed_writes: [], acceptance_criteria: [{ id: 'audit', required: true, requirement: 'Trace backend support and checkpoint capability', evidence_required: 'Final report source references' }],
    checks: [], constraints: ['Read-only project; no shell or parent toolkit'], stop_conditions: ['Stop if sources unavailable'], shared_resources: [] };
  task = await call('opencode_start_task', { scope_id: 'progress-certification', idempotency_key: 'progress-certification-start-0001', workspace: { path: workspace, access: 'shared_read' },
    model: { provider_id: 'llama.cpp', model_id: model }, profile: 'bounded-inspect', limits: { queue_timeout_seconds: 60, execution_timeout_seconds: 300 }, packet });
  const refs = { scope_id: task.scopeId, task_id: task.taskId, execution_id: task.executionId };
  let snapshot = await call('opencode_get_task', refs), eventCursor = snapshot.cursor;
  let page = await call('opencode_get_progress', refs), cursor = page.next_cursor;
  const updates = [...page.updates]; let beforeTerminal = updates.length > 0 && !snapshot.terminal;
  const deadline = Date.now() + 330000;
  while (!snapshot.terminal && Date.now() < deadline) {
    const waited = await call('opencode_wait_tasks', { scope_id: task.scopeId, targets: [{ task_id: task.taskId, execution_id: task.executionId, after_cursor: eventCursor, after_progress_cursor: cursor }], timeout_ms: 20000 });
    if (waited.timed_out) continue;
    const changed = waited.changed[0]; eventCursor = changed.cursor; snapshot = changed.task;
    assert.equal(changed.updates, undefined, 'wait must contain hints, not checkpoint bodies');
    if (changed.progress_cursor) {
      page = await call('opencode_get_progress', { ...refs, after_cursor: cursor }); cursor = page.next_cursor;
      beforeTerminal ||= page.updates.length > 0 && !snapshot.terminal; updates.push(...page.updates);
      const empty = await call('opencode_get_progress', { ...refs, after_cursor: cursor }); assert.deepEqual(empty.updates, []); assert.equal(empty.snapshot, null);
    }
  }
  snapshot = await call('opencode_get_task', refs);
  assert.equal(snapshot.phase, 'completed'); assert.equal(snapshot.reportValidity, 'valid'); assert.equal(snapshot.reviewStatus, 'pending');
  assert.ok(beforeTerminal && updates.length >= 2, 'milestones must arrive before completion');
  const result = { version: '1.19.0', model, task_id: task.taskId, execution_id: task.executionId, phase: snapshot.phase, report_validity: snapshot.reportValidity,
    checkpoint_count: updates.length, checkpoint_bytes: Buffer.byteLength(JSON.stringify(updates)), parent_visible_bytes: parentBytes,
    progress_response_bytes: progressBytes, progress_read_count: progressReads, checkpoint_before_terminal: beforeTerminal, waiting_delivers_hints_only: true };
  writeFileSync(join(out, 'metrics.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally {
  // Preserve active identities on failure; close only this fixture's owned services.
  if (task) writeFileSync(join(out, 'task.json'), JSON.stringify(store.get(task.scopeId, task.taskId), null, 2));
  await client.close(); await server.close(); await coordinator.close(); store.close();
}
