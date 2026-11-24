/**
 * Tenant records for multi-tenant mode. A record holds everything about a
 * tenant except secrets: mailbox passwords live in the SecretStore and
 * client tokens are stored only as SHA-256 hashes.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJson, removeFile, writeFileAtomic } from "./fsutil.js";
import { assertTenantId, isTenantId } from "./ids.js";

export interface ServerEndpoint {
  host: string;
  port: number;
  user: string;
  tls: boolean;
}

export interface MailboxRecord {
  id: string;
  label: string;
  default?: boolean;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  mail: {
    defaultFrom: string;
    defaultFromName?: string;
    signature?: string;
    draftsFolder: string;
    sentFolder: string | null;
  };
  caldav?: { url: string; user: string };
  status: "active" | "suspended";
  createdAt: string;
}

export type Preset = "read-only" | "read-draft" | "organize" | "full-no-delete" | "full";

export interface ClientRecord {
  id: string;
  name: string;
  type: string;
  preset: Preset;
  /** Mailbox ids this client may use; omitted = all. */
  accounts?: string[];
  /** Sending is off by default even when the preset allows it (prompt-injection risk). */
  sendEnabled: boolean;
  /** "approval": sends wait in Drafts until the owner approves them (default "direct"). */
  sendMode?: "direct" | "approval";
  /** Hosted CalDAV permissions default off, including records written before these fields. */
  calendarReadEnabled?: boolean;
  calendarWriteEnabled?: boolean;
  /** Paused: the client keeps its token and settings, but every tool call is refused until resumed. */
  paused?: boolean;
  pausedAt?: string;
  tokenHash: string;
  status: "active" | "revoked";
  createdAt: string;
  rotatedAt?: string;
  revokedAt?: string;
}

export interface TenantLimits {
  maxMailboxes: number;
  maxClients: number;
  toolCallsPerDay: number;
  allowSend: boolean;
  /** Max recipients per send_message call. */
  maxRecipientsPerSend: number;
  auditRetentionDays: number;
}

export const DEFAULT_LIMITS: TenantLimits = {
  maxMailboxes: 1,
  maxClients: 1,
  toolCallsPerDay: 100,
  allowSend: false,
  maxRecipientsPerSend: 10,
  auditRetentionDays: 7,
};

export interface TenantRecord {
  id: string;
  status: "active" | "suspended";
  createdAt: string;
  updatedAt: string;
  /** Bumped on every change; runtimes rebuild when it moves. */
  revision: number;
  limits: TenantLimits;
  mailboxes: MailboxRecord[];
  clients: ClientRecord[];
  /** Legacy records have no coverage start. Their first observed action may still be recorded. */
  firstAction?: {
    coverageStartedAt?: string;
    firstSuccessfulActionAt?: string;
  };
}

/** File-backed tenant store: `<dir>/<tenantId>.json`, one writer at a time per tenant. */
export class FileTenantStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  private readonly firstActionGaps = new Map<string, string>();

  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `${assertTenantId(id)}.json`);
  }

  async get(id: string): Promise<TenantRecord | undefined> {
    if (!isTenantId(id)) return undefined;
    return readJson<TenantRecord>(this.file(id));
  }

  async list(): Promise<string[]> {
    try {
      return (await fs.readdir(this.dir))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .filter(isTenantId)
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async create(record: TenantRecord): Promise<boolean> {
    return this.locked(record.id, async () => {
      if (await this.get(record.id)) return false;
      await writeFileAtomic(this.file(record.id), JSON.stringify(record, null, 2));
      return true;
    });
  }

  /** Read-modify-write under the tenant's lock. `fn` may throw to abort. */
  async update(id: string, fn: (t: TenantRecord) => void): Promise<TenantRecord | undefined> {
    return this.locked(id, async () => {
      const t = await this.get(id);
      if (!t) return undefined;
      fn(t);
      t.revision += 1;
      t.updatedAt = new Date().toISOString();
      await writeFileAtomic(this.file(id), JSON.stringify(t, null, 2));
      return t;
    });
  }

  async recordFirstAction(
    tenant: Pick<TenantRecord, "id" | "createdAt">,
    timestamp: string,
  ): Promise<void> {
    await this.locked(tenant.id, async () => {
      let record: TenantRecord | undefined;
      try {
        record = await this.get(tenant.id);
      } catch (err) {
        this.firstActionGaps.set(tenant.id, tenant.createdAt);
        throw err;
      }
      // A tool that completes after deletion must not recreate the file or write into a new tenant.
      if (!record || record.createdAt !== tenant.createdAt) return;
      const measurement = record.firstAction ?? {};
      const prior = measurement.firstSuccessfulActionAt;
      const lostCoverage = this.firstActionGaps.get(tenant.id) === tenant.createdAt;
      if (prior && prior <= timestamp && !lostCoverage) return;
      if (!prior || timestamp < prior) measurement.firstSuccessfulActionAt = timestamp;
      if (lostCoverage) delete measurement.coverageStartedAt;
      record.firstAction = measurement;
      // This metadata does not change tool configuration or invalidate connection pools.
      try {
        await writeFileAtomic(this.file(tenant.id), JSON.stringify(record, null, 2));
        this.firstActionGaps.delete(tenant.id);
      } catch (err) {
        this.firstActionGaps.set(tenant.id, tenant.createdAt);
        throw err;
      }
    });
  }

  firstActionView(tenant: TenantRecord) {
    return {
      tenantId: tenant.id,
      firstSuccessfulActionAt: tenant.firstAction?.firstSuccessfulActionAt ?? null,
      coverageStartedAt:
        this.firstActionGaps.get(tenant.id) === tenant.createdAt
          ? null
          : (tenant.firstAction?.coverageStartedAt ?? null),
    };
  }

  async delete(id: string): Promise<void> {
    await this.locked(id, async () => {
      await removeFile(this.file(id));
      this.firstActionGaps.delete(id);
    });
  }

  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }
}

/** Supplies tenant records to the request path. */
export interface ConfigProvider {
  readonly kind: "store" | "http";
  getTenant(id: string): Promise<TenantRecord | undefined>;
  /** Drop any cached copy so the next read is fresh. */
  invalidate(id: string): void;
}

/** Default: tenants live in the engine's own store and are managed through the admin API. */
export class StoreConfigProvider implements ConfigProvider {
  readonly kind = "store" as const;
  constructor(readonly store: FileTenantStore) {}
  getTenant(id: string) {
    return this.store.get(id);
  }
  invalidate(): void {}
}

/**
 * Opt-in (CONFIG_PROVIDER=http): a trusted internal service owns tenant
 * config. GET `<baseUrl>/tenants/<id>` with a shared service token returns a
 * TenantRecord (404 = no such tenant). Cached for `ttlMs`; `invalidate`
 * forces a refetch. Secrets never travel this way.
 */
export class HttpConfigProvider implements ConfigProvider {
  readonly kind = "http" as const;
  private readonly cache = new Map<string, { at: number; value: TenantRecord | undefined }>();

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly ttlMs = 30_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getTenant(id: string): Promise<TenantRecord | undefined> {
    if (!isTenantId(id)) return undefined;
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/tenants/${id}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    let value: TenantRecord | undefined;
    if (res.status === 404) value = undefined;
    else if (res.ok) value = (await res.json()) as TenantRecord;
    else throw new Error(`config provider returned HTTP ${res.status}`);
    if (value && value.id !== id) throw new Error("config provider returned a different tenant");
    this.cache.set(id, { at: Date.now(), value });
    return value;
  }

  invalidate(id: string): void {
    this.cache.delete(id);
  }
}
