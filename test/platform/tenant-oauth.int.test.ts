/**
 * OAuth for tenant endpoints with delegated login (TENANT_OAUTH), end to end.
 * The test plays the product: it receives the delegated login redirect and
 * signs the callback.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountsStore } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { createEngine, listen, type Engine } from "../../src/engine.js";
import { LocalKeyFileProvider } from "../../src/platform/secrets.js";
import { mail, seedMail } from "../compat/harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PUBLIC = "https://connect.example.com";
const DELEGATE = "https://app.example.com/oauth/approve";
const DELEGATE_SECRET = randomBytes(24).toString("hex");
const ADMIN_TOKEN = randomBytes(24).toString("hex");
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

let dir: string;
let engine: Engine;
let servers: Server[] = [];
let app: string;
let adminUrl: string;

const local = (publicUrl: string) => publicUrl.replace(PUBLIC, app);
const sign = (txn: string, outcome: string) =>
  createHmac("sha256", DELEGATE_SECRET).update(`${txn}.${outcome}`).digest("hex");

async function admin(method: string, p: string, body?: unknown): Promise<Json> {
  const res = await fetch(`${adminUrl}/admin/v1${p}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

async function mcp(
  tenant: string,
  token: string | undefined,
  method = "tools/list",
): Promise<Response> {
  return fetch(`${app}/t/${tenant}/mcp`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  });
}

/** Register, authorize, and return the delegated-login redirect plus PKCE verifier. */
async function startLogin(tenant: string) {
  const reg = await fetch(`${app}/t/${tenant}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(reg.status).toBe(201);
  const client = await reg.json();
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "s1",
    resource: `${PUBLIC}/t/${tenant}/mcp`,
  });
  const auth = await fetch(`${app}/t/${tenant}/authorize?${q}`, { redirect: "manual" });
  expect(auth.status).toBe(302);
  return { client, verifier, delegated: new URL(auth.headers.get("location")!) };
}

async function finishLogin(tenant: string, agentClientId: string) {
  const { client, verifier, delegated } = await startLogin(tenant);
  const txn = delegated.searchParams.get("txn")!;
  const cb = new URL(local(delegated.searchParams.get("return_to")!));
  cb.search = new URLSearchParams({
    txn,
    client: agentClientId,
    sig: sign(txn, agentClientId),
  }).toString();
  const back = await fetch(cb, { redirect: "manual" });
  expect(back.status).toBe(302);
  const redirect = new URL(back.headers.get("location")!);
  expect(redirect.searchParams.get("iss")).toBe(`${PUBLIC}/t/${tenant}/`);
  const tok = await fetch(`${app}/t/${tenant}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: redirect.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      resource: `${PUBLIC}/t/${tenant}/mcp`,
    }),
  });
  expect(tok.status).toBe(200);
  return (await tok.json()).access_token as string;
}

