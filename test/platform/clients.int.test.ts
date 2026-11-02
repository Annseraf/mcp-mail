/**
 * Single-tenant client identities, built-in OAuth and policies, end to end
 * against GreenMail (docs/CLIENTS.md). Run with `npm run test:compat`.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountsStore } from "../../src/accounts.js";
import { runCli } from "../../src/cli.js";
import { ClientPool } from "../../src/client-pool.js";
import { createEngine, listen, type Engine } from "../../src/engine.js";
import { accountsFixture, mail, seedMail, toolPayload } from "../compat/harness.js";

const shimDir = path.resolve(import.meta.dirname, "../../compat/fixtures/oauth-shim-v0.1");
const PUBLIC = "https://mail.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const AUTH_TOKEN = randomBytes(16).toString("hex");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let dir: string;
let engine: Engine;
let server: Server;
let url: string;
let fx: Json;
let env: Record<string, string>;

async function cli(...args: string[]): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    expect(await runCli(args)).toBe(0);
  } finally {
    process.env = saved;
    spy.mockRestore();
  }
  return out.join("\n");
}

let id = 1;
async function rpc(
  token: string,
  method: string,
  params: object = {},
): Promise<{ status: number; body: Json; res: Response }> {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, res };
}

const tools = async (token: string) =>
  ((await rpc(token, "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
const call = async (token: string, name: string, args: object = {}) => {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  return r.body.result as { isError?: boolean; content: { type: string; text: string }[] };
};

/** Run the browser part of the OAuth flow and return tokens. */
async function oauthLogin(username: string, password: string) {
  const reg = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(reg.status).toBe(201);
  const client = await reg.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${PUBLIC}/mcp`,
  });
  const page = await (await fetch(`${url}/authorize?${q}`)).text();
  const txn = /name="txn" value="([^"]+)"/.exec(page)![1].replace(/&amp;/g, "&");
  const login = await fetch(`${url}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ txn, username, password }),
  });
  if (login.status !== 302) return { status: login.status } as Json;
  const back = new URL(login.headers.get("location")!);
  expect(back.searchParams.get("state")).toBe("xyz");
  expect(back.searchParams.get("iss")).toBe(`${PUBLIC}/`);
  const tok = await fetch(`${url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    }),
  });
  return { status: 200, client, ...(await tok.json()) };
}

describe("clients, OAuth and policies (single-tenant)", () => {
  beforeAll(async () => {
    await seedMail();
    dir = await mkdtemp(path.join(tmpdir(), "mcp-mail-clients-"));
    fx = JSON.parse(await readFile(path.join(shimDir, "fixture.json"), "utf8"));
    await copyFile(path.join(shimDir, "state.json"), path.join(dir, "state.json"));
    const accountsFile = path.join(dir, "accounts.json");
    await writeFile(accountsFile, JSON.stringify(accountsFixture()));
    env = {
      ACCOUNTS_FILE: accountsFile,
      CLIENTS_FILE: path.join(dir, "clients.json"),
      OAUTH_USERS_FILE: path.join(dir, "oauth-users.json"),
      AUDIT_LOG: path.join(dir, "audit.jsonl"),
    };
    const store = new AccountsStore(accountsFile);
    await store.reload();
    engine = await createEngine({
      version: "test",
      authToken: AUTH_TOKEN,
      publicUrl: PUBLIC,
      accountsFile,
      store,
      pool: new ClientPool(store),
      platform: {
        multiTenant: false,
        dataDir: dir,
        tenantBaseUrl: PUBLIC,
        configProvider: "store",
        configCacheTtlMs: 0,
        keyProvider: "local",
        keyFile: "",
        adminApi: false,
        adminHost: "127.0.0.1",
        adminPort: 0,
      },
      auth: {
        clientsFile: env.CLIENTS_FILE,
        auditLog: env.AUDIT_LOG,
        oauth: {
          tokenSecretHex: fx.tokenSecretHex,
          stateFile: path.join(dir, "state.json"),
          loginUser: fx.loginUser,
          loginPasswordHash: fx.loginPasswordHash,
          usersFile: env.OAUTH_USERS_FILE,
          allowedRedirectUris: [REDIRECT],
        },
      },
      log: () => {},
    });
    server = await listen(engine.app, 0, "127.0.0.1");
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 60_000);

  afterAll(async () => {
    server?.close();
    await engine?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  describe("OAuth shim continuity (no reconnect)", () => {
    it("accepts access tokens the shim issued", async () => {
      const r = await rpc(fx.accessTokenValid, "tools/list");
      expect(r.status).toBe(200);
      expect(r.body.result.tools.map((t: { name: string }) => t.name)).toContain("send_message");
    });

    it("rejects expired tokens and tokens for unregistered clients, with a discovery challenge", async () => {
      for (const t of [fx.accessTokenExpired, fx.accessTokenUnknownClient, "garbage"]) {
        const r = await rpc(t, "tools/list");
        expect(r.status).toBe(401);
        expect(r.res.headers.get("www-authenticate")).toContain("resource_metadata=");
      }
    });

    it("exchanges a refresh token from the shim's state.json and rotates it", async () => {
      const exchange = () =>
        fetch(`${url}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: fx.clientId,
            refresh_token: fx.refreshToken,
          }),
        });
      const first = await exchange();
      expect(first.status).toBe(200);
      const tokens = await first.json();
      expect((await rpc(tokens.access_token, "tools/list")).status).toBe(200);
      expect((await exchange()).status).toBe(400); // rotated: old refresh token is gone
      const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
      expect(Object.keys(state.clients)).toContain(fx.clientId);
    });

    it("serves the same discovery documents", async () => {
      const as = await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json();
      expect(as).toMatchObject({
        issuer: `${PUBLIC}/`,
        code_challenge_methods_supported: ["S256"],
      });
      expect(as.registration_endpoint).toBe(`${PUBLIC}/register`);
      for (const p of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ]) {
        expect(await (await fetch(url + p)).json()).toMatchObject({ resource: `${PUBLIC}/mcp` });
      }
    });

    it("runs the full login flow with LOGIN_USER / LOGIN_PASSWORD_HASH", async () => {
      expect((await oauthLogin(fx.loginUser, "wrong password")).status).toBe(401);
      const t = await oauthLogin(fx.loginUser, fx.loginPassword);
      expect(t.access_token).toBeTypeOf("string");
      expect((await rpc(t.access_token, "tools/list")).status).toBe(200);
    });

    it("rejects registrations with unknown redirect URIs", async () => {
      const r = await fetch(`${url}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
      });
      expect(r.status).toBe(400);
    });
  });

  describe("clients.json policies", () => {
    let drafter = "";
    let organizer = "";

    it("adds clients from the CLI with per-type defaults", async () => {
      drafter = /Token \(shown once\): (\S+)/.exec(
        await cli("clients", "add", "drafter", "--for", "cursor"),
      )![1];
      organizer = /Token \(shown once\): (\S+)/.exec(
        await cli("clients", "add", "organizer", "--for", "generic", "--preset", "organize"),
      )![1];
      const list = await cli("clients", "list");
      expect(list).toContain("drafter\ttoken\tread-draft");
      expect(list).toContain("organizer\ttoken\torganize");
      const file = await readFile(env.CLIENTS_FILE, "utf8");
      expect(file).not.toContain(drafter);
    });

    it("a read-draft client can't see or call send, delete, move or mark tools", async () => {
      const names = await tools(drafter);
      expect(names).toContain("create_draft");
      for (const hidden of ["send_message", "delete_message", "move_message", "mark_read"])
        expect(names).not.toContain(hidden);
      const r = await rpc(drafter, "tools/call", {
        name: "send_message",
        arguments: { to: mail.users.bob.email, subject: "x", text: "y" },
      });
      expect(r.body.error ?? r.body.result?.isError).toBeTruthy();
    });

    it("moves to Trash by default; permanent delete needs the destructive capability", async () => {
      const inbox = toolPayload(
        await call(organizer, "list_messages", { mailbox: "INBOX" }),
      ) as Json;
      const uid = inbox.messages.find((m: Json) => m.subject === "Lunch on Friday?").uid;
      const denied = await call(organizer, "delete_message", {
        mailbox: "INBOX",
        uid,
        permanent: true,
      });
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toContain("Permanent deletion is not allowed");
      const moved = toolPayload(
        await call(organizer, "delete_message", { mailbox: "INBOX", uid }),
      ) as Json;
      expect(moved).toMatchObject({ success: true, permanent: false, moved_to: "Trash" });
      const trash = toolPayload(
        await call(organizer, "list_messages", { mailbox: "Trash" }),
      ) as Json;
      expect(trash.messages.map((m: Json) => m.subject)).toContain("Lunch on Friday?");
      const again = await call(AUTH_TOKEN, "delete_message", {
        mailbox: "Trash",
        uid: trash.messages[0].uid,
      });
      expect(again.content[0].text).toContain("already in Trash");
    });

    it("keeps the shared AUTH_TOKEN at full access", async () => {
      expect(await tools(AUTH_TOKEN)).toContain("send_message");
    });

    it("gives unmatched OAuth logins the default policy", async () => {
      expect(await tools(fx.accessTokenValid)).not.toContain("send_message");
    });

    it("enforces recipient allowlists and send rate limits", async () => {
      const doc = JSON.parse(await readFile(env.CLIENTS_FILE, "utf8"));
      const { token, hash } = await import("../../src/platform/tokens.js").then((m) =>
        m.newClientToken(),
      );
      doc.clients.push({
        id: "sender",
        preset: "full-no-delete",
        match: { tokenHash: hash },
        sendRecipientAllowlist: ["@example.com"],
        sendRateLimit: { perHour: 1 },
      });
      await writeFile(env.CLIENTS_FILE, JSON.stringify(doc));
      const send = (to: string) =>
        call(token, "send_message", { to, subject: "Policy", text: "hi" });
      expect((await send("someone@other.org")).content[0].text).toContain("not allowed");
      expect((await send(mail.users.bob.email)).isError ?? false).toBe(false);
      expect((await send(mail.users.bob.email)).content[0].text).toContain("Send limit reached");
    });

    it("revokes one client without affecting others", async () => {
      await cli("clients", "revoke", "drafter");
      expect((await rpc(drafter, "tools/list")).status).toBe(401);
      expect((await rpc(organizer, "tools/list")).status).toBe(200);
      expect((await rpc(AUTH_TOKEN, "tools/list")).status).toBe(200);
    });

    it("rotates a token client", async () => {
      const fresh = /\(shown once\): (\S+)/.exec(await cli("clients", "rotate", "organizer"))![1];
      expect((await rpc(organizer, "tools/list")).status).toBe(401);
      expect((await rpc(fresh, "tools/list")).status).toBe(200);
      organizer = fresh;
    });

    it("adds an OAuth client whose login works; rotating signs existing sessions out", async () => {
      const out = await cli(
        "clients",
        "add",
        "claude",
        "--for",
        "claude",
        "--preset",
        "full-no-delete",
      );
      const password = /password (\S+)/.exec(out)![1];
      const t = await oauthLogin("claude", password);
      expect(await tools(t.access_token)).toContain("send_message");
      await new Promise((r) => setTimeout(r, 1100)); // tokens carry second-resolution iat
      await cli("clients", "rotate", "claude");
      expect((await rpc(t.access_token, "tools/list")).status).toBe(401);
      expect((await oauthLogin("claude", password)).status).toBe(401);
    });

    it("audits every call without content", async () => {
      const raw = await readFile(env.AUDIT_LOG, "utf8");
      const entries = raw
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(
        entries.some(
          (e) => e.clientId === "organizer" && e.tool === "delete_message" && e.result === "denied",
        ),
      ).toBe(true);
      expect(
        entries.some((e) => e.clientId === "sender" && e.recipients === 1 && e.result === "ok"),
      ).toBe(true);
      expect(raw).not.toContain("Lunch on Friday");
      expect(raw).not.toContain("Policy");
      const tail = await cli("audit", "tail", "--client", "sender", "-n", "5");
      expect(tail).toContain("send_message");
    });
  });
});
