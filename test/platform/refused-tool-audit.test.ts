import { createMcpHandler, InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import type { AuditEntry } from "../../src/platform/audit.js";
import { guardTools } from "../../src/policy/guard.js";

function setup(record: (entry: AuditEntry) => Promise<void>) {
  const server = new McpServer({ name: "policy-test", version: "1.0.0" });
  guardTools(server, {
    policy: { id: "reader", capabilities: new Set(["read"]) },
    audit: { log: { record }, tenantId: "synthetic" },
  });
  const refused = vi.fn(async () => ({ content: [] }));
  server.registerTool("send_message", {}, refused);
  server.registerTool("list_accounts", {}, async () => ({ content: [] }));
  return { server, refused };
}

it("audits only known hidden tool attempts and preserves the legacy SDK response", async () => {
  const record = vi.fn<(entry: AuditEntry) => Promise<void>>().mockResolvedValue(undefined);
  const { server, refused } = setup(record);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  await client.start();
  let id = 0;
  async function request(method: string, params?: Record<string, unknown>) {
    const response = new Promise<JSONRPCMessage>((resolve) => {
      client.onmessage = resolve;
    });
    await client.send({ jsonrpc: "2.0", id: ++id, method, params });
    return response;
  }
  try {
    const list = await request("tools/list");
    expect(list).toMatchObject({ result: { tools: [{ name: "list_accounts" }] } });
    expect(JSON.stringify(list)).not.toContain("send_message");
    expect(await request("tools/call", { name: "unknown-fixture" })).toMatchObject({
      error: { code: -32602, message: "Tool unknown-fixture not found" },
    });
    expect(record).not.toHaveBeenCalled();
    expect(
      await request("tools/call", {
        name: "send_message",
        arguments: { text: "synthetic body", account: "sensitive account" },
      }),
    ).toMatchObject({ error: { code: -32602, message: "Tool send_message not found" } });
    expect(record.mock.calls).toEqual([
      [
        {
          tenantId: "synthetic",
          clientId: "reader",
          tool: "send_message",
          result: "denied",
          reason: "capability",
          ts: expect.any(String),
          durationMs: 0,
        },
      ],
    ]);
    expect(refused).not.toHaveBeenCalled();
  } finally {
    await server.close();
    await client.close();
  }
});

it("keeps modern denial unchanged even if the audit sink fails", async () => {
  const record = vi.fn<(entry: AuditEntry) => Promise<void>>().mockRejectedValue(new Error("disk"));
  const { server, refused } = setup(record);
  const protocolVersion = "2026-07-28";
  const handler = createMcpHandler(() => server, { legacy: "reject", responseMode: "json" });
  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocolVersion,
        "mcp-method": "tools/call",
        "mcp-name": "send_message",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "send_message",
          _meta: {
            "io.modelcontextprotocol/protocolVersion": protocolVersion,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "synthetic", version: "1.0.0" },
          },
        },
      }),
    }),
  );
  expect(await response.json()).toMatchObject({
    error: { code: -32602, message: "Tool send_message not found" },
  });
  expect(record).toHaveBeenCalledTimes(1);
  expect(refused).not.toHaveBeenCalled();
});
