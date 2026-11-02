import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OciKmsKeyProvider, signOciRequest } from "../../src/platform/oci-kms.js";
import { EnvelopeFileSecretStore, LocalKeyFileProvider } from "../../src/platform/secrets.js";
import { isPrivateHost, loadPlatformSettings } from "../../src/platform/settings.js";
import { HttpConfigProvider, type TenantRecord } from "../../src/platform/tenants.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mcp-mail-unit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("EnvelopeFileSecretStore", () => {
  const store = (key = randomBytes(32)) =>
    new EnvelopeFileSecretStore(dir, LocalKeyFileProvider.fromKey(key));

  it("round-trips secrets and never stores plaintext", async () => {
    const s = store();
    await s.put("tenant-a", "mailbox:main:imap", "hunter2-very-secret");
    expect(await s.get("tenant-a", "mailbox:main:imap")).toBe("hunter2-very-secret");
    expect(await s.has("tenant-a", "mailbox:main:imap")).toBe(true);
    const raw = await readFile(path.join(dir, "tenant-a.json"), "utf8");
    expect(raw).not.toContain("hunter2");
    if (process.platform !== "win32")
      expect((await stat(path.join(dir, "tenant-a.json"))).mode & 0o077).toBe(0);
  });

  it("cannot decrypt with a different key-encryption key", async () => {
    await store().put("tenant-a", "x", "secret");
    await expect(store().get("tenant-a", "x")).rejects.toThrow();
  });

  it("binds ciphertext to its tenant and name", async () => {
    const key = randomBytes(32);
    const s = store(key);
    await s.put("tenant-a", "one", "secret-1");
    const file = path.join(dir, "tenant-a.json");
    const doc = JSON.parse(await readFile(file, "utf8"));
    doc.entries.two = doc.entries.one; // move ciphertext to another name
    await writeFile(file, JSON.stringify(doc));
    await expect(store(key).get("tenant-a", "two")).rejects.toThrow();
  });

  it("keeps every entry under concurrent writes", async () => {
    const s = store();
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.put("tenant-a", `k${i}`, `v${i}`)));
    for (let i = 0; i < 20; i++) expect(await s.get("tenant-a", `k${i}`)).toBe(`v${i}`);
  });

  it("purges a tenant and rejects path traversal", async () => {
    const s = store();
    await s.put("tenant-a", "x", "1");
    await s.purgeTenant("tenant-a");
    expect(await s.get("tenant-a", "x")).toBeUndefined();
    await expect(s.put("../evil", "x", "1")).rejects.toThrow(/Invalid tenant id/);
    await expect(s.put("tenant-a", "../x", "1")).rejects.toThrow(/Invalid secret name/);
  });

  it("refuses a key file readable by others", async () => {
    const file = path.join(dir, "kek");
    await LocalKeyFileProvider.generate(file);
    await expect(LocalKeyFileProvider.load(file)).resolves.toBeDefined();
    if (process.platform !== "win32") {
      const { chmod } = await import("node:fs/promises");
      await chmod(file, 0o644);
      await expect(LocalKeyFileProvider.load(file)).rejects.toThrow(/chmod 600/);
    }
  });
});

