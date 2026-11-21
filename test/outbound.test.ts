/**
 * Outbound connection guard. Every host here is synthetic and resolved by a stub,
 * and every request goes through a fake transport. The one real socket is a
 * loopback server, used to prove the pinned address is the one dialed.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { CalDavClient } from "../src/caldav-client.js";
import { ImapClient } from "../src/imap-client.js";
import {
  createGuardedFetch,
  isPublicAddress,
  LookupAll,
  OutboundBlockedError,
  PinnedRequest,
  pinDestination,
  pinnedTransport,
  PinnedTransport,
  resolveConnectTarget,
  tenantOutboundPolicy,
} from "../src/outbound.js";
import { SmtpClient, smtpTransportOptions } from "../src/smtp-client.js";
import { loadPlatformSettings } from "../src/platform/settings.js";

/** A resolver that answers from a fixed table; unknown names resolve to nothing. */
function answers(table: Record<string, string[]>): LookupAll {
  return async (host) =>
    (table[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { location } });
const ok = () => new Response("ok", { status: 200 });

function recordingTransport(respond: (req: PinnedRequest) => Response) {
  const seen: PinnedRequest[] = [];
  const transport: PinnedTransport = async (req) => {
    seen.push(req);
    return respond(req);
  };
  return { transport, seen };
}

const publicHosts = answers({
  "dav.example.test": ["8.8.8.8"],
  "other.example.test": ["1.1.1.1"],
  "int.example.test": ["10.0.0.9"],
  "meta.example.test": ["169.254.169.254"],
});

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.255",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.5",
    "::ffff:a9fe:a9fe",
    "64:ff9b::808:808",
    "2002:0a00:0001::1",
    "2001::1",
  ])("refuses %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "100.63.255.255",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2a00:1450:4001::200e",
    "::ffff:8.8.8.8",
  ])("allows %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each(["", "example.com", "010.0.0.1", "1.2.3", "10.0.0.1%eth0", "fe80::1%eth0"])(
    "refuses text that is not a plain address: %j",
    (text) => {
      expect(isPublicAddress(text)).toBe(false);
    },
  );
});

