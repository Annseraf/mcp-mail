/**
 * `mcp-mail stdio` (local clients) plus the ChatGPT search/fetch adapters
 * and tool annotations, end to end against GreenMail.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FENCE_OPEN } from "../../src/content.js";
import { accountsFixture, seedMail } from "../compat/harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const root = path.resolve(import.meta.dirname, "../..");
let dir: string;
let child: ChildProcessWithoutNullStreams;
const pending = new Map<number, (v: Json) => void>();
let nextId = 1;

function request(method: string, params: object = {}): Promise<Json> {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
  });
}

describe("stdio transport", () => {
  beforeAll(async () => {
    await seedMail();
    dir = await mkdtemp(path.join(tmpdir(), "mcp-mail-stdio-"));
    await writeFile(path.join(dir, "accounts.json"), JSON.stringify(accountsFixture()));
    child = spawn(process.execPath, [path.join(root, "dist/index.js"), "stdio"], {
      env: {
        PATH: process.env.PATH ?? "",
        ACCOUNTS_FILE: path.join(dir, "accounts.json"),
        CHATGPT_COMPAT: "true",
        STDIO_PRESET: "read-only",
      },
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    });
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "1" },
    });
    expect(init.result.serverInfo.name).toBe("mcp-mail");
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  }, 60_000);

  afterAll(async () => {
    child?.kill();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("lists tools filtered by STDIO_PRESET, with annotations, including ChatGPT search/fetch", async () => {
    const tools = (await request("tools/list")).result.tools as Json[];
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_messages", "get_thread", "search", "fetch"]),
    );
    for (const hidden of [
      "send_message",
      "create_draft",
      "delete_message",
      "update_account_settings",
    ]) {
      expect(names).not.toContain(hidden);
    }
    expect(tools.find((t) => t.name === "get_message").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "search").outputSchema).toBeDefined();
  });

  it("search and fetch return ChatGPT's result shapes", async () => {
    const s = (await request("tools/call", { name: "search", arguments: { query: "Quarterly" } }))
      .result;
    expect(s.structuredContent.results[0]).toMatchObject({
      id: expect.stringMatching(/^main:INBOX:\d+$/),
      title: expect.stringContaining("Quarterly report"),
      url: expect.stringMatching(/^imap:\/\//),
    });
    expect(JSON.parse(s.content[0].text)).toEqual(s.structuredContent);
    const f = (
      await request("tools/call", {
        name: "fetch",
        arguments: { id: s.structuredContent.results[0].id },
      })
    ).result;
    expect(f.structuredContent).toMatchObject({
      title: "Quarterly report",
      metadata: { account: "main", mailbox: "INBOX" },
    });
    expect(f.structuredContent.text.startsWith(FENCE_OPEN)).toBe(true);
    expect(f.structuredContent.text).toContain("The report is attached");
  });
});
