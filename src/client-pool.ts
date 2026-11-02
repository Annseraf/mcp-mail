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
import { Account, AccountsStore } from "./accounts.js";

interface AccountClients {
  imap: ImapClient;
  smtp: SmtpClient;
  caldav: CalDavClient | null;
  draftsFolder: string;
  sentFolder: string | null;
}

export class ClientPool {
  private readonly store: AccountsStore;
  private pool: Map<string, AccountClients> = new Map();

  constructor(store: AccountsStore) {
    this.store = store;
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
    const imap = new ImapClient({
      host: account.imap.host,
      port: account.imap.port,
      user: account.imap.user,
      pass: account.imap.pass,
      secure: account.imap.tls,
    });
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
    );
    const caldav = account.caldav
      ? new CalDavClient({
          url: account.caldav.url,
          user: account.caldav.user,
          pass: account.caldav.pass,
        })
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
