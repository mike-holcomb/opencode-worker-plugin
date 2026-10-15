import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createMcpServer } from "../mcp.js";

test("MCP client discovers eleven tools and read-only annotations, then calls health", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const server = createMcpServer(async (method, params) => {
    calls.push({ method, params });
    return { healthy: true, version: "2.0.0-dev.0" };
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 11);
    assert.equal(listed.tools.find((tool) => tool.name === "opencode_health")?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools.find((tool) => tool.name === "opencode_get_progress")?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools.find((tool) => tool.name === "opencode_start_task")?.annotations?.readOnlyHint, undefined);
    const response = await client.callTool({ name: "opencode_health", arguments: {} });
    assert.deepEqual(response.structuredContent, { healthy: true, version: "2.0.0-dev.0" });
    assert.deepEqual(calls.map((call) => call.method), ["health"]);
  } finally {
    await client.close();
    await server.close();
  }
});
