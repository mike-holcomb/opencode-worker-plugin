import assert from "node:assert/strict";
import { test } from "node:test";
import { SdkOpenCodeBackend } from "../opencode-backend.js";

test("a denied tool-call step is not mistaken for a completed turn", async () => {
  const backend = new SdkOpenCodeBackend("http://127.0.0.1:1", "/tmp", "test");
  const userId = "msg_user";
  Object.assign(backend, { client: {
    session: {
      messages: async () => ({ data: [
        { info: { id: userId, role: "user" }, parts: [] },
        { info: { id: "msg_assistant", role: "assistant", parentID: userId, finish: "tool-calls" },
          parts: [{ type: "tool", state: { status: "error" } }] },
      ] }),
      status: async () => ({ data: {} }),
    },
    permission: { list: async () => ({ data: [] }) },
    question: { list: async () => ({ data: [] }) },
    v2: { session: {
      permission: { list: async () => ({ data: { data: [] } }) },
      question: { list: async () => ({ data: { data: [] } }) },
    } },
  } });
  const observation = await backend.inspectTurn("ses_test", userId);
  assert.equal(observation.submitted, true);
  assert.equal(observation.status, "unknown");
  assert.equal(observation.statusOmitted, true);
  assert.equal(observation.finished, false);
});
