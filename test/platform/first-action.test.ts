import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AccountsStore } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { createEngine, listen } from "../../src/engine.js";
import { LocalKeyFileProvider } from "../../src/platform/secrets.js";
import { DEFAULT_LIMITS, FileTenantStore, type TenantRecord } from "../../src/platform/tenants.js";
import { checkResponse } from "./contract.js";

it("records only successful authenticated tenant tools and serves private coverage metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-first-action-"));
  const adminToken = randomBytes(24).toString("hex");
  const accountsFile = path.join(dir, "accounts.json");
  const store = new AccountsStore(accountsFile);
  await store.reload();
  const host = "127.0.0.1";
  const engine = await createEngine({
    version: "test",
    authToken: randomBytes(24).toString("hex"),
    accountsFile,
    store,
    pool: new ClientPool(store),
    platform: {
      multiTenant: true,
      dataDir: dir,
      tenantBaseUrl: "https://action.example.test",
      configProvider: "store",
      configCacheTtlMs: 0,
      keyProvider: "local",
      keyFile: "",
      adminApi: true,
      adminHost: host,
      adminPort: 0,
      adminToken,
    },
    keyProvider: LocalKeyFileProvider.fromKey(randomBytes(32)),
    log: () => {},
  });
  const adminServer = await listen(engine.admin!, 0, host);
  const mcpServer = await listen(engine.app, 0, host);
  const origin = (address: AddressInfo) => `http://${host}:${address.port}`;
  const adminOrigin = origin(adminServer.address() as AddressInfo);
  const mcpOrigin = origin(mcpServer.address() as AddressInfo);
  const a = "tenant-action-a";
  const b = "tenant-action-b";
  const firstPath = (id: string) => `/tenants/${id}/first-action`;
  async function admin(
    method: string,
    route: string,
    status: number,
    data?: unknown,
    token = adminToken,
  ) {
    const response = await fetch(`${adminOrigin}/admin/v1${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    expect(response.status).toBe(status);
    if (status === 204) return;
    const result = await response.json();
    checkResponse(method, route, status, result);
    return result;
  }

  const protocol = "2026-07-28";
  async function mcp(id: string, token: string, method: string, name?: string) {
    return fetch(`${mcpOrigin}/t/${id}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocol,
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...(name ? { name, arguments: {} } : {}),
          _meta: {
            "io.modelcontextprotocol/protocolVersion": protocol,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  }

  try {
    await admin("POST", "/tenants", 201, { id: a });
    await admin("POST", "/tenants", 201, { id: b });
    const { token } = await admin("POST", `/tenants/${a}/clients`, 201, {
      id: "synthetic",
      name: "Synthetic",
      preset: "read-only",
    });
    await admin("GET", firstPath(a), 401, undefined, token);
    const empty = await admin("GET", firstPath(a), 200);
    expect(empty).toEqual({
      tenantId: a,
      coverageStartedAt: expect.any(String),
      firstSuccessfulActionAt: null,
    });

    expect((await mcp(b, token, "tools/call", "list_accounts")).status).toBe(401);
    expect((await mcp(a, token, "tools/list")).status).toBe(200);
    const failed = await mcp(a, token, "tools/call", "list_folders");
    expect((await failed.json()).result.isError).toBe(true);
    await admin("POST", `/tenants/${a}/suspend`, 200);
    const denied = await mcp(a, token, "tools/call", "list_accounts");
    expect((await denied.json()).result.isError).toBe(true);
    expect(await admin("GET", firstPath(a), 200)).toEqual(empty);
    await admin("POST", `/tenants/${a}/unsuspend`, 200);
    for (const response of await Promise.all([
      mcp(a, token, "tools/call", "list_accounts"),
      mcp(a, token, "tools/call", "list_accounts"),
    ])) {
      expect(response.status).toBe(200);
      expect((await response.json()).result.isError).not.toBe(true);
    }
    const measured = await admin("GET", firstPath(a), 200);
    expect(measured).toEqual({ ...empty, firstSuccessfulActionAt: expect.any(String) });
    expect((await admin("GET", firstPath(b), 200)).firstSuccessfulActionAt).toBeNull();
    expect((await engine.platform!.audit.query(a)).entries.length).toBeGreaterThan(0);
    await engine.platform!.audit.applyRetention(a, 0);
    expect((await engine.platform!.audit.query(a)).entries).toEqual([]);
    expect(await admin("GET", firstPath(a), 200)).toEqual(measured);
    const tenantDir = path.join(dir, "tenants");
    const metadata = path.join(tenantDir, `${a}.json`);
    const original = await readFile(metadata, "utf8");
    const { ino } = await stat(metadata);
    try {
      if (process.getuid?.() !== 0) await chmod(tenantDir, 0o500);
      const later = await mcp(a, token, "tools/call", "list_accounts");
      expect(later.status).toBe(200);
      expect((await later.json()).result.isError).not.toBe(true);
      expect(await admin("GET", firstPath(a), 200)).toEqual(measured);
      expect(await readFile(metadata, "utf8")).toBe(original);
      expect((await stat(metadata)).ino).toBe(ino);
    } finally {
      await chmod(tenantDir, 0o700);
    }
    const reopened = new FileTenantStore(tenantDir);
    expect(reopened.firstActionView((await reopened.get(a))!)).toEqual(measured);
    await admin("DELETE", `/tenants/${a}`, 204);
    await admin("GET", firstPath(a), 404);
    expect(await reopened.get(a)).toBeUndefined();
  } finally {
    adminServer.close();
    mcpServer.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("retains the earliest completion in a legacy record and ignores completions after removal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-first-action-store-"));
  try {
    const tenants = new FileTenantStore(dir);
    const tenant: TenantRecord = {
      id: "tenant-legacy",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      status: "active",
      revision: 1,
      clients: [],
      mailboxes: [],
      limits: DEFAULT_LIMITS,
    };
    await writeFile(path.join(dir, `${tenant.id}.json`), JSON.stringify(tenant));
    expect(tenants.firstActionView(tenant).coverageStartedAt).toBeNull();
    const early = "2025-01-02T00:00:01.000Z";
    const late = "2025-01-02T00:00:02.000Z";
    const finishes = await Promise.all(
      Array.from({ length: 3 }, () => tenants.beginFirstAction(tenant)),
    );
    await Promise.all([finishes[0](late), finishes[1](early), finishes[2](late)]);
    const saved = (await tenants.get(tenant.id))!;
    expect(saved).toMatchObject({ revision: 1, updatedAt: tenant.updatedAt });
    expect(tenants.firstActionView(saved)).toEqual({
      tenantId: tenant.id,
      coverageStartedAt: null,
      firstSuccessfulActionAt: early,
    });
    expect(
      JSON.parse(await readFile(path.join(dir, `${tenant.id}.json`), "utf8")).firstAction,
    ).toEqual({
      firstSuccessfulActionAt: early,
    });
    const completionAfterRemoval = await tenants.beginFirstAction(tenant);
    const completionAfterReplacement = await tenants.beginFirstAction(tenant);
    await tenants.delete(tenant.id);
    await completionAfterRemoval(late);
    expect(await tenants.get(tenant.id)).toBeUndefined();
    await tenants.create({ ...tenant, createdAt: late });
    await completionAfterReplacement(late);
    expect((await tenants.get(tenant.id))!.firstAction).toEqual({
      coverageSince: late,
      pending: 0,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.getuid?.() === 0)(
  "reopens with unknown coverage after a failed settlement and preserves unrelated coverage",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcp-first-action-gap-"));
    const tenants = new FileTenantStore(dir);
    const createdAt = "2025-01-01T00:00:00.000Z";
    const early = "2025-01-02T00:00:01.000Z";
    const late = "2025-01-02T00:00:02.000Z";
    const tenant: TenantRecord = {
      id: "tenant-gap",
      createdAt,
      updatedAt: createdAt,
      status: "active",
      revision: 1,
      clients: [],
      mailboxes: [],
      limits: DEFAULT_LIMITS,
    };
    const other = { ...tenant, id: "tenant-clean" };
    try {
      await tenants.create(tenant);
      await tenants.create(other);
      const [finishEarly, finishLate] = await Promise.all([
        tenants.beginFirstAction(other),
        tenants.beginFirstAction(other),
      ]);
      await finishLate(late);
      expect(tenants.firstActionView((await tenants.get(other.id))!).coverageStartedAt).toBeNull();
      await finishEarly(early);
      await finishEarly(late); // A duplicate settle cannot consume another intent.

      const finish = await tenants.beginFirstAction(tenant);
      await chmod(dir, 0o500);
      await expect(finish(early)).rejects.toMatchObject({ code: "EACCES" });
      await expect(tenants.beginFirstAction(tenant)).rejects.toMatchObject({ code: "EACCES" });
      const reopened = new FileTenantStore(dir);
      expect(reopened.firstActionView((await reopened.get(tenant.id))!)).toEqual({
        tenantId: tenant.id,
        coverageStartedAt: null,
        firstSuccessfulActionAt: null,
      });
      expect(reopened.firstActionView((await reopened.get(other.id))!)).toEqual({
        tenantId: other.id,
        coverageStartedAt: createdAt,
        firstSuccessfulActionAt: early,
      });

      await chmod(dir, 0o700);
      const next = await reopened.beginFirstAction(tenant);
      await next(late);
      expect(reopened.firstActionView((await reopened.get(tenant.id))!)).toEqual({
        tenantId: tenant.id,
        coverageStartedAt: null,
        firstSuccessfulActionAt: late,
      });
    } finally {
      await chmod(dir, 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
