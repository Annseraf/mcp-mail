/**
 * Outbound connection guard for mail and CalDAV hosts that a tenant supplies.
 *
 * A hosted (multi-tenant) deployment dials whatever IMAP, SMTP or CalDAV host a
 * tenant configures. Without a guard that name could point at loopback, a LAN
 * service or a cloud metadata address. This module refuses any host whose DNS
 * answers include a non-public address, and pins the one validated address into
 * the connection so a later DNS answer cannot move it (DNS rebinding). The TLS
 * name stays the configured host, so certificates are still checked against it.
 *
 * Nothing here runs unless a policy is passed in. The self-hosted server does
 * not pass one.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export interface LookupAddress {
  address: string;
  family: number;
}

/** Every address a name maps to, like dns.lookup with `all: true`. */
export type LookupAll = (host: string) => Promise<LookupAddress[]>;

/** Passing a policy turns the guard on for the clients built with it. */
export interface OutboundPolicy {
  lookup: LookupAll;
}

export const systemLookup: LookupAll = (host) => dnsLookup(host, { all: true, verbatim: true });

/** The policy for MULTI_TENANT pools: on unless ALLOW_PRIVATE_MAIL_HOSTS is set. */
export function tenantOutboundPolicy(settings: {
  allowPrivateMailHosts?: boolean;
}): OutboundPolicy | undefined {
  return settings.allowPrivateMailHosts ? undefined : { lookup: systemLookup };
}

export class OutboundBlockedError extends Error {
  readonly code = "OUTBOUND_BLOCKED";

  constructor(message: string) {
    super(message);
    this.name = "OutboundBlockedError";
  }
}

/** Where a connection goes: the address to dial, and the name to verify and send as SNI. */
export interface ConnectTarget {
  host: string;
  servername?: string;
}

/** A validated destination. `hostname` is the name the caller asked for, without IPv6 brackets. */
export interface PinnedDestination {
  hostname: string;
  address: string;
  family: 4 | 6;
}

const NON_PUBLIC_LITERAL = "destination is not a public address";
const NON_PUBLIC_ANSWER = "host resolves to a non-public address";

function parseIPv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    // Leading zeros are refused: some resolvers read them as octal.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return octets;
}

function parseIPv6(input: string): number[] | undefined {
  if (input.includes("%") || !input.includes(":")) return undefined;
  let text = input;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return undefined;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const split = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = split(halves[0]);
  const rest = halves.length === 2 ? split(halves[1]) : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return undefined;
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    const n = parseInt(group, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function isPublicIPv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // "this" network, private, loopback
  if (a === 100 && (b & 0xc0) === 64) return false; // 100.64.0.0/10, carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, including cloud metadata
  if (a === 172 && (b & 0xf0) === 16) return false; // 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a === 198 && (b & 0xfe) === 18) return false; // 198.18.0.0/15, benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // 198.51.100.0/24, documentation
  if (a === 203 && b === 0 && c === 113) return false; // 203.0.113.0/24, documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/**
 * True only for an address that is globally routable unicast. Anything not
 * clearly public (including text that is not an IP address) is refused.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6(address);
  if (!v6) return false;
  const zeroFirst = (count: number) => v6.slice(0, count).every((byte) => byte === 0);
  // ::ffff:a.b.c.d is judged by the IPv4 address it carries.
  if (zeroFirst(10) && v6[10] === 0xff && v6[11] === 0xff) return isPublicIPv4(v6.slice(12));
  // Only 2000::/3 is allocated for global unicast. Unspecified, loopback, ULA,
  // link-local, multicast, NAT64 (64:ff9b::/96) and IPv4-compatible addresses all fall outside it.
  if ((v6[0] & 0xe0) !== 0x20) return false;
  // Inside 2000::/3, refuse ranges that embed another address or are documentation.
  if (v6[0] === 0x20 && v6[1] === 0x02) return false; // 2002::/16, 6to4
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0 && v6[3] === 0) return false; // 2001::/32, Teredo
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8) return false; // 2001:db8::/32
  return true;
}

/**
 * Validate a host before dialing it. An IP literal is checked as is. A name is
 * resolved once; every answer must be public, and the first one becomes the
 * pinned address. Mixed answers are refused outright.
 */
export async function pinDestination(
  hostname: string,
  policy: OutboundPolicy,
): Promise<PinnedDestination> {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare)) {
    if (!isPublicAddress(bare)) throw new OutboundBlockedError(NON_PUBLIC_LITERAL);
    return { hostname: bare, address: bare, family: isIP(bare) === 6 ? 6 : 4 };
  }
  const name = bare.toLowerCase().replace(/\.$/, "");
  if (name === "" || name === "localhost" || name.endsWith(".localhost")) {
    throw new OutboundBlockedError(NON_PUBLIC_ANSWER);
  }
  const answers = await policy.lookup(bare);
  if (answers.length === 0) throw new OutboundBlockedError("host did not resolve to any address");
  for (const answer of answers) {
    if (!isPublicAddress(answer.address)) throw new OutboundBlockedError(NON_PUBLIC_ANSWER);
  }
  const first = answers[0];
  return { hostname: bare, address: first.address, family: isIP(first.address) === 6 ? 6 : 4 };
}

