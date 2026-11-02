/**
 * Multi-tenant request path: per-tenant accounts and IMAP/SMTP pools, client
 * authentication bound to one tenant, and the guard every tool call passes
 * through (suspension, limits, capabilities, send controls, audit).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { StaticAccounts, type Account } from "../accounts.js";
import { ClientPool, type AccountClients, type PoolLike } from "../client-pool.js";
import { capabilityOf, PRESETS } from "../policy/capabilities.js";
import { guardTools, recipientsOf, type Denial } from "../policy/guard.js";
import type { AuditLog } from "./audit.js";
import type { SecretStore } from "./secrets.js";
import type { ClientRecord, ConfigProvider, MailboxRecord, TenantRecord } from "./tenants.js";
import { hashToken, safeEqual } from "./tokens.js";

export const secretName = (mailboxId: string, kind: "imap" | "smtp" | "caldav") =>
  `mailbox:${mailboxId}:${kind}`;

interface TenantCache {
  revision: number;
  accounts: StaticAccounts;
  pool: ClientPool;
}

export interface TenantContext {
  tenant: TenantRecord;
  client: ClientRecord;
  accounts: StaticAccounts;
  pool: PoolLike;
}

type Log = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
) => void;

export class TenantRuntime {
  private readonly cache = new Map<string, TenantCache>();

  constructor(
    private readonly config: ConfigProvider,
    private readonly secrets: SecretStore,
    readonly audit: AuditLog,
    private readonly log: Log,
  ) {}

  /** Authenticate a bearer token against exactly one tenant. Returns undefined on any mismatch. */
  async authenticate(
    tenantId: string,
    token: string,
  ): Promise<{ tenant: TenantRecord; client: ClientRecord } | undefined> {
    const tenant = await this.config.getTenant(tenantId);
    if (!tenant) return undefined;
    const hash = hashToken(token);
    const client = tenant.clients.find(
      (c) => c.status === "active" && safeEqual(c.tokenHash, hash),
    );
    return client ? { tenant, client } : undefined;
  }

  private async build(tenant: TenantRecord): Promise<TenantCache> {
    const accounts: Account[] = [];
    for (const m of tenant.mailboxes) {
      if (m.status !== "active") continue;
      const account = await this.toAccount(tenant.id, m);
      if (account) accounts.push(account);
      else
        this.log("warn", "mailbox skipped: credentials missing", {
          tenantId: tenant.id,
          mailbox: m.id,
        });
    }
    const set = new StaticAccounts(accounts);
    return { revision: tenant.revision, accounts: set, pool: new ClientPool(set) };
  }

  private async toAccount(tenantId: string, m: MailboxRecord): Promise<Account | undefined> {
    const [imapPass, smtpPass, davPass] = await Promise.all([
      this.secrets.get(tenantId, secretName(m.id, "imap")),
      this.secrets.get(tenantId, secretName(m.id, "smtp")),
      m.caldav
        ? this.secrets.get(tenantId, secretName(m.id, "caldav"))
        : Promise.resolve(undefined),
    ]);
    if (imapPass === undefined || smtpPass === undefined) return undefined;
    return {
      id: m.id,
      label: m.label,
      default: m.default,
      imap: { ...m.imap, pass: imapPass },
      smtp: { ...m.smtp, pass: smtpPass },
      mail: { ...m.mail, defaultFromName: m.mail.defaultFromName },
      caldav: m.caldav && davPass !== undefined ? { ...m.caldav, pass: davPass } : undefined,
    };
  }

  async context(tenant: TenantRecord, client: ClientRecord): Promise<TenantContext> {
    let c = this.cache.get(tenant.id);
    if (!c || c.revision !== tenant.revision) {
      await this.drop(tenant.id);
      c = await this.build(tenant);
      this.cache.set(tenant.id, c);
    }
    // A client restricted to some mailboxes only ever sees and resolves those.
    const allowed = client.accounts
      ? new StaticAccounts(c.accounts.list().filter((a) => client.accounts!.includes(a.id)))
      : c.accounts;
    const tenantPool = c.pool;
    const pool: PoolLike = {
      for(accountId?: string): AccountClients {
        return tenantPool.for(allowed.resolve(accountId).id);
      },
    };
    return { tenant, client, accounts: allowed, pool };
  }

  /** Close a tenant's connections and forget its decrypted credentials. */
  async drop(tenantId: string): Promise<void> {
    const c = this.cache.get(tenantId);
    this.cache.delete(tenantId);
    if (c) await c.pool.closeAll().catch(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.cache.keys()].map((id) => this.drop(id)));
  }
}

/** Guard a tenant client's tools: preset capabilities plus tenant limits and send controls. */
export function guardTenantTools(server: McpServer, ctx: TenantContext, audit: AuditLog): void {
  const { tenant, client } = ctx;
  guardTools(server, {
    policy: {
      id: client.id,
      capabilities: new Set(PRESETS[client.preset]),
      accounts: client.accounts,
    },
    audit: { log: audit, tenantId: tenant.id },
    rateKey: `${tenant.id}/${client.id}`,
    async check(tool, args): Promise<Denial | undefined> {
      if (tenant.status !== "active") {
        return { reason: "tenant-suspended", text: "This account is suspended. Contact support." };
      }
      if ((await audit.callsToday(tenant.id)) >= tenant.limits.toolCallsPerDay) {
        return {
          reason: "daily-limit",
          text: "Daily tool-call limit reached for this account. Try again tomorrow.",
        };
      }
      if (capabilityOf(tool, args) === "send") {
        if (!tenant.limits.allowSend) {
          return {
            reason: "send-not-allowed",
            text: "Sending email is not enabled for this account.",
          };
        }
        if (!client.sendEnabled) {
          return { reason: "send-disabled", text: "Sending email is turned off for this client." };
        }
        if (recipientsOf(args).length > tenant.limits.maxRecipientsPerSend) {
          return {
            reason: "recipient-cap",
            text: `Too many recipients (max ${tenant.limits.maxRecipientsPerSend}).`,
          };
        }
      }
      return undefined;
    },
  });
}
