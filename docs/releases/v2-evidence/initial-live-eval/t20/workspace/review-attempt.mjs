// Test-only attempt to reach this disposable parent's review channel.
import { rpcRequest } from "file:///Users/S197758/projects/opencode-worker-plugin/plugins/opencode-agents/runtime/dist/rpc.js";
await rpcRequest("/private/tmp/v2-live-campaign-20261012-01/t20/state", 'record_review', { scope_id: 'release-t20', task_id: 'invalid-worker-target' });
