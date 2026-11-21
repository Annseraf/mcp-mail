import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AccountsStore } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { createEngine, listen, type Engine } from "../../src/engine.js";
import { LocalKeyFileProvider } from "../../src/platform/secrets.js";
import { checkResponse } from "./contract.js";

it("defaults hosted calendar flags off and validates independent admin updates", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-calendar-admin-"));
  const adminToken = randomBytes(24).toString("hex");
  const accountsFile = path.join(dir, "accounts.json");
  const store = new AccountsStore(accountsFile);
  const host = "127.0.0.1";
  const tenantId = "calendar-test";
  const clients = `/tenants/${tenantId}/clients`;
  const client = `${clients}/synthetic`;
  const off = { calendarReadEnabled: false, calendarWriteEnabled: false };
  let engine: Engine | undefined;
  let server: Server | undefined;
  try {
    await store.reload();
    engine = await createEngine({
      version: "test",
      authToken: randomBytes(24).toString("hex"),
      accountsFile,
      store,
      pool: new ClientPool(store),
      platform: {
        multiTenant: true,
        dataDir: dir,
        tenantBaseUrl: "https://calendar.example.test",
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
    server = await listen(engine.admin!, 0, host);
    const { port } = server.address() as AddressInfo;

    async function api(method: string, route: string, status: number, body?: unknown) {
      const response = await fetch(`http://${host}:${port}/admin/v1${route}`, {
        method,
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status).toBe(status);
      const result: unknown = await response.json();
      if (response.ok) checkResponse(method, route, status, result);
      return result;
    }

    await api("POST", "/tenants", 201, { id: tenantId });
    const input = { id: "synthetic", name: "Synthetic", preset: "full" };
    await api("POST", clients, 400, { ...input, calendarReadEnabled: "true" });
    expect(await api("POST", clients, 201, input)).toMatchObject({ client: off });
    expect(await api("PATCH", client, 200, { calendarReadEnabled: true })).toMatchObject({
      ...off,
      calendarReadEnabled: true,
    });
    const on = { calendarReadEnabled: true, calendarWriteEnabled: true };
    expect(await api("PATCH", client, 200, { calendarWriteEnabled: true })).toMatchObject(on);
    expect(await api("PATCH", client, 200, { name: "Renamed" })).toMatchObject(on);
    await api("PATCH", client, 400, { calendarReadEnabled: false, calendarWriteEnabled: null });
    expect(await api("GET", clients, 200)).toMatchObject({ clients: [{ id: "synthetic", ...on }] });

    // Recreate a legacy stored client by removing both keys from the temporary tenant store.
    await engine.platform!.tenants!.update(tenantId, (tenant) => {
      const stored = tenant.clients[0];
      delete stored.calendarReadEnabled;
      delete stored.calendarWriteEnabled;
    });
    engine.platform!.config.invalidate(tenantId);
    expect(await api("GET", clients, 200)).toMatchObject({
      clients: [{ id: "synthetic", ...off }],
    });
  } finally {
    server?.close();
    try {
      await engine?.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