describe("pinDestination", () => {
  it("refuses an IP literal that is not public, without a lookup", async () => {
    const lookup = vi.fn(answers({}));
    await expect(pinDestination("10.0.0.5", { lookup })).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
    await expect(pinDestination("[::1]", { lookup })).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["localhost", "mail.localhost"])("refuses %s without a lookup", async (name) => {
    const lookup = vi.fn(answers({}));
    await expect(pinDestination(name, { lookup })).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a name when any one answer is non-public", async () => {
    const lookup = answers({ "mail.example.test": ["8.8.8.8", "10.0.0.7"] });
    await expect(pinDestination("mail.example.test", { lookup })).rejects.toThrow(
      /non-public address/,
    );
  });

  it("refuses a name that resolves to nothing", async () => {
    await expect(pinDestination("empty.example.test", { lookup: answers({}) })).rejects.toThrow(
      /did not resolve/,
    );
  });

  it("pins the validated address after one lookup", async () => {
    const lookup = vi.fn(answers({ "mail.example.test": ["8.8.8.8"] }));
    const pinned = await pinDestination("mail.example.test", { lookup });
    expect(pinned).toEqual({ hostname: "mail.example.test", address: "8.8.8.8", family: 4 });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not follow a rebind: the connect target stays on the validated address", async () => {
    let calls = 0;
    const lookup: LookupAll = async () => {
      calls += 1;
      return calls === 1
        ? [{ address: "8.8.8.8", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    };
    const target = await resolveConnectTarget("mail.example.test", { lookup });
    expect(target).toEqual({ host: "8.8.8.8", servername: "mail.example.test" });
    // The next connect validates again and is refused, instead of reusing the old pin.
    await expect(resolveConnectTarget("mail.example.test", { lookup })).rejects.toBeInstanceOf(
      OutboundBlockedError,
    );
  });

  it("keeps the configured name as TLS name and leaves an IP literal without one", async () => {
    const lookup = answers({ "mail.example.test": ["8.8.8.8"] });
    expect(await resolveConnectTarget("mail.example.test", undefined)).toEqual({
      host: "mail.example.test",
    });
    expect(await resolveConnectTarget("8.8.8.8", { lookup })).toEqual({ host: "8.8.8.8" });
  });
});

describe("tenantOutboundPolicy", () => {
  it("is on for tenant pools unless ALLOW_PRIVATE_MAIL_HOSTS is set", () => {
    expect(tenantOutboundPolicy({ allowPrivateMailHosts: false })).toBeDefined();
    expect(tenantOutboundPolicy({ allowPrivateMailHosts: true })).toBeUndefined();
  });

  it("reads ALLOW_PRIVATE_MAIL_HOSTS as a flag, off by default", () => {
    expect(loadPlatformSettings({}).allowPrivateMailHosts).toBe(false);
    expect(
      loadPlatformSettings({ MULTI_TENANT: "true", ALLOW_PRIVATE_MAIL_HOSTS: "true" })
        .allowPrivateMailHosts,
    ).toBe(true);
  });
});

describe("mail clients", () => {
  it("IMAP refuses a host that resolves to a private address, before connecting", async () => {
    const imap = new ImapClient(
      { host: "imap.internal.test", port: 993, user: "u", pass: "p", secure: true },
      { outbound: { lookup: answers({ "imap.internal.test": ["192.168.1.20"] }) } },
    );
    await expect(imap.listMailboxes()).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it("SMTP refuses a host that resolves to loopback, for send and for verify", async () => {
    const smtp = new SmtpClient(
      { host: "smtp.internal.test", port: 587, user: "u", pass: "p", secure: false },
      { from: "u@example.test" },
      { outbound: { lookup: answers({ "smtp.internal.test": ["127.0.0.1"] }) } },
    );
    await expect(
      smtp.send({ to: "a@example.test", subject: "s", text: "t" }),
    ).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(smtp.verify()).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it("SMTP pinned options dial the address and keep the configured name for TLS", () => {
    const auth = { host: "smtp.example.test", port: 465, user: "u", pass: "p", secure: true };
    expect(
      smtpTransportOptions(auth, { host: "8.8.8.8", servername: "smtp.example.test" }),
    ).toMatchObject({ host: "8.8.8.8", port: 465, tls: { servername: "smtp.example.test" } });
    expect(smtpTransportOptions(auth, { host: "smtp.example.test" })).not.toHaveProperty("tls");
  });

  it("CalDAV refuses a server that resolves to a private address, and says why", async () => {
    const dav = new CalDavClient(
      { url: "https://dav.internal.test/", user: "u", pass: "p" },
      { outbound: { lookup: answers({ "dav.internal.test": ["192.168.1.10"] }) } },
    );
    await expect(dav.listCalendars()).rejects.toBeInstanceOf(OutboundBlockedError);
  });
});

describe("guarded fetch redirects", () => {
  it("follows a redirect to a public host, dialing each hop at its validated address", async () => {
    const { transport, seen } = recordingTransport((req) =>
      req.url.hostname === "dav.example.test"
        ? redirect(302, "https://other.example.test/cal/")
        : ok(),
    );
    const fetchFn = createGuardedFetch({ lookup: publicHosts }, { transport });
    const res = await fetchFn("https://dav.example.test/", { method: "PROPFIND" });
    expect(res.status).toBe(200);
    expect(seen.map((r) => [r.url.hostname, r.pinned.address])).toEqual([
      ["dav.example.test", "8.8.8.8"],
      ["other.example.test", "1.1.1.1"],
    ]);
  });

  it("refuses a redirect to a private host without dialing it", async () => {
    const { transport, seen } = recordingTransport(() =>
      redirect(302, "https://int.example.test/"),
    );
    const fetchFn = createGuardedFetch({ lookup: publicHosts }, { transport });
    await expect(fetchFn("https://dav.example.test/")).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(seen).toHaveLength(1);
  });

  it("refuses a redirect to a metadata address literal without dialing it", async () => {
    const { transport, seen } = recordingTransport(() =>
      redirect(307, "http://169.254.169.254/latest/meta-data/"),
    );
    const fetchFn = createGuardedFetch({ lookup: publicHosts }, { transport });
    await expect(fetchFn("https://dav.example.test/")).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(seen).toHaveLength(1);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    const { transport, seen } = recordingTransport(() => redirect(302, "file:///etc/passwd"));
    const fetchFn = createGuardedFetch({ lookup: publicHosts }, { transport });
    await expect(fetchFn("https://dav.example.test/")).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(seen).toHaveLength(1);
  });

  it("drops credentials on a cross-origin hop and keeps them on the same origin", async () => {
    const { transport, seen } = recordingTransport((req) => {
      if (req.url.pathname === "/start") return redirect(302, "/cal/");
      if (req.url.pathname === "/cal/") return redirect(302, "https://other.example.test/x");
      return ok();
    });
    const fetchFn = createGuardedFetch({ lookup: publicHosts }, { transport });
    await fetchFn("https://dav.example.test/start", {
      method: "PROPFIND",
      headers: { Authorization: "Basic abc", Cookie: "session=1", "X-Keep": "yes" },
    });
    expect(seen[1].headers.authorization).toBe("Basic abc");
    expect(seen[2].headers.authorization).toBeUndefined();
    expect(seen[2].headers.cookie).toBeUndefined();
    expect(seen[2].headers["x-keep"]).toBe("yes");
  });

  it("stops after 5 redirects", async () => {
    const { transport, seen } = recordingTransport(() =>
      redirect(302, "https://dav.example.test/loop"),
    );
    const fetchFn = createGuardedFetch({ lookup: publicHosts }, { transport });
    await expect(fetchFn("https://dav.example.test/")).rejects.toThrow(/too many redirects/);
    expect(seen).toHaveLength(6);
  });

  it("303 turns a POST into a GET without a body", async () => {
    const { transport, seen } = recordingTransport((req) =>
      req.url.pathname === "/a" ? redirect(303, "/b") : ok(),
    );
    const fetchFn = createGuardedFetch({ lookup: publicHosts }, { transport });
    await fetchFn("https://dav.example.test/a", {
      method: "POST",
      body: "<x/>",
      headers: { "Content-Type": "application/xml" },
    });
    expect(seen[1].method).toBe("GET");
    expect(seen[1].body).toBeUndefined();
    expect(seen[1].headers["content-type"]).toBeUndefined();
  });

  it("307 keeps the method and the body", async () => {
    const { transport, seen } = recordingTransport((req) =>
      req.url.pathname === "/a" ? redirect(307, "/b") : ok(),
    );
    const fetchFn = createGuardedFetch({ lookup: publicHosts }, { transport });
    await fetchFn("https://dav.example.test/a", { method: "REPORT", body: "<x/>" });
    expect(seen[1].method).toBe("REPORT");
    expect(seen[1].body?.toString("utf8")).toBe("<x/>");
  });

  it("returns a redirect untouched when asked not to follow, without dialing the target", async () => {
    const { transport, seen } = recordingTransport(() =>
      redirect(302, "https://int.example.test/"),
    );
    const fetchFn = createGuardedFetch({ lookup: publicHosts }, { transport });
    const res = await fetchFn("https://dav.example.test/", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
  });

  it("keeps manually discovered CalDAV destinations within the configured origin", async () => {
    const origin = "https://dav.example.test";
    const other = "https://other.example.test/calendar";
    const { transport, seen } = recordingTransport(() => redirect(302, other));
    const fetchFn = createGuardedFetch(
      { lookup: publicHosts },
      { transport, allowedOrigin: origin },
    );
    const headers = { Authorization: "Basic fixture" };

    await expect(fetchFn(origin, { headers })).rejects.toThrow(/configured origin/);
    const manual = await fetchFn(origin, { headers, redirect: "manual" });
    expect(manual.headers.get("location")).toBe(other);
    await expect(fetchFn(other, { headers })).rejects.toThrow(/configured origin/);
    expect(seen.map((request) => request.url.origin)).toEqual([origin, origin]);
  });

  it("reports each refusal to onRefusal before rethrowing it", async () => {
    const { transport } = recordingTransport(() => redirect(302, "https://int.example.test/"));
    const onRefusal = vi.fn();
    const fetchFn = createGuardedFetch({ lookup: publicHosts }, { transport, onRefusal });
    await expect(fetchFn("https://dav.example.test/")).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(onRefusal).toHaveBeenCalledTimes(1);
  });
});

describe("pinned transport", () => {
  it("dials the pinned address while keeping the configured name for Host", async () => {
    // .invalid never resolves, so a 200 proves the socket used the pinned address.
    const server = createServer((req, res) => res.end(`host=${req.headers.host}`));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await pinnedTransport({
        url: new URL(`http://pinned.invalid:${port}/x`),
        method: "GET",
        headers: {},
        pinned: { hostname: "pinned.invalid", address: "127.0.0.1", family: 4 },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`host=pinned.invalid:${port}`);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
