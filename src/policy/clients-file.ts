/**
 * Single-tenant client identities and policies: clients.json (docs/CLIENTS.md).
 *
 * Absent file = v0.2.x behavior: every authenticated caller has full access.
 * The shared AUTH_TOKEN always maps to the built-in "legacy" client (full
 * access unless clients.json defines a client with id "legacy").
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Preset } from "../platform/tenants.js";
import { writeFileAtomic } from "../platform/fsutil.js";
import { hashToken, safeEqual } from "../platform/tokens.js";
import { PRESETS, type Capability } from "./capabilities.js";
import type { ClientPolicy } from "./guard.js";

export interface ClientEntry {
  id: string;
  name?: string;
  match?: { oauthUser?: string; oauthClientId?: string; tokenHash?: string };
  preset?: Preset;
  allowTools?: string[];
  denyTools?: string[];
  accounts?: string[];
  sendRecipientAllowlist?: string[];
  sendRateLimit?: { perHour: number };
  status?: "active" | "revoked";
  revokedAt?: string;
  /** Tokens issued before this instant are rejected (set by rotate). */
  notBefore?: string;
  [extra: string]: unknown;
}

export interface ClientsFile {
  version: 1;
  defaultPolicy?: Preset;
  clients: ClientEntry[];
  [extra: string]: unknown;
}

export type Identity =
  | { kind: "legacy" }
  | { kind: "token"; token: string }
  | { kind: "oauth"; user: string; clientId: string; issuedAt: number };

export const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set(PRESETS.full);

const LEGACY_POLICY: ClientPolicy = { id: "legacy", capabilities: ALL_CAPABILITIES };

export class ClientsFileError extends Error {}

function validate(doc: unknown): ClientsFile {
  const d = doc as ClientsFile;
  if (!d || typeof d !== "object" || d.version !== 1 || !Array.isArray(d.clients)) {
    throw new ClientsFileError('clients.json must be {"version": 1, "clients": [...]}');
  }
  const ids = new Set<string>();
  for (const [i, c] of d.clients.entries()) {
    if (!c || typeof c.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(c.id)) {
      throw new ClientsFileError(`clients[${i}].id must be lowercase letters, digits, _ or -`);
    }
    if (ids.has(c.id)) throw new ClientsFileError(`Duplicate client id: ${c.id}`);
    ids.add(c.id);
    if (c.preset && !(c.preset in PRESETS))
      throw new ClientsFileError(`clients[${i}].preset is unknown: ${c.preset}`);
  }
  if (d.defaultPolicy && !(d.defaultPolicy in PRESETS)) {
    throw new ClientsFileError(`defaultPolicy is unknown: ${d.defaultPolicy}`);
  }
  return d;
}

export function policyFor(entry: ClientEntry, fallback: Preset = "read-draft"): ClientPolicy {
  return {
    id: entry.id,
    capabilities: new Set(PRESETS[entry.preset ?? fallback]),
    allowTools: entry.allowTools ? new Set(entry.allowTools) : undefined,
    denyTools: entry.denyTools ? new Set(entry.denyTools) : undefined,
    accounts: entry.accounts,
    sendRecipientAllowlist: entry.sendRecipientAllowlist,
    sendRateLimitPerHour: entry.sendRateLimit?.perHour,
  };
}

/** Result of resolving an identity: a policy, or a reason to reject the request. */
export type Resolution =
  { policy: ClientPolicy; entry?: ClientEntry } | { rejected: "unknown" | "revoked" };

export class ClientsStore {
  private cache?: { mtimeMs: number; doc: ClientsFile | undefined };

  constructor(readonly file: string) {}

  /** Re-reads the file when it changes (mtime), so CLI edits apply without a restart. */
  async load(): Promise<ClientsFile | undefined> {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(this.file)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = { mtimeMs: 0, doc: undefined };
        return undefined;
      }
      throw err;
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.doc;
    const doc = validate(JSON.parse(await fs.readFile(this.file, "utf8")));
    this.cache = { mtimeMs, doc };
    return doc;
  }

  async save(doc: ClientsFile): Promise<void> {
    validate(doc);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(doc, null, 2) + "\n");
    this.cache = undefined;
  }

  async resolve(identity: Identity): Promise<Resolution> {
    const doc = await this.load();
    if (identity.kind === "legacy") {
      const override = doc?.clients.find((c) => c.id === "legacy");
      if (!override) return { policy: LEGACY_POLICY };
      return override.status === "revoked"
        ? { rejected: "revoked" }
        : { policy: policyFor(override, "full"), entry: override };
    }
    if (!doc) {
      // No clients.json: v0.2.x semantics. OAuth logins get full access; static tokens don't exist.
      return identity.kind === "oauth"
        ? { policy: { id: `oauth:${identity.user}`, capabilities: ALL_CAPABILITIES } }
        : { rejected: "unknown" };
    }
    let entry: ClientEntry | undefined;
    if (identity.kind === "token") {
      const h = hashToken(identity.token);
      entry = doc.clients.find((c) => c.match?.tokenHash && safeEqual(c.match.tokenHash, h));
      if (!entry) return { rejected: "unknown" };
    } else {
      entry =
        doc.clients.find((c) => c.match?.oauthClientId === identity.clientId) ??
        doc.clients.find((c) => c.match?.oauthUser === identity.user);
      // Token iat has second resolution; compare at the same resolution.
      if (entry?.notBefore && identity.issuedAt < Math.floor(Date.parse(entry.notBefore) / 1000)) {
        return { rejected: "revoked" };
      }
      if (!entry) {
        return {
          policy: {
            ...policyFor({ id: "default" }, doc.defaultPolicy ?? "read-draft"),
            id: `oauth:${identity.user}`,
          },
        };
      }
    }
    if (entry.status === "revoked") return { rejected: "revoked" };
    return { policy: policyFor(entry, doc.defaultPolicy ?? "read-draft"), entry };
  }
}
