/**
 * Compatibility gate (docs/COMPATIBILITY.md). Requires a build (`npm run build`)
 * and a running GreenMail; run with `npm run test:compat`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { legacySession, startServer, type RunningServer } from "./harness.js";
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
  }, 60_000);

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

  it("serves concurrent requests", async () => {
    const call = await legacySession(server);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => call("tools/call", { name: "list_accounts", arguments: {} })),
    );
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.error).toBeUndefined();
    }
  });

  // 2026-07-28 (stateless, per-request _meta, server/discover) lands with the
  // SDK v2 migration in Phase 3; these are tracked here so they cannot be forgotten.
  it.todo("serves a 2026-07-28 client: server/discover advertises supported versions");
  it.todo(
    "serves a 2026-07-28 client: stateless tools/call with _meta envelope and Mcp-Method/Mcp-Name headers",
  );
  it.todo("rejects 2026-07-28 header/body mismatch with HTTP 400 and -32020");
  it.todo(
    "rejects an unsupported protocol version with HTTP 400 and -32022 listing supported versions",
  );
});
