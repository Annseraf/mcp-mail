import type { McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../../src/platform/audit.js";
import { guardTenantTools, type TenantContext } from "../../src/platform/runtime.js";
import { DEFAULT_LIMITS, type ClientRecord } from "../../src/platform/tenants.js";
import { PRESETS } from "../../src/policy/capabilities.js";
import { guardTools } from "../../src/policy/guard.js";

type Call = (args: Record<string, unknown>) => Promise<unknown>;

function registrations() {
  const calls = new Map<string, Call>();
  const server = {
    registerTool(name: string, _schema: unknown, call: Call) {
      calls.set(name, call);
    },
  };
  return { server: server as unknown as McpServer, calls, register: server };
}

describe("hosted calendar permissions", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mcp-calendar-policy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function hosted(overrides: Partial<ClientRecord>) {
    const { server, calls, register } = registrations();
    const client: ClientRecord = {
      id: "agent-one",
      name: "Synthetic agent",
      type: "generic",
      preset: "full",
      sendEnabled: false,
      tokenHash: "synthetic",
      status: "active",
      createdAt: "",
      ...overrides,
    };
    const tenant: TenantContext["tenant"] = {
      id: "tenant-one",
      status: "active",
      revision: 1,
      createdAt: "",
      updatedAt: "",
      limits: DEFAULT_LIMITS,
      mailboxes: [],
      clients: [client],
    };
    guardTenantTools(server, { tenant, client }, new AuditLog(dir));
    const handler = vi.fn(async () => ({ content: [] }));
    for (const tool of [
      "list_calendars",
      "list_events",
      "find_free_slot",
      "create_event",
      "list_folders",
    ]) {
      register.registerTool(tool, {}, handler);
    }
    return { calls, handler };
  }

  it.each([
    { label: "legacy", flags: {} },
    { label: "new", flags: { calendarReadEnabled: false, calendarWriteEnabled: false } },
  ])("denies and audits ordinary calendar calls for a $label client", async ({ flags }) => {
    const { calls, handler } = hosted(flags);
    const tools = ["list_calendars", "list_events", "find_free_slot", "create_event"];
    for (const tool of tools) {
      expect(
        await calls.get(tool)!({ account: "synthetic", title: "private title" }),
      ).toMatchObject({
        isError: true,
      });
    }
    expect(handler).not.toHaveBeenCalled();
    const log = await readFile(path.join(dir, "tenant-one.jsonl"), "utf8");
    expect(log).not.toContain("private title");
    expect(
      log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toMatchObject(
      tools.map((tool) => ({
        tenantId: "tenant-one",
        clientId: "agent-one",
        tool,
        result: "denied",
        reason: tool === "create_event" ? "calendar-write-disabled" : "calendar-read-disabled",
      })),
    );
    expect(await calls.get("list_folders")!({})).toEqual({ content: [] });
  });

  it.each([
    { calendarReadEnabled: true, calendarWriteEnabled: false },
    { calendarReadEnabled: false, calendarWriteEnabled: true },
  ])("enforces read and write switches independently (%j)", async (flags) => {
    const { calls, handler } = hosted(flags);
    for (const [tool, enabled] of [
      ["list_events", flags.calendarReadEnabled],
      ["create_event", flags.calendarWriteEnabled],
    ] as const) {
      expect(await calls.get(tool)!({})).toMatchObject(
        enabled ? { content: [] } : { isError: true },
      );
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps the preset as a permission ceiling", () => {
    const { calls } = hosted({ preset: "read-only", calendarWriteEnabled: true });
    expect(calls.has("create_event")).toBe(false);
  });

  it("preserves standalone calendar presets", async () => {
    const { server, calls, register } = registrations();
    guardTools(server, { policy: { id: "standalone", capabilities: new Set(PRESETS.full) } });
    for (const tool of ["list_events", "create_event"]) {
      register.registerTool(tool, {}, async () => ({ content: [] }));
      expect(await calls.get(tool)!({})).toEqual({ content: [] });
    }
  });
});
