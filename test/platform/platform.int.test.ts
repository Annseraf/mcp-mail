/**
 * Multi-tenant mode + admin API, end to end against GreenMail
 * (docs/PLATFORM.md). Run with `npm run test:compat`.
 *
 * Proves: no cross-tenant access through tokens, endpoints, tools or
 * credentials; deleting a tenant purges secrets, cache, tokens and audit;
 * secrets never come back through the API, logs or tool output; every admin
 * response matches openapi/admin-v1.json.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountsStore } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { createEngine, listen, type Engine } from "../../src/engine.js";
import { LocalKeyFileProvider } from "../../src/platform/secrets.js";
import type { PlatformSettings } from "../../src/platform/settings.js";
import { mail, seedMail, MODERN_VERSION } from "../compat/harness.js";
import { checkResponse, covered, operations } from "./contract.js";

// Responses are checked against the OpenAPI spec; tests then read fields freely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ADMIN_TOKEN = randomBytes(24).toString("hex");
const logs: string[] = [];
const webhooks: { body: Json; signature: string | null }[] = [];

/** UIDs of messages with this subject in a user's folder. */
async function findMail(
  u: { email: string; pass: string },
  folder: string,
  subject: string,
): Promise<number[]> {
  const c = new ImapFlow({
    host: mail.host,
    port: mail.imapPort,
    secure: false,
    auth: { user: u.email, pass: u.pass },
    logger: false,
  });
  await c.connect();
  try {
    const lock = await c.getMailboxLock(folder);
    try {
      const found = await c.search({ subject }, { uid: true });
      return Array.isArray(found) ? found : [];
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

async function eventually(fn: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let dir: string;
let engine: Engine;
let servers: Server[] = [];
let appUrl: string;
let adminUrl: string;

const endpointOf = (u: { email: string; pass: string }, kind: "imap" | "smtp") => ({
  host: mail.host,
  port: kind === "imap" ? mail.imapPort : mail.smtpPort,
  tls: false,
  user: u.email,
  password: u.pass,
});

const mailboxBody = (id: string, u: { email: string; pass: string }) => ({
  id,
  label: id,
  default: true,
  imap: endpointOf(u, "imap"),
  smtp: endpointOf(u, "smtp"),
  mail: { defaultFrom: u.email, draftsFolder: "Drafts", sentFolder: "Sent" },
});

async function admin(
  method: string,
  p: string,
  body?: unknown,
  token = ADMIN_TOKEN,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${adminUrl}/admin/v1${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  checkResponse(method, p.split("?")[0], res.status, parsed);
  return { status: res.status, body: parsed };
}

let rpcId = 1;
async function mcp(
  tenantId: string,
  token: string,
  method: string,
  params: object = {},
): Promise<{ status: number; body: Json }> {
  const p = params as { name?: string };
  const res = await fetch(`${appUrl}/t/${tenantId}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN_VERSION,
      "mcp-method": method,
      ...(p.name ? { "mcp-name": p.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const call = async (tenantId: string, token: string, name: string, args: object = {}) => {
  const r = await mcp(tenantId, token, "tools/call", { name, arguments: args });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.result as { isError?: boolean; content: { text: string }[] };
};
const toolNames = async (tenantId: string, token: string) =>
  ((await mcp(tenantId, token, "tools/list")).body.result.tools as { name: string }[]).map(
    (t) => t.name,
  );

describe("platform: multi-tenant mode and admin API", () => {
  const A = "tenant-a";
  const B = "tenant-b";
  let tokenA = "";
  let tokenB = "";

  beforeAll(async () => {
    await seedMail();
    dir = await mkdtemp(path.join(tmpdir(), "mcp-mail-platform-"));
    const store = new AccountsStore(path.join(dir, "accounts.json"));
    await store.reload();
    const platform: PlatformSettings = {
      multiTenant: true,
      dataDir: dir,
      tenantBaseUrl: "https://connect.example.com",
      configProvider: "store",
      configCacheTtlMs: 0,
      keyProvider: "local",
      keyFile: "",
      adminApi: true,
      adminHost: "127.0.0.1",
      adminPort: 0,
      adminToken: ADMIN_TOKEN,
      approvals: {
        ttlMs: 3_600_000,
        webhookUrl: "https://product.example.com/hooks/approvals",
        webhookSecret: "hook-secret",
      },
    };
    engine = await createEngine({
      version: "test",
      authToken: randomBytes(16).toString("hex"),
      accountsFile: path.join(dir, "accounts.json"),
      store,
      pool: new ClientPool(store),
      platform,
      keyProvider: LocalKeyFileProvider.fromKey(randomBytes(32)),
      log: (level, msg, extra) => logs.push(JSON.stringify({ level, msg, ...extra })),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        webhooks.push({
          body: JSON.parse(String(init.body)),
          signature: new Headers(init.headers).get("x-mcp-mail-signature"),
        });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const app = await listen(engine.app, 0, "127.0.0.1");
    const adm = await listen(engine.admin!, 0, "127.0.0.1");
    servers = [app, adm];
    appUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    adminUrl = `http://127.0.0.1:${(adm.address() as { port: number }).port}`;
  }, 60_000);

  afterAll(async () => {
    for (const s of servers) s.close();
    await engine?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("rejects admin calls without the service token", async () => {
    expect((await admin("GET", "/health", undefined, "wrong")).status).toBe(401);
    expect((await admin("GET", "/health")).body).toEqual({ status: "ok" });
    expect((await admin("GET", "/version")).body.commit).toBeTypeOf("string");
  });

  it("creates tenants, mailboxes and clients", async () => {
    const limits = { maxMailboxes: 2, maxClients: 3, toolCallsPerDay: 1000, allowSend: false };
    expect((await admin("POST", "/tenants", { id: A, limits })).status).toBe(201);
    expect((await admin("POST", "/tenants", { id: B, limits })).status).toBe(201);
    expect((await admin("POST", "/tenants", { id: A })).status).toBe(409);
    expect((await admin("POST", "/tenants", { id: "Bad/../id" })).status).toBe(400);

    expect(
      (await admin("POST", `/tenants/${A}/mailboxes`, mailboxBody("main", mail.users.alice)))
        .status,
    ).toBe(201);
    expect(
      (await admin("POST", `/tenants/${B}/mailboxes`, mailboxBody("main", mail.users.bob))).status,
    ).toBe(201);

    const ca = await admin("POST", `/tenants/${A}/clients`, {
      id: "agent",
      name: "Agent A",
      preset: "read-draft",
    });
    const cb = await admin("POST", `/tenants/${B}/clients`, {
      id: "agent",
      name: "Agent B",
      preset: "read-draft",
    });
    expect(ca.status).toBe(201);
    expect(ca.body.endpoint).toBe(`https://connect.example.com/t/${A}/mcp`);
    tokenA = ca.body.token;
    tokenB = cb.body.token;
    expect(tokenA).toMatch(/^mcpm_/);
  });

  it("serves each tenant its own mailboxes only", async () => {
    const a = JSON.parse((await call(A, tokenA, "list_accounts")).content[0].text);
    const b = JSON.parse((await call(B, tokenB, "list_accounts")).content[0].text);
    expect(a.accounts.map((x: { smtp_from: string }) => x.smtp_from)).toEqual([
      mail.users.alice.email,
    ]);
    expect(b.accounts.map((x: { smtp_from: string }) => x.smtp_from)).toEqual([
      mail.users.bob.email,
    ]);
    const inbox = await call(A, tokenA, "list_messages", { mailbox: "INBOX" });
    expect(inbox.isError ?? false).toBe(false);
    expect(inbox.content[0].text).toContain("Quarterly report");
  });

  it("binds tokens to one tenant", async () => {
    expect((await mcp(B, tokenA, "tools/list")).status).toBe(401);
    expect((await mcp(A, tokenB, "tools/list")).status).toBe(401);
    expect((await mcp("tenant-nope", tokenA, "tools/list")).status).toBe(401);
    expect((await mcp(A, "mcpm_invalid", "tools/list")).status).toBe(401);
  });

  it("cannot reach another tenant's mailbox by account id", async () => {
    await admin("POST", `/tenants/${B}/mailboxes`, {
      ...mailboxBody("only-b", mail.users.bob),
      default: false,
    });
    const r = await call(A, tokenA, "list_messages", { mailbox: "INBOX", account: "only-b" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("not configured");
  });

  it("filters tools by preset and rejects calls to hidden tools", async () => {
    const names = await toolNames(A, tokenA);
    expect(names).toContain("create_draft");
    for (const hidden of [
      "send_message",
      "delete_message",
      "move_message",
      "mark_read",
      "create_event",
    ]) {
      expect(names).not.toContain(hidden);
    }
    const r = await mcp(A, tokenA, "tools/call", {
      name: "delete_message",
      arguments: { mailbox: "INBOX", uid: 1 },
    });
    expect(r.body.error ?? r.body.result?.isError).toBeTruthy();
  });

  it("restricts a client to its allowed mailboxes", async () => {
    await admin("POST", `/tenants/${A}/mailboxes`, {
      ...mailboxBody("second", mail.users.alice),
      default: false,
    });
    const c = await admin("POST", `/tenants/${A}/clients`, {
      name: "Scoped",
      accounts: ["second"],
    });
    const r = JSON.parse((await call(A, c.body.token, "list_accounts")).content[0].text);
    expect(r.accounts.map((x: { id: string }) => x.id)).toEqual(["second"]);
    expect((await call(A, c.body.token, "list_folders", { account: "main" })).isError).toBe(true);
    await admin("POST", `/tenants/${A}/clients/${c.body.client.id}/revoke`);
  });

  it("gates sending behind the tenant limit, the client toggle and the recipient cap", async () => {
    const c = await admin("POST", `/tenants/${A}/clients`, {
      id: "sender",
      name: "Sender",
      preset: "full-no-delete",
    });
    const send = (to: string | string[]) =>
      call(A, c.body.token, "send_message", { to, subject: "Hi", text: "hello" });
    expect((await send(mail.users.bob.email)).content[0].text).toContain(
      "not enabled for this account",
    );
    await admin("PUT", `/tenants/${A}/limits`, { allowSend: true, maxRecipientsPerSend: 2 });
    expect((await send(mail.users.bob.email)).content[0].text).toContain(
      "turned off for this client",
    );
    await admin("PATCH", `/tenants/${A}/clients/sender`, { sendEnabled: true });
    expect(
      (await send(["a@example.com", "b@example.com", "c@example.com"])).content[0].text,
    ).toContain("Too many recipients");
    expect((await send(mail.users.bob.email)).isError ?? false).toBe(false);
    await admin("POST", `/tenants/${A}/clients/sender/revoke`);
  });

  it("revokes and rotates one client without affecting others", async () => {
    const c = await admin("POST", `/tenants/${A}/clients`, { id: "temp", name: "Temp" });
    const old = c.body.token;
    const rotated = await admin("POST", `/tenants/${A}/clients/temp/rotate`);
    expect((await mcp(A, old, "tools/list")).status).toBe(401);
    expect((await mcp(A, rotated.body.token, "tools/list")).status).toBe(200);
    await admin("POST", `/tenants/${A}/clients/temp/revoke`);
    expect((await mcp(A, rotated.body.token, "tools/list")).status).toBe(401);
    expect((await admin("POST", `/tenants/${A}/clients/temp/rotate`)).status).toBe(409);
    expect((await mcp(A, tokenA, "tools/list")).status).toBe(200);
    expect((await mcp(B, tokenB, "tools/list")).status).toBe(200);
  });

  it("enforces client and mailbox limits", async () => {
    expect(
      (await admin("POST", `/tenants/${B}/mailboxes`, mailboxBody("third", mail.users.bob))).status,
    ).toBe(422);
    await admin("POST", `/tenants/${B}/clients`, { name: "b2" });
    await admin("POST", `/tenants/${B}/clients`, { name: "b3" });
    expect((await admin("POST", `/tenants/${B}/clients`, { name: "b4" })).status).toBe(422);
  });

  it("suspends and unsuspends a tenant", async () => {
    await admin("POST", `/tenants/${B}/suspend`);
    const r = await call(B, tokenB, "list_accounts");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("suspended");
    await admin("POST", `/tenants/${B}/unsuspend`);
    expect((await call(B, tokenB, "list_accounts")).isError ?? false).toBe(false);
  });

  it("falls back to the server's Drafts folder when the configured one is missing", async () => {
    // The configured name doesn't exist; the server's Drafts folder does, so the
    // draft goes there instead of failing (with no Drafts at all, it's created).
    const patched = await admin("PATCH", `/tenants/${A}/mailboxes/main`, {
      mail: { draftsFolder: `Entwurf-${Date.now()}` },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const subject = `missing drafts ${Date.now()}`;
    const r = await call(A, tokenA, "create_draft", {
      to: "someone@example.com",
      subject,
      text: "hi",
    });
    expect(r.isError ?? false, r.content[0].text).toBe(false);
    expect(JSON.parse(r.content[0].text).folder).toBe("Drafts");
    expect(await findMail(mail.users.alice, "Drafts", subject)).toHaveLength(1);
    await admin("PATCH", `/tenants/${A}/mailboxes/main`, { mail: { draftsFolder: "Drafts" } });
  });

  it("pauses and resumes a client without revoking it", async () => {
    const paused = await admin("PATCH", `/tenants/${B}/clients/agent`, { paused: true });
    expect(paused.body.paused).toBe(true);
    expect(paused.body.pausedAt).toBeTruthy();
    expect(paused.body.status).toBe("active");
    const r = await call(B, tokenB, "list_accounts");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("paused");
    // Other tenants' clients are unaffected.
    expect((await call(A, tokenA, "list_accounts")).isError ?? false).toBe(false);
    const reasons = (await admin("GET", `/tenants/${B}/audit`)).body.entries.map(
      (e: Json) => e.reason,
    );
    expect(reasons).toContain("client-paused");
    const resumed = await admin("PATCH", `/tenants/${B}/clients/agent`, { paused: false });
    expect(resumed.body.paused).toBe(false);
    expect(resumed.body.pausedAt).toBeNull();
    // Same token works again: nothing to reconnect.
    expect((await call(B, tokenB, "list_accounts")).isError ?? false).toBe(false);
  });

  it("enforces the daily tool-call limit", async () => {
    const usage = await admin("GET", `/tenants/${B}/usage`);
    await admin("PUT", `/tenants/${B}/limits`, { toolCallsPerDay: usage.body.today + 1 });
    expect((await call(B, tokenB, "list_accounts")).isError ?? false).toBe(false);
    const r = await call(B, tokenB, "list_accounts");
    expect(r.content[0].text).toContain("Daily tool-call limit");
    await admin("PUT", `/tenants/${B}/limits`, { toolCallsPerDay: 1000 });
  });

  it("records an audit trail without content, paginated and filterable", async () => {
    const page = await admin("GET", `/tenants/${A}/audit?limit=2`);
    expect(page.body.entries).toHaveLength(2);
    expect(page.body.nextCursor).toBeTypeOf("string");
    const next = await admin("GET", `/tenants/${A}/audit?limit=2&cursor=${page.body.nextCursor}`);
    expect(next.body.entries[0].ts <= page.body.entries[1].ts).toBe(true);
    const filtered = await admin("GET", `/tenants/${A}/audit?client=sender&limit=500`);
    expect(filtered.body.entries.length).toBeGreaterThan(0);
    expect(filtered.body.entries.every((e: { clientId: string }) => e.clientId === "sender")).toBe(
      true,
    );
    expect(
      filtered.body.entries.some((e: { reason?: string }) => e.reason === "recipient-cap"),
    ).toBe(true);
    const raw = await readFile(path.join(dir, "audit", `${A}.jsonl`), "utf8");
    expect(raw).not.toContain("Quarterly report");
    expect(raw).not.toContain("hello");
    expect((await admin("GET", `/tenants/${A}/audit?limit=0`)).status).toBe(400);
  });

  it("tests a mailbox without saving it, and never echoes the password", async () => {
    const ok = await admin("POST", `/tenants/${A}/mailboxes/test`, {
      imap: endpointOf(mail.users.alice, "imap"),
      smtp: endpointOf(mail.users.alice, "smtp"),
    });
    expect(ok.body).toEqual({ imap: { ok: true }, smtp: { ok: true } });
    const bad = await admin("POST", `/tenants/${A}/mailboxes/test`, {
      imap: { ...endpointOf(mail.users.alice, "imap"), port: 1 },
      smtp: { ...endpointOf(mail.users.alice, "smtp"), port: 1 },
    });
    expect(bad.body.imap.ok).toBe(false);
    expect(JSON.stringify(bad.body)).not.toContain(mail.users.alice.pass);
  });

  it("updates and removes mailboxes; passwords are write-only", async () => {
    const before = await admin("GET", `/tenants/${A}/mailboxes`);
    expect(before.body.mailboxes.map((m: { id: string }) => m.id)).toContain("second");
    const patched = await admin("PATCH", `/tenants/${A}/mailboxes/second`, {
      label: "Renamed",
      imap: { password: "rotated-secret-123" },
    });
    expect(patched.body.label).toBe("Renamed");
    expect((await admin("DELETE", `/tenants/${A}/mailboxes/second`)).status).toBe(204);
    expect((await admin("PATCH", `/tenants/${A}/mailboxes/second`, { label: "x" })).status).toBe(
      404,
    );
  });

  it("never returns secrets through the API, logs or disk in plaintext", async () => {
    const views = JSON.stringify([
      (await admin("GET", `/tenants/${A}`)).body,
      (await admin("GET", `/tenants/${A}/clients`)).body,
      (await admin("GET", `/tenants/${A}/mailboxes`)).body,
    ]);
    for (const s of [mail.users.alice.pass, "rotated-secret-123", tokenA, "sha256:"]) {
      expect(views).not.toContain(s);
      expect(logs.join("\n")).not.toContain(s);
    }
    const secretsFile = await readFile(path.join(dir, "secrets", `${A}.json`), "utf8");
    expect(secretsFile).not.toContain(mail.users.alice.pass);
    const tenantFile = await readFile(path.join(dir, "tenants", `${A}.json`), "utf8");
    expect(tenantFile).not.toContain(mail.users.alice.pass);
    expect(tenantFile).not.toContain(tokenA);
    if (process.platform !== "win32") {
      expect((await stat(path.join(dir, "secrets", `${A}.json`))).mode & 0o077).toBe(0);
    }
  });

  it("serves legacy initialize-based clients on tenant endpoints", async () => {
    const res = await fetch(`${appUrl}/t/${A}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy", version: "1" },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result.protocolVersion).toBe("2025-06-18");
  });

  it("lets a tenant's agent set its mailbox signature, visible to the admin API", async () => {
    const c = await admin("POST", `/tenants/${A}/clients`, {
      id: "settings",
      name: "Settings",
      preset: "full-no-delete",
    });
    const r = await call(A, c.body.token, "update_account_settings", {
      from_name: "Alice A",
      signature: "Alice\nA Corp",
    });
    expect(r.isError ?? false).toBe(false);
    const mb = (await admin("GET", `/tenants/${A}/mailboxes`)).body.mailboxes.find(
      (m: { id: string }) => m.id === "main",
    );
    expect(mb.mail).toMatchObject({ defaultFromName: "Alice A", signature: "Alice\nA Corp" });
    const readDraft = await call(A, tokenA, "list_accounts");
    expect(JSON.parse(readDraft.content[0].text).accounts[0].signature).toBe("Alice\nA Corp");
    expect(await toolNames(A, tokenA)).not.toContain("update_account_settings");
    await admin("POST", `/tenants/${A}/clients/settings/revoke`);
  });

  it("examples/admin-client.mjs works end to end", async () => {
    const { execFile } = await import("node:child_process");
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        [
          path.resolve(import.meta.dirname, "../../examples/admin-client.mjs"),
          mail.users.alice.email,
          mail.users.alice.pass,
          mail.host,
          mail.host,
        ],
        {
          env: {
            PATH: process.env.PATH,
            ADMIN_URL: adminUrl,
            ADMIN_TOKEN,
            MAIL_TLS: "false",
            IMAP_PORT: String(mail.imapPort),
            SMTP_PORT: String(mail.smtpPort),
          },
        },
        (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
      ),
    );
    const tenantId = /tenant (\S+)/.exec(out)![1];
    const agentToken = /token \(shown once\): (\S+)/.exec(out)![1];
    expect(out).toContain(`endpoint: https://connect.example.com/t/${tenantId}/mcp`);
    expect((await call(tenantId, agentToken, "list_accounts")).isError ?? false).toBe(false);
    await admin("DELETE", `/tenants/${tenantId}`);
  });

  it("holds sends for approval: the owner approves or rejects from Drafts", async () => {
    const T = "tenant-ask";
    await admin("POST", "/tenants", {
      id: T,
      limits: { maxMailboxes: 1, maxClients: 2, toolCallsPerDay: 1000, allowSend: true },
    });
    await admin("POST", `/tenants/${T}/mailboxes`, mailboxBody("main", mail.users.alice));
    const c = await admin("POST", `/tenants/${T}/clients`, {
      id: "asker",
      name: "Asker",
      preset: "full-no-delete",
      sendEnabled: true,
      sendMode: "approval",
    });
    expect(c.body.client.sendMode).toBe("approval");
    const token = c.body.token;
    const tools = (await mcp(T, token, "tools/list")).body.result.tools as Json[];
    expect(tools.find((t) => t.name === "send_message").description).toMatch(/approves every send/);

    const subject = `Approve me ${randomBytes(3).toString("hex")}`;
    const held = await call(T, token, "send_message", {
      to: mail.users.bob.email,
      bcc: "carol@example.com",
      subject,
      text: "Held for the owner",
    });
    expect(held.isError ?? false).toBe(false);
    expect(held.content[0].text).toMatch(/awaiting_approval/);
    expect(await findMail(mail.users.alice, "Drafts", subject)).toHaveLength(1);
    expect(await findMail(mail.users.bob, "INBOX", subject)).toHaveLength(0);

    // The product hears about it, signed.
    const hook = webhooks.find((w) => w.body.tenantId === T);
    expect(hook?.body.type).toBe("approval.created");
    expect(hook?.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const pending = await admin("GET", `/tenants/${T}/approvals?status=pending`);
    expect(pending.body.approvals).toHaveLength(1);
    const id = pending.body.approvals[0].id;
    expect(hook?.body.approvalId).toBe(id);
    const one = await admin("GET", `/tenants/${T}/approvals/${id}`);
    expect(one.body.preview).toMatchObject({
      to: [mail.users.bob.email],
      bcc: ["carol@example.com"],
      subject,
    });
    expect(one.body.preview.text).toMatch(/Held for the owner/);
    expect((await admin("GET", `/tenants/${T}/approvals?status=nope`)).status).toBe(400);
    expect((await admin("GET", `/tenants/${T}/approvals/ap-000000000000`)).status).toBe(404);

    const approved = await admin("POST", `/tenants/${T}/approvals/${id}/approve`);
    expect(approved.body.status).toBe("approved");
    expect(
      await eventually(async () => (await findMail(mail.users.bob, "INBOX", subject)).length === 1),
    ).toBe(true);
    expect(await findMail(mail.users.alice, "Drafts", subject)).toHaveLength(0);
    expect(await findMail(mail.users.alice, "Sent", subject)).toHaveLength(1);
    expect((await admin("POST", `/tenants/${T}/approvals/${id}/approve`)).status).toBe(409);

    // Rejecting removes the draft and sends nothing.
    const other = `Reject me ${randomBytes(3).toString("hex")}`;
    await call(T, token, "send_message", { to: mail.users.bob.email, subject: other, text: "No" });
    const id2 = (await admin("GET", `/tenants/${T}/approvals?status=pending`)).body.approvals[0].id;
    expect((await admin("POST", `/tenants/${T}/approvals/${id2}/reject`)).body.status).toBe(
      "rejected",
    );
    expect(await findMail(mail.users.alice, "Drafts", other)).toHaveLength(0);
    expect((await admin("POST", `/tenants/${T}/approvals/${id2}/approve`)).status).toBe(409);
    expect(await findMail(mail.users.bob, "INBOX", other)).toHaveLength(0);

    const all = (await admin("GET", `/tenants/${T}/approvals`)).body.approvals as Json[];
    expect(all.map((a) => a.status)).toEqual(["rejected", "approved"]);
    const reasons = (await admin("GET", `/tenants/${T}/audit`)).body.entries.map(
      (e: Json) => e.reason,
    );
    expect(reasons).toEqual(
      expect.arrayContaining(["awaiting-approval", "approved-by-owner", "rejected-by-owner"]),
    );

    // Back to direct sending.
    const patched = await admin("PATCH", `/tenants/${T}/clients/asker`, { sendMode: "direct" });
    expect(patched.body.sendMode).toBe("direct");

    expect((await admin("DELETE", `/tenants/${T}`)).status).toBe(204);
    expect(existsSync(path.join(dir, `approvals/${T}.json`))).toBe(false);
  });

  it("deleting a tenant purges its secrets, audit, tokens and record, and leaves others intact", async () => {
    expect((await admin("DELETE", `/tenants/${A}`)).status).toBe(204);
    expect((await admin("GET", `/tenants/${A}`)).status).toBe(404);
    expect((await mcp(A, tokenA, "tools/list")).status).toBe(401);
    for (const f of [
      `secrets/${A}.json`,
      `tenants/${A}.json`,
      `audit/${A}.jsonl`,
      `audit/${A}.usage.json`,
    ]) {
      expect(existsSync(path.join(dir, f)), f).toBe(false);
    }
    const leftovers = (await readdir(dir, { recursive: true })).filter((f) =>
      String(f).includes(A),
    );
    expect(leftovers).toEqual([]);
    expect((await call(B, tokenB, "list_accounts")).isError ?? false).toBe(false);
    expect((await admin("DELETE", `/tenants/${A}`)).status).toBe(404);
  });

  it("covers every operation in the OpenAPI spec", () => {
    const missing = operations.filter((o) => !covered.has(o.key)).map((o) => `${o.id} (${o.key})`);
    expect(missing).toEqual([]);
  });
});