describe("tenant OAuth with delegated login", () => {
  beforeAll(async () => {
    await seedMail();
    dir = await mkdtemp(path.join(tmpdir(), "mcp-mail-toauth-"));
    const store = new AccountsStore(path.join(dir, "accounts.json"));
    await store.reload();
    engine = await createEngine({
      version: "test",
      authToken: randomBytes(16).toString("hex"),
      accountsFile: path.join(dir, "accounts.json"),
      store,
      pool: new ClientPool(store),
      platform: {
        multiTenant: true,
        dataDir: dir,
        tenantBaseUrl: PUBLIC,
        configProvider: "store",
        configCacheTtlMs: 0,
        keyProvider: "local",
        keyFile: "",
        adminApi: true,
        adminHost: "127.0.0.1",
        adminPort: 0,
        adminToken: ADMIN_TOKEN,
        tenantOAuth: {
          tokenSecretHex: randomBytes(32).toString("hex"),
          delegateUrl: DELEGATE,
          delegateSecret: DELEGATE_SECRET,
        },
      },
      keyProvider: LocalKeyFileProvider.fromKey(randomBytes(32)),
      log: () => {},
    });
    const a = await listen(engine.app, 0, "127.0.0.1");
    const b = await listen(engine.admin!, 0, "127.0.0.1");
    servers = [a, b];
    app = `http://127.0.0.1:${(a.address() as { port: number }).port}`;
    adminUrl = `http://127.0.0.1:${(b.address() as { port: number }).port}`;
    for (const [tenant, user] of [
      ["tenant-one", mail.users.alice],
      ["tenant-two", mail.users.bob],
    ] as const) {
      await admin("POST", "/tenants", {
        id: tenant,
        limits: { maxMailboxes: 2, maxClients: 5, toolCallsPerDay: 1000 },
      });
      const ep = (port: number) => ({
        host: mail.host,
        port,
        tls: false,
        user: user.email,
        password: user.pass,
      });
      await admin("POST", `/tenants/${tenant}/mailboxes`, {
        id: "main",
        label: "Main",
        imap: ep(mail.imapPort),
        smtp: ep(mail.smtpPort),
        mail: { defaultFrom: user.email },
      });
      await admin("POST", `/tenants/${tenant}/clients`, {
        id: "chatgpt",
        name: "ChatGPT",
        type: "chatgpt",
        preset: "read-draft",
      });
    }
  }, 60_000);

  afterAll(async () => {
    for (const s of servers) s.close();
    await engine?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("advertises per-tenant discovery from the 401 challenge", async () => {
    const res = await mcp("tenant-one", undefined);
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate")!;
    const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)![1];
    expect(prmUrl).toBe(`${PUBLIC}/.well-known/oauth-protected-resource/t/tenant-one/mcp`);
    const prm = await (await fetch(local(prmUrl))).json();
    expect(prm).toMatchObject({
      resource: `${PUBLIC}/t/tenant-one/mcp`,
      authorization_servers: [`${PUBLIC}/t/tenant-one/`],
    });
    for (const p of [
      "/.well-known/oauth-authorization-server/t/tenant-one",
      "/t/tenant-one/.well-known/oauth-authorization-server",
    ]) {
      const as = await (await fetch(app + p)).json();
      expect(as).toMatchObject({
        issuer: `${PUBLIC}/t/tenant-one/`,
        authorization_endpoint: `${PUBLIC}/t/tenant-one/authorize`,
        authorization_response_iss_parameter_supported: true,
      });
    }
    expect(
      (await fetch(`${app}/t/tenant-nope/.well-known/oauth-authorization-server`)).status,
    ).toBe(404);
  });

  it("delegates login to the product and issues tenant-bound tokens", async () => {
    const { delegated } = await startLogin("tenant-one");
    expect(delegated.origin + delegated.pathname).toBe(DELEGATE);
    expect(delegated.searchParams.get("tenant")).toBe("tenant-one");
    expect(delegated.searchParams.get("client_name")).toBe("ChatGPT");
    expect(delegated.searchParams.get("return_to")).toBe(`${PUBLIC}/t/tenant-one/oauth/callback`);

    const token = await finishLogin("tenant-one", "chatgpt");
    const ok = await mcp("tenant-one", token);
    expect(ok.status).toBe(200);
    const names = ((await ok.json()).result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("create_draft");
    expect(names).not.toContain("send_message");
    expect((await mcp("tenant-two", token)).status).toBe(401);
  });

  it("rejects forged or refused callbacks and unknown agent clients", async () => {
    const { delegated } = await startLogin("tenant-one");
    const txn = delegated.searchParams.get("txn")!;
    const cb = local(delegated.searchParams.get("return_to")!);
    const forged = await fetch(
      `${cb}?${new URLSearchParams({ txn, client: "chatgpt", sig: "00".repeat(32) })}`,
      { redirect: "manual" },
    );
    expect(forged.status).toBe(400);
    const denied = await fetch(
      `${cb}?${new URLSearchParams({ txn, error: "access_denied", sig: sign(txn, "denied") })}`,
      {
        redirect: "manual",
      },
    );
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe(
      "access_denied",
    );
    const ghost = await finishLogin("tenant-one", "ghost");
    expect((await mcp("tenant-one", ghost)).status).toBe(401);
  });

  it("signs out sessions when the client is rotated or revoked", async () => {
    const token = await finishLogin("tenant-two", "chatgpt");
    expect((await mcp("tenant-two", token)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    await admin("POST", "/tenants/tenant-two/clients/chatgpt/rotate");
    expect((await mcp("tenant-two", token)).status).toBe(401);
    const fresh = await finishLogin("tenant-two", "chatgpt");
    expect((await mcp("tenant-two", fresh)).status).toBe(200);
    await admin("POST", "/tenants/tenant-two/clients/chatgpt/revoke");
    expect((await mcp("tenant-two", fresh)).status).toBe(401);
  });

  it("purges a tenant's OAuth state on delete", async () => {
    expect(existsSync(path.join(dir, "oauth", "tenant-one.json"))).toBe(true);
    await admin("DELETE", "/tenants/tenant-one");
    expect(existsSync(path.join(dir, "oauth", "tenant-one.json"))).toBe(false);
    expect((await fetch(`${app}/t/tenant-one/.well-known/oauth-authorization-server`)).status).toBe(
      404,
    );
  });
});
