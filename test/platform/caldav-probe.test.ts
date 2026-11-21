import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createAdminApp } from "../../src/admin/api.js";
import type { Platform } from "../../src/engine.js";
import type { PinnedTransport } from "../../src/outbound.js";
import { checkResponse } from "./contract.js";

const { transport } = vi.hoisted(() => ({ transport: vi.fn<PinnedTransport>() }));
vi.mock(import("../../src/outbound.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createGuardedFetch: (
      policy: Parameters<typeof actual.createGuardedFetch>[0],
      options: Parameters<typeof actual.createGuardedFetch>[1],
    ) => actual.createGuardedFetch(policy, { ...options, transport }),
  };
});

const token = randomBytes(24).toString("hex");
const tenant = "fixture-tenant";
const path = `/tenants/${tenant}/mailboxes/test-caldav`;
const input = { url: "https://calendar.example.test/", user: "fixture", password: "fake-password" };
const getTenant = vi.fn(async (id: string) => (id === tenant ? { id } : undefined));
const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
const platform = { config: { getTenant } } as unknown as Platform;
const app = createAdminApp({
  token,
  tenantBaseUrl: "https://example.test",
  platform,
  log: () => {},
  outbound: { lookup },
});

let server: ReturnType<typeof app.listen>;
let base: string;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});
beforeEach(() => {
  transport.mockReset();
  lookup.mockClear();
  getTenant.mockClear();
});

async function probe(body: unknown = input, route = path, auth = token) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  checkResponse("POST", route, response.status, result);
  return { status: response.status, result };
}

function property(href: string, value: string) {
  return new Response(
    `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
    <d:response><d:href>${href}</d:href><d:propstat><d:prop>${value}</d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    { status: 207, headers: { "content-type": "application/xml" } },
  );
}

it("performs guarded principal and calendar-home discovery using only submitted credentials", async () => {
  transport.mockImplementation(async ({ url }) => {
    if (url.pathname === "/") {
      return property(
        "/",
        "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>",
      );
    }
    if (url.pathname === "/principal/") {
      return property(
        "/principal/",
        "<c:calendar-home-set><d:href>/calendars/</d:href></c:calendar-home-set>",
      );
    }
    return new Response(null, { status: 404 });
  });
  expect(await probe()).toEqual({ status: 200, result: { ok: true } });
  const requests = transport.mock.calls.map(([request]) => request);
  expect(requests.map(({ url }) => url.pathname)).toEqual([
    "/.well-known/caldav",
    "/.well-known/caldav",
    "/",
    "/principal/",
  ]);
  for (const request of requests) {
    expect(request.pinned.address).toBe("8.8.8.8");
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from("fixture:fake-password").toString("base64")}`,
    );
  }
});

it("rejects unsafe destinations and hides upstream error details", async () => {
  expect(await probe({ ...input, url: "https://127.0.0.1/" })).toEqual({
    status: 200,
    result: { ok: false, error: "CalDAV destination blocked. Use the canonical public HTTPS URL." },
  });
  expect(transport).not.toHaveBeenCalled();

  transport.mockRejectedValue(new Error(`provider returned ${input.password}`));
  expect(await probe()).toEqual({
    status: 200,
    result: {
      ok: false,
      error: "Could not verify CalDAV discovery. Check the URL and credentials.",
    },
  });
});

it("keeps discovery requests on the configured origin", async () => {
  transport.mockImplementation(async ({ url }) =>
    url.pathname === "/.well-known/caldav"
      ? new Response(null, { status: 302, headers: { location: "https://other.example.test/" } })
      : new Response(null, { status: 404 }),
  );
  expect(await probe()).toEqual({
    status: 200,
    result: { ok: false, error: "CalDAV destination blocked. Use the canonical public HTTPS URL." },
  });
  expect(
    transport.mock.calls.every(([req]) => req.url.origin === "https://calendar.example.test"),
  ).toBe(true);
});

it("checks authorization, tenant existence and input before dialing", async () => {
  expect((await probe(input, path, "invalid-token")).status).toBe(401);
  expect(getTenant).not.toHaveBeenCalled();
  expect((await probe(input, path.replace(tenant, "missing-tenant"))).status).toBe(404);
  for (const url of [
    "garbage",
    "http://calendar.example.test",
    "https://user:secret@calendar.example.test",
  ]) {
    const response = await probe({ ...input, url });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.result)).not.toContain("user:secret");
  }
  expect(lookup).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
