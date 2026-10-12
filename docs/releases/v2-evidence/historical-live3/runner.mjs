import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from './package/runtime/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import { StdioClientTransport } from './package/runtime/node_modules/@modelcontextprotocol/client/dist/stdio.mjs';
import { rpcRequest } from './package/runtime/dist/rpc.js';

const root = '/private/tmp/opencode-agents-live-extra-20261012-001';
const state = join(root, 'state');
const scope = 'live-extra-20261012';
const node = '/Users/S197758/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node';
const cli = join(root, 'package/runtime/dist/cli.js');
const log = (type, data) => console.log(JSON.stringify({ at: new Date().toISOString(), type, ...data }));
const packet = (answer) => ({
  title: `Independent ${answer} fixture inspection`,
  objective: `Read input.txt in this workspace. Identify the fixture answer ${answer} only after reading the file. Write a complete schema-valid result.json and summary.md in the assigned report directory. Preserve all project files.`,
  tier: 'lightweight',
  authoritative_inputs: [{ reference: 'input.txt', kind: 'file', purpose: 'Fixture fact to inspect' }],
  context: { verified_facts: [], rejected_assumptions: [], exclusions: ['No network use or project edits'] },
  allowed_writes: [],
  acceptance_criteria: [{ id: 'fact', requirement: `Report cites input.txt and states ${answer}`, evidence_required: 'File content and report artifact', required: true }],
  checks: [{ id: 'inspect-input', description: 'Read input.txt and report its answer' }],
  constraints: ['Use the configured local model endpoint only', 'Do not change project files'],
  stop_conditions: ['Stop if the assigned report path cannot be written'],
  shared_resources: [],
});
const startInput = (name, answer) => ({
  scope_id: scope,
  idempotency_key: `live-extra-start-${name}-20261012`,
  workspace: { path: join(root, `workspace-${name}`), access: 'exclusive' },
  model: { profile: 'local' },
  profile: 'bounded-inspect',
  limits: { queue_timeout_seconds: 120, execution_timeout_seconds: 240 },
  packet: packet(answer),
});
async function openMcp() {
  const transport = new StdioClientTransport({ command: node, args: [cli, 'mcp'], cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')), stderr: 'pipe' });
  const client = new Client({ name: 'v2-live-extra', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result));
  return result.structuredContent;
}
let first, second, client1, client2;
try {
  client1 = await openMcp();
  first = await call(client1.client, 'opencode_start_task', startInput('a', 'alpha'));
  log('started_a', { task_id: first.taskId, execution_id: first.executionId, phase: first.phase });
  second = await rpcRequest(state, 'start_task', startInput('b', 'beta'));
  log('started_b', { task_id: second.taskId, execution_id: second.executionId, phase: second.phase });
  const started = Date.now();
  let seenA = '', seenB = '', overlap = false, disconnected = false, reconnected = false;
  while (Date.now() - started < 300000) {
    const [a, b] = await Promise.all([
      rpcRequest(state, 'get_task', { scope_id: scope, task_id: first.taskId }),
      rpcRequest(state, 'get_task', { scope_id: scope, task_id: second.taskId }),
    ]);
    for (const [name, s] of [['a', a], ['b', b]]) {
      if ((name === 'a' ? seenA : seenB) !== `${s.phase}/${s.observation}`) {
        log('phase', { name, phase: s.phase, observation: s.observation, session_id: s.sessionId,
          message_id: s.userMessageId, revision: s.revision });
        if (name === 'a') seenA = `${s.phase}/${s.observation}`;
        else seenB = `${s.phase}/${s.observation}`;
      }
    }
    if (!overlap && ['running', 'waiting_input'].includes(a.phase) && ['running', 'waiting_input'].includes(b.phase)) {
      overlap = true;
      log('overlap', { a_session: a.sessionId, b_session: b.sessionId,
        a_message: a.userMessageId, b_message: b.userMessageId });
    }
    if (!disconnected && ['running', 'waiting_input'].includes(a.phase)) {
      const mcpState = await call(client1.client, 'opencode_get_task', { scope_id: scope, task_id: first.taskId });
      log('mcp_before_disconnect', { phase: mcpState.phase, session_id: mcpState.sessionId,
        message_id: mcpState.userMessageId, revision: mcpState.revision });
      await client1.client.close();
      disconnected = true;
      log('mcp_disconnected', { task_id: first.taskId });
      client2 = await openMcp();
      const recovered = await call(client2.client, 'opencode_get_task', { scope_id: scope, task_id: first.taskId });
      reconnected = true;
      log('mcp_reconnected', { phase: recovered.phase, session_id: recovered.sessionId,
        message_id: recovered.userMessageId, execution_id: recovered.executionId, revision: recovered.revision });
    }
    if (a.terminal && b.terminal) {
      log('terminal', { overlap, disconnected, reconnected,
        a: { phase: a.phase, report_validity: a.reportValidity, manifest: a.finalManifestHash, artifacts: a.artifacts },
        b: { phase: b.phase, report_validity: b.reportValidity, manifest: b.finalManifestHash, artifacts: b.artifacts } });
      break;
    }
    await sleep(500);
  }
  const [a, b] = await Promise.all([
    rpcRequest(state, 'get_task', { scope_id: scope, task_id: first.taskId }),
    rpcRequest(state, 'get_task', { scope_id: scope, task_id: second.taskId }),
  ]);
  log('final_snapshot', { overlap, disconnected, reconnected,
    a: { phase: a.phase, observation: a.observation, session_id: a.sessionId,
      message_id: a.userMessageId, report_validity: a.reportValidity, manifest: a.finalManifestHash },
    b: { phase: b.phase, observation: b.observation, session_id: b.sessionId,
      message_id: b.userMessageId, report_validity: b.reportValidity, manifest: b.finalManifestHash } });
} catch (error) {
  log('harness_error', { error: String(error), stack: error?.stack ?? null });
  process.exitCode = 1;
} finally {
  if (client2) await client2.client.close().catch(() => {});
  if (client1) await client1.client.close().catch(() => {});
}
