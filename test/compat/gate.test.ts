/**
 * Compatibility gate (docs/COMPATIBILITY.md). Requires a build (`npm run build`)
 * and a running GreenMail; run with `npm run test:compat`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  legacySession,
  MODERN_VERSION,
  modernSession,
  startServer,
  type RunningServer,
} from "./harness.js";
import { listTools, runScenario, type ScenarioResult } from "./scenario.js";
import {
  compareOutputs,
  compareToolLists,
  type OutputRecord,
  type Tool,
  type Violation,
} from "./schema-compat.js";

const root = path.resolve(import.meta.dirname, "../..");
const BASELINES = ["v0.2.1"];

const load = <T>(ref: string, file: string): T =>
  JSON.parse(readFileSync(path.join(root, "compat/baseline", ref, file), "utf8")) as T;

const report = (vs: Violation[]) =>
  vs.map((v) => `${v.kind}: ${v.tool} ${v.path} — ${v.detail}`).join("\n");

describe("compatibility gate", () => {
  let server: RunningServer;
  let current: ScenarioResult;
  let modern: ScenarioResult;

  beforeAll(async () => {
    if (!existsSync(path.join(root, "dist/index.js"))) throw new Error("run `npm run build` first");
    server = await startServer(root);
    // A failing scenario must still let the tools/list check report precisely.
    try {
      current = await runScenario(await legacySession(server));
    } catch (err) {
      current = {
        tools: await listTools(await legacySession(server)),
        outputs: [],
        aborted: String(err),
      };
    }
    modern = await runScenario(modernSession(server)).catch((err) => ({
      tools: [],
      outputs: [],
      aborted: String(err),
    }));
  }, 90_000);

  afterAll(async () => {
    await server?.stop();
  });

  for (const ref of BASELINES) {
    it(`tools/list is a compatible superset of ${ref}`, () => {
      const violations = compareToolLists(load<Tool[]>(ref, "tools-list.json"), current.tools);
      expect(violations, report(violations)).toEqual([]);
    });

    it(`tool outputs keep every field ${ref} produced`, () => {
      expect(current.aborted, "scenario aborted on a protocol error").toBeUndefined();
      const violations = compareOutputs(load<OutputRecord[]>(ref, "outputs.json"), current.outputs);
      expect(violations, report(violations)).toEqual([]);
    });
  }

  // Legacy (initialize-based) clients, including Claude.ai's existing connector.
  for (const version of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
    it(`serves a legacy ${version} client (initialize -> tools/list -> tools/call)`, async () => {
      const call = await legacySession(server, version);
      const list = await call("tools/list");
      expect(list.status).toBe(200);
      expect(list.body.result.tools.length).toBeGreaterThanOrEqual(14);
      const res = await call("tools/call", { name: "list_accounts", arguments: {} });
      expect(res.body.result.isError ?? false).toBe(false);
    });
  }

  it("answers legacy clients with plain JSON, like v0.2.x (no SSE)", async () => {
    for (const method of ["initialize", "tools/list"]) {
      const res = await server.raw(
        {
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "x", version: "1" },
          },
        },
        { "mcp-protocol-version": "2025-06-18" },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("mcp-session-id")).toBeNull();
    }
  });

  it("rejects requests without the bearer token", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("serves concurrent requests that overlap in time", async () => {
    // list_folders does real IMAP I/O, so these requests are in flight together.
    const call = await legacySession(server);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call("tools/call", {
          name: "list_folders",
          arguments: { account: i % 2 ? "work" : "main" },
        }),
      ),
    );
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.error).toBeUndefined();
    }
  });

  // 2026-07-28 clients: stateless, no initialize, per-request _meta.
  describe(`${MODERN_VERSION} clients`, () => {
    for (const ref of BASELINES) {
      it(`see the same compatible tools and outputs as ${ref}`, () => {
        expect(modern.aborted, "modern scenario aborted").toBeUndefined();
        const tools = compareToolLists(load<Tool[]>(ref, "tools-list.json"), modern.tools);
        expect(tools, report(tools)).toEqual([]);
        const outputs = compareOutputs(load<OutputRecord[]>(ref, "outputs.json"), modern.outputs);
        expect(outputs, report(outputs)).toEqual([]);
      });
    }

    it("server/discover advertises supported versions, tools and server info", async () => {
      const res = await modernSession(server)("server/discover");
      expect(res.status).toBe(200);
      const r = res.body.result;
      expect(r.supportedVersions).toContain(MODERN_VERSION);
      expect(r.capabilities.tools).toBeDefined();
      expect(r.resultType).toBe("complete");
    });

    it("tools/call works without a handshake", async () => {
      const res = await modernSession(server)("tools/call", {
        name: "list_accounts",
        arguments: {},
      });
      expect(res.status).toBe(200);
      expect(res.body.result.resultType).toBe("complete");
      expect(res.body.result.isError ?? false).toBe(false);
    });

    it("rejects a header/body mismatch with HTTP 400 and -32020", async () => {
      const res = await modernSession(server)(
        "tools/call",
        { name: "list_accounts", arguments: {} },
        { "mcp-name": "list_folders" },
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32020);
    });

    it("rejects an unsupported protocol version with HTTP 400 and -32022", async () => {
      const res = await server.rpc(
        "tools/list",
        {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "1900-01-01",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
        { protocolVersion: "1900-01-01", headers: { "mcp-method": "tools/list" } },
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32022);
      expect(res.body.error.data.supported).toContain(MODERN_VERSION);
    });
  });
});
