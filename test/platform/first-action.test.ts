import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const reopened = new FileTenantStore(path.join(dir, "tenants"));
    expect(reopened.firstActionView((await reopened.get(a))!)).toEqual({
      ...measured,
      coverageStartedAt: null,
    });
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
    await Promise.all([
      tenants.recordFirstAction(tenant, late),
      tenants.recordFirstAction(tenant, early),
      tenants.recordFirstAction(tenant, late),
    ]);
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
    await tenants.delete(tenant.id);
    await tenants.recordFirstAction(tenant, late);
    expect(await tenants.get(tenant.id)).toBeUndefined();
    await tenants.create({ ...tenant, createdAt: late });
    await tenants.recordFirstAction(tenant, late);
    expect((await tenants.get(tenant.id))!.firstAction).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.getuid?.() === 0)(
  "reports unknown coverage on restart immediately after a failed metadata write",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcp-first-action-gap-"));
    const tenants = new FileTenantStore(dir);
    const createdAt = "2025-01-01T00:00:00.000Z";
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
    try {
      await tenants.create(tenant);
      // Simulate an on-disk record written by the previous revision, which
      // incorrectly treated this historical field as durable coverage proof.
      await writeFile(
        path.join(dir, `${tenant.id}.json`),
        JSON.stringify({
          ...tenant,
          firstAction: { coverageStartedAt: createdAt },
        }),
      );
      expect(tenants.firstActionView((await tenants.get(tenant.id))!).coverageStartedAt).toBe(
        createdAt,
      );
      await chmod(dir, 0o500);
      const failedAt = "2025-01-02T00:00:00.000Z";
      await expect(tenants.recordFirstAction(tenant, failedAt)).rejects.toMatchObject({
        code: "EACCES",
      });
      expect(tenants.firstActionView((await tenants.get(tenant.id))!)).toEqual({
        tenantId: tenant.id,
        coverageStartedAt: null,
        firstSuccessfulActionAt: null,
      });
      await chmod(dir, 0o700);
      const next = "2025-01-03T00:00:00.000Z";
      const reopened = new FileTenantStore(dir);
      expect(reopened.firstActionView((await reopened.get(tenant.id))!)).toEqual({
        tenantId: tenant.id,
        coverageStartedAt: null,
        firstSuccessfulActionAt: null,
      });
      await reopened.recordFirstAction(tenant, next);
      expect(reopened.firstActionView((await reopened.get(tenant.id))!)).toEqual({
        tenantId: tenant.id,
        coverageStartedAt: null,
        firstSuccessfulActionAt: next,
      });
    } finally {
      await chmod(dir, 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
