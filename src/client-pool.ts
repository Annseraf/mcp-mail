/**
 * Per-account client pool.
 *
 * Holds one ImapClient + SmtpClient (+ optional CalDavClient) per account,
 * lazy-initialized on first use. When accounts.json changes the entire pool
 * is dropped and rebuilt on next request — simpler than diffing per-field
 * credential changes, and IMAP reconnects are cheap (~one TLS handshake).
 */

import { ImapClient } from "./imap-client.js";
import { SmtpClient } from "./smtp-client.js";
import { CalDavClient } from "./caldav-client.js";
import { Account, AccountSource } from "./accounts.js";
import { OutboundPolicy } from "./outbound.js";

export interface AccountClients {
  imap: ImapClient;
  smtp: SmtpClient;
  caldav: CalDavClient | null;
  draftsFolder: string;
  sentFolder: string | null;
}

/** What tools need from a pool: resolve an account id (or the default) to its clients. */
export interface PoolLike {
  for(accountId?: string): AccountClients;
}

export class ClientPool implements PoolLike {
  private readonly store: AccountSource;
  private readonly outbound?: OutboundPolicy;
  private pool: Map<string, AccountClients> = new Map();

  /** With `outbound`, every host this pool dials is validated first (see outbound.ts). */
  constructor(store: AccountSource, opts: { outbound?: OutboundPolicy } = {}) {
    this.store = store;
    this.outbound = opts.outbound;
  }

  /**
   * Resolve the requested account ID (or default if omitted) and return its
   * client trio. Lazy-initializes the underlying connections on first use.
   */
  for(accountId?: string): AccountClients {
    const account = this.store.resolve(accountId);
    const existing = this.pool.get(account.id);
    if (existing) return existing;
    const clients = this.build(account);
    this.pool.set(account.id, clients);
    return clients;
  }

  /**
   * Drop and close all cached clients — call this when accounts.json
   * changes so the next request rebuilds with the new credentials.
   */
  async resetAll(): Promise<void> {
    const old = Array.from(this.pool.values());
    this.pool.clear();
    await Promise.all(old.map((c) => c.imap.close().catch(() => {})));
  }

  /** Shutdown: close every IMAP connection. */
  async closeAll(): Promise<void> {
    await this.resetAll();
  }

  private build(account: Account): AccountClients {
    const outbound = { outbound: this.outbound };
    const imap = new ImapClient(
      {
        host: account.imap.host,
        port: account.imap.port,
        user: account.imap.user,
        pass: account.imap.pass,
        secure: account.imap.tls,
      },
      outbound,
    );
    const smtp = new SmtpClient(
      {
        host: account.smtp.host,
        port: account.smtp.port,
        user: account.smtp.user,
        pass: account.smtp.pass,
        secure: account.smtp.tls,
      },
      {
        from: account.mail.defaultFrom,
        fromName: account.mail.defaultFromName || undefined,
      },
      outbound,
    );
    const caldav = account.caldav
      ? new CalDavClient(
          {
            url: account.caldav.url,
            user: account.caldav.user,
            pass: account.caldav.pass,
          },
          outbound,
        )
      : null;
    return {
      imap,
      smtp,
      caldav,
      draftsFolder: account.mail.draftsFolder,
      sentFolder: account.mail.sentFolder,
    };
  }
}