/**
 * Where a client should connect for a configured host. Without a policy this is
 * the host unchanged. With one, it is the validated address, plus the configured
 * name as the TLS server name when that name is not an IP literal.
 */
export async function resolveConnectTarget(
  host: string,
  policy: OutboundPolicy | undefined,
): Promise<ConnectTarget> {
  if (!policy) return { host };
  const pinned = await pinDestination(host, policy);
  return {
    host: pinned.address,
    servername: isIP(pinned.hostname) ? undefined : pinned.hostname,
  };
}

export interface PinnedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  pinned: PinnedDestination;
  signal?: AbortSignal;
}

/** Sends one request to the pinned address. Redirects are never followed here. */
export type PinnedTransport = (request: PinnedRequest) => Promise<Response>;

/**
 * Default transport: node:http(s), with the socket dialed at the pinned address.
 * The hostname still drives SNI, certificate checks and the Host header.
 */
export const pinnedTransport: PinnedTransport = ({ url, method, headers, body, pinned, signal }) =>
  new Promise<Response>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method,
        headers,
        signal,
        agent: false,
        lookup: (_name, options, callback) => {
          if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        },
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const outHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) outHeaders.append(name, v);
        }
        if (NO_BODY_STATUSES.has(status)) {
          res.resume();
          resolve(new Response(null, { status, headers: outHeaders }));
          return;
        }
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream, { status, headers: outHeaders }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });

export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NO_BODY_STATUSES = new Set([204, 205, 304]);
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

function httpUrl(value: string | URL): URL {
  const url = typeof value === "string" ? new URL(value) : value;
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OutboundBlockedError("only http and https destinations are allowed");
  }
  if (url.username || url.password) {
    throw new OutboundBlockedError("destination URL must not contain credentials");
  }
  return url;
}

function bodyBytes(body: RequestInit["body"]): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError("guarded requests accept string or binary bodies only");
}

export interface GuardedFetchOptions {
  transport?: PinnedTransport;
  /** Restrict all requests, including requests initiated by DAV discovery. */
  allowedOrigin?: string;
  /** Told about each refusal before it is rethrown, so a caller that wraps the error can keep the reason. */
  onRefusal?: (error: OutboundBlockedError) => void;
}

/**
 * A fetch for tsdav. Every request, including each redirect hop, is validated
 * and pinned before it is dialed. When the caller asks to follow redirects, this
 * follows them itself, up to MAX_REDIRECTS. Credentials are dropped on a
 * cross-origin hop, as fetch does. With redirect "manual" the 3xx response is
 * returned untouched; the caller's next request goes through this fetch too.
 */
export function createGuardedFetch(
  policy: OutboundPolicy,
  options: GuardedFetchOptions = {},
): typeof fetch {
  const transport = options.transport ?? pinnedTransport;
  const follow = async (input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
    if (input instanceof Request) throw new TypeError("guarded fetch takes a URL, not a Request");
    let url = httpUrl(input);
    let method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let body = bodyBytes(init.body);
    const redirect = init.redirect ?? "follow";
    for (let hops = 0; ; hops++) {
      if (options.allowedOrigin && url.origin !== options.allowedOrigin) {
        throw new OutboundBlockedError("CalDAV destination differs from the configured origin");
      }
      init.signal?.throwIfAborted();
      const pinned = await pinDestination(url.hostname, policy);
      const response = await transport({
        url,
        method,
        headers: Object.fromEntries(headers),
        body,
        pinned,
        signal: init.signal ?? undefined,
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get("location");
      if (location === null || redirect === "manual") return response;
      await response.body?.cancel().catch(() => undefined);
      if (redirect === "error") throw new OutboundBlockedError("redirects are not allowed here");
      if (hops === MAX_REDIRECTS) throw new OutboundBlockedError("too many redirects");
      const next = httpUrl(new URL(location, url));
      if (next.origin !== url.origin) {
        for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      }
      const becomesGet =
        (response.status === 303 && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && method === "POST");
      if (becomesGet) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      url = next;
    }
  };
  const guarded = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    try {
      return await follow(input, init);
    } catch (err) {
      if (err instanceof OutboundBlockedError) options.onRefusal?.(err);
      throw err;
    }
  };
  return guarded;
}