describe("OCI KMS key provider", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  it("signs requests the way OCI verifies them", () => {
    const url = new URL("https://kms.example.com/20180608/encrypt");
    const h = signOciRequest("POST", url, '{"a":1}', "t/u/f", privateKey);
    const sig = /signature="([^"]+)"/.exec(h.authorization)![1];
    const signing = [
      `date: ${h.date}`,
      "(request-target): post /20180608/encrypt",
      `host: ${h.host}`,
      `content-length: ${h["content-length"]}`,
      `content-type: ${h["content-type"]}`,
      `x-content-sha256: ${h["x-content-sha256"]}`,
    ].join("\n");
    expect(verify("sha256", Buffer.from(signing), publicKey, Buffer.from(sig, "base64"))).toBe(
      true,
    );
    expect(h.authorization).toContain('keyId="t/u/f"');
  });

  it("wraps and unwraps through the encrypt/decrypt endpoints", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: URL, init: RequestInit) => {
      const url = String(input);
      calls.push(url);
      expect((init.headers as Record<string, string>).authorization).toMatch(/^Signature /);
      const body = JSON.parse(String(init.body));
      // A toy "KMS": reverses the base64 string so wrap != plaintext.
      const out = url.endsWith("/encrypt")
        ? { ciphertext: [...body.plaintext].reverse().join("") }
        : { plaintext: [...body.ciphertext].reverse().join("") };
      return new Response(JSON.stringify(out), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OciKmsKeyProvider({
      cryptoEndpoint: "https://kms.example.com",
      keyId: "ocid1.key.oc1..x",
      tenancyOcid: "t",
      userOcid: "u",
      fingerprint: "f",
      privateKey,
      fetchImpl: fakeFetch,
    });
    const dek = randomBytes(32);
    const wrapped = await p.wrap(dek, "tenant:a");
    expect(wrapped).not.toBe(dek.toString("base64"));
    expect((await p.unwrap(wrapped, "tenant:a")).equals(dek)).toBe(true);
    expect(calls.map((c) => c.split("/").pop())).toEqual(["encrypt", "decrypt"]);
  });
});

describe("HttpConfigProvider", () => {
  const tenant = { id: "tenant-a", revision: 1 } as TenantRecord;

  it("caches within the TTL, refetches after invalidate, and validates ids", async () => {
    let hits = 0;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      hits++;
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer svc");
      if (url.endsWith("/tenants/missing")) return new Response("", { status: 404 });
      if (url.endsWith("/tenants/other-one")) return new Response(JSON.stringify(tenant));
      return new Response(JSON.stringify(tenant));
    }) as unknown as typeof fetch;
    const p = new HttpConfigProvider("https://cfg.internal/", "svc", 60_000, fakeFetch);
    expect((await p.getTenant("tenant-a"))?.id).toBe("tenant-a");
    await p.getTenant("tenant-a");
    expect(hits).toBe(1);
    p.invalidate("tenant-a");
    await p.getTenant("tenant-a");
    expect(hits).toBe(2);
    expect(await p.getTenant("missing")).toBeUndefined();
    expect(await p.getTenant("../etc")).toBeUndefined();
    await expect(p.getTenant("other-one")).rejects.toThrow(/different tenant/);
  });
});

describe("platform settings", () => {
  const token = "x".repeat(40);

  it("is fully off by default", () => {
    const s = loadPlatformSettings({});
    expect(s.multiTenant).toBe(false);
    expect(s.adminApi).toBe(false);
  });

  it("refuses a public admin interface, a short token, or admin without multi-tenant", () => {
    expect(() =>
      loadPlatformSettings({
        MULTI_TENANT: "true",
        ADMIN_API: "true",
        ADMIN_TOKEN: token,
        ADMIN_HOST: "0.0.0.0",
      }),
    ).toThrow(/never be public/);
    expect(() =>
      loadPlatformSettings({ MULTI_TENANT: "true", ADMIN_API: "true", ADMIN_TOKEN: "short" }),
    ).toThrow(/at least 32/);
    expect(() => loadPlatformSettings({ ADMIN_API: "true", ADMIN_TOKEN: token })).toThrow(
      /requires MULTI_TENANT/,
    );
    expect(
      loadPlatformSettings({ MULTI_TENANT: "true", ADMIN_API: "true", ADMIN_TOKEN: token })
        .adminHost,
    ).toBe("127.0.0.1");
  });

  it("classifies private hosts", () => {
    for (const h of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "100.101.253.75",
      "::1",
      "fd7a::1",
      "localhost",
    ]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["0.0.0.0", "8.8.8.8", "172.32.0.1", "::", "example.com"])
      expect(isPrivateHost(h), h).toBe(false);
  });
});
