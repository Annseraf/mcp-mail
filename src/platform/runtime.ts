/**
 * Multi-tenant request path: per-tenant accounts and IMAP/SMTP pools, client
 * authentication bound to one tenant, and the guard every tool call passes
 * through (suspension, limits, capabilities, send controls, audit).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { StaticAccounts, type Account } from "../accounts.js";
import { ClientPool, type AccountClients, type PoolLike } from "../client-pool.js";
import { capabilityOf, presetAllows } from "../policy/capabilities.js";
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

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const denied = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function countRecipients(args: Record<string, unknown>): number {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "string" && v ? 1 : 0);
  return n(args.to) + n(args.cc) + n(args.bcc);
}

/**
 * Wrap `server.registerTool` so every tool registered afterwards is filtered
 * by the client's policy (hidden from tools/list) and guarded at dispatch.
 */
export function guardTools(server: McpServer, ctx: TenantContext, audit: AuditLog): void {
  const { tenant, client } = ctx;
  const visible = (tool: string) => presetAllows(client.preset, tool);
  const original = server.registerTool.bind(server) as (...a: unknown[]) => unknown;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as unknown as { registerTool: (...a: any[]) => unknown }).registerTool = (
    name: string,
    config: unknown,
    cb: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>,
  ) => {
    if (!visible(name)) return undefined;
    return original(name, config, async (args: Record<string, unknown>, extra: unknown) => {
      const started = Date.now();
      const base = {
        ts: new Date().toISOString(),
        tenantId: tenant.id,
        clientId: client.id,
        tool: name,
        account: typeof args.account === "string" ? args.account : undefined,
        mailbox: typeof args.mailbox === "string" ? args.mailbox : undefined,
        uid: typeof args.uid === "number" ? args.uid : undefined,
      };
      const deny = async (reason: string, text: string) => {
        await audit
          .record({ ...base, result: "denied", reason, durationMs: Date.now() - started })
          .catch(() => {});
        return denied(text);
      };

      if (tenant.status !== "active")
        return deny("tenant-suspended", "This account is suspended. Contact support.");
      if (!visible(name)) return deny("capability", `This client is not allowed to use ${name}.`);
      if ((await audit.callsToday(tenant.id)) >= tenant.limits.toolCallsPerDay) {
        return deny(
          "daily-limit",
          "Daily tool-call limit reached for this account. Try again tomorrow.",
        );
      }
      if (capabilityOf(name) === "send") {
        if (!tenant.limits.allowSend)
          return deny("send-not-allowed", "Sending email is not enabled for this account.");
        if (!client.sendEnabled)
          return deny("send-disabled", "Sending email is turned off for this client.");
        const recipients = countRecipients(args);
        if (recipients > tenant.limits.maxRecipientsPerSend) {
          return deny(
            "recipient-cap",
            `Too many recipients (max ${tenant.limits.maxRecipientsPerSend}).`,
          );
        }
      }
      const recipients = capabilityOf(name) === "send" ? countRecipients(args) : undefined;
      try {
        const result = await cb(args, extra);
        await audit
          .record({
            ...base,
            recipients,
            result: result?.isError ? "error" : "ok",
            durationMs: Date.now() - started,
          })
          .catch(() => {});
        return result;
      } catch (err) {
        await audit
          .record({ ...base, recipients, result: "error", durationMs: Date.now() - started })
          .catch(() => {});
        throw err;
      }
    });
  };
}
