/**
 * IMAP client wrapper around imapflow.
 *
 * Holds a single long-lived connection that auto-reconnects on demand.
 * Each operation acquires a mailbox lock so concurrent tool calls don't
 * collide on the IMAP `SELECT` state.
 *
 * Tool handlers stay thin: they call high-level methods here, get back
 * plain JSON-shaped objects, and don't see imapflow internals.
 */

import { ImapFlow, ImapFlowOptions, FetchMessageObject } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";

export interface ImapAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
}

export interface MailboxSummary {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  subscribed: boolean;
  listed: boolean;
}

export interface MessageSummary {
  uid: number;
  seq: number;
  flags: string[];
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  size: number | null;
  preview: string | null;
  /** Additive in mcp-mail: threading identifiers from the envelope. */
  messageId?: string | null;
  inReplyTo?: string | null;
}

/** Summary plus the References header, used to group conversations. */
export interface ThreadMember extends MessageSummary {
  mailbox: string;
  references: string[];
}

export interface AttachmentContent {
  index: number;
  filename: string | null;
  contentType: string;
  size: number;
  content_base64: string;
}

export interface MessageDetail extends MessageSummary {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  /** True when the message has no text/plain part and bodyText was generated from HTML. */
  textFromHtml?: boolean;
  attachments: Array<{
    /** Position in the message; pass to get_attachment. */
    index: number;
    filename: string | null;
    contentType: string;
    size: number;
    contentId: string | null;
  }>;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: string; // YYYY-MM-DD
  before?: string; // YYYY-MM-DD
  unread?: boolean;
  flagged?: boolean;
}

export class ImapClient {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private readonly opts: ImapFlowOptions;

  constructor(auth: ImapAuth) {
    this.opts = {
      host: auth.host,
      port: auth.port,
      secure: auth.secure,
      auth: { user: auth.user, pass: auth.pass },
      logger: false,
    };
  }

  private async ensureConnected(): Promise<ImapFlow> {
    if (this.client && this.client.usable) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async (): Promise<ImapFlow> => {
      const client = new ImapFlow(this.opts);
      client.on("error", () => {
        // Mark unusable so next call reconnects.
        if (this.client === client) this.client = null;
      });
      await client.connect();
      this.client = client;
      this.connecting = null;
      return client;
    })();
    return this.connecting;
  }

  async close(): Promise<void> {
    if (this.client) {
      const c = this.client;
      this.client = null;
      try {
        await c.logout();
      } catch {
        // best effort
      }
    }
  }

  async listMailboxes(): Promise<MailboxSummary[]> {
    const client = await this.ensureConnected();
    const list = await client.list();
    return list.map((m) => ({
      path: m.path,
      name: m.name,
      delimiter: m.delimiter ?? "/",
      flags: Array.from(m.flags ?? []),
      specialUse: m.specialUse ?? undefined,
      subscribed: Boolean(m.subscribed),
      listed: Boolean(m.listed),
    }));
  }

  async listMessages(
    mailbox: string,
    opts: { limit?: number; unreadOnly?: boolean } = {},
  ): Promise<MessageSummary[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const status = await client.status(mailbox, { messages: true });
      // imapflow 2 returns false when the folder can't be read.
      const total = status ? (status.messages ?? 0) : 0;
      if (total === 0) return [];
      const limit = Math.min(opts.limit ?? 25, 200);

      let uids: number[] = [];
      if (opts.unreadOnly) {
        const found = await client.search({ seen: false }, { uid: true });
        const arr = Array.isArray(found) ? found : [];
        uids = arr.slice(-limit).reverse();
      } else {
        // Fetch the newest `limit` by sequence number.
        const from = Math.max(1, total - limit + 1);
        const messages = await this.fetchRange(client, `${from}:*`, false);
        return messages.reverse();
      }
      if (uids.length === 0) return [];
      return await this.fetchRange(client, uids.join(","), true);
    } finally {
      lock.release();
    }
  }

  async searchMessages(
    mailbox: string,
    criteria: SearchCriteria,
    limit = 25,
  ): Promise<MessageSummary[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const query: Record<string, unknown> = {};
      if (criteria.from) query.from = criteria.from;
      if (criteria.to) query.to = criteria.to;
      if (criteria.subject) query.subject = criteria.subject;
      if (criteria.body) query.body = criteria.body;
      if (criteria.since) query.since = new Date(criteria.since);
      if (criteria.before) query.before = new Date(criteria.before);
      if (criteria.unread === true) query.seen = false;
      if (criteria.unread === false) query.seen = true;
      if (criteria.flagged === true) query.flagged = true;
      if (criteria.flagged === false) query.unflagged = true;

      const found = await client.search(query, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      if (uids.length === 0) return [];
      const slice = uids.slice(-Math.min(limit, 200)).reverse();
      return await this.fetchRange(client, slice.join(","), true);
    } finally {
      lock.release();
    }
  }

  async getMessage(mailbox: string, uid: number): Promise<MessageDetail> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(
        `${uid}`,
        { source: true, envelope: true, flags: true, internalDate: true, size: true },
        { uid: true },
      );
      if (!msg) {
        throw new Error(`Message UID ${uid} not found in ${mailbox}`);
      }
      const parsed: ParsedMail = await simpleParser(msg.source as Buffer);
      const source = (msg.source as Buffer).toString("latin1");
      const textFromHtml =
        typeof parsed.html === "string" && !/content-type:\s*text\/plain/i.test(source);
      return {
        textFromHtml,
        uid: msg.uid as number,
        seq: msg.seq as number,
        flags: Array.from(msg.flags ?? []),
        date: (msg.internalDate as Date | undefined)?.toISOString() ?? null,
        subject: parsed.subject ?? null,
        from: parsed.from?.text ?? null,
        to: Array.isArray(parsed.to)
          ? parsed.to.map((a) => a.text).join(", ")
          : (parsed.to?.text ?? null),
        cc: Array.isArray(parsed.cc)
          ? parsed.cc.map((a) => a.text).join(", ")
          : (parsed.cc?.text ?? null),
        size: (msg.size as number | undefined) ?? null,
        preview: parsed.text ? parsed.text.slice(0, 200) : null,
        messageId: parsed.messageId ?? null,
        inReplyTo: parsed.inReplyTo ?? null,
        references: Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [],
        bodyText: parsed.text ?? null,
        bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
        attachments: (parsed.attachments ?? []).map((a, index) => ({
          index,
          filename: a.filename ?? null,
          contentType: a.contentType,
          size: a.size,
          contentId: a.cid ?? null,
        })),
      };
    } finally {
      lock.release();
    }
  }

  /** Download one attachment by its index from get_message. Refuses anything over maxBytes. */
  async getAttachment(
    mailbox: string,
    uid: number,
    index: number,
    maxBytes: number,
  ): Promise<AttachmentContent> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
      if (!msg) throw new Error(`Message UID ${uid} not found in ${mailbox}`);
      const parsed: ParsedMail = await simpleParser(msg.source as Buffer);
      const a = (parsed.attachments ?? [])[index];
      if (!a) throw new Error(`Message UID ${uid} has no attachment at index ${index}`);
      if (a.size > maxBytes) {
        throw new Error(`Attachment is ${a.size} bytes, over the ${maxBytes}-byte limit`);
      }
      return {
        index,
        filename: a.filename ?? null,
        contentType: a.contentType,
        size: a.size,
        content_base64: a.content.toString("base64"),
      };
    } finally {
      lock.release();
    }
  }

  /** Add and remove flags (\\Flagged, \\Answered, \\Seen, custom keywords). Returns the resulting flags. */
  async setFlags(mailbox: string, uid: number, add: string[], remove: string[]): Promise<string[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (add.length) await client.messageFlagsAdd(`${uid}`, add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(`${uid}`, remove, { uid: true });
      const msg = await client.fetchOne(`${uid}`, { flags: true }, { uid: true });
      if (!msg) throw new Error(`Message UID ${uid} not found in ${mailbox}`);
      return Array.from(msg.flags ?? []);
    } finally {
      lock.release();
    }
  }

  /** Paths of every folder that can hold messages. */
  async selectableMailboxes(): Promise<string[]> {
    const client = await this.ensureConnected();
    const list = await client.list();
    return list.filter((m) => !(m.flags ?? new Set()).has("\\Noselect")).map((m) => m.path);
  }

  /** UIDs in a mailbox whose header contains a value (Message-ID, References, In-Reply-To). */
  /** Raw RFC 822 source of one message. */
  async getSource(mailbox: string, uid: number): Promise<Buffer> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`Message UID ${uid} not found in ${mailbox}`);
      return msg.source as Buffer;
    } finally {
      lock.release();
    }
  }

  async searchHeader(mailbox: string, header: string, value: string): Promise<number[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const found = await client.search({ header: { [header]: value } }, { uid: true });
      return Array.isArray(found) ? found : [];
    } finally {
      lock.release();
    }
  }

  /** Newest-first summaries whose subject, sender or body contains `q`. */
  async searchAny(mailbox: string, q: string, limit = 20): Promise<MessageSummary[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const found = await client.search(
        { or: [{ subject: q }, { from: q }, { body: q }] },
        { uid: true },
      );
      const uids = Array.isArray(found) ? found : [];
      if (!uids.length) return [];
      return (await this.fetchRange(client, uids.slice(-limit).join(","), true)).reverse();
    } finally {
      lock.release();
    }
  }

  /** UIDs in a mailbox whose subject contains a string. */
  async searchSubject(mailbox: string, subject: string): Promise<number[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const found = await client.search({ subject }, { uid: true });
      return Array.isArray(found) ? found : [];
    } finally {
      lock.release();
    }
  }

  /** Summaries plus References for threading. `uids` empty = the newest `limit` messages. */
  async threadMembers(mailbox: string, uids: number[], limit = 50): Promise<ThreadMember[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      let range: string;
      let byUid = true;
      if (uids.length) {
        range = uids.slice(-200).join(",");
      } else {
        const status = await client.status(mailbox, { messages: true });
        const total = status ? (status.messages ?? 0) : 0;
        if (total === 0) return [];
        range = `${Math.max(1, total - Math.min(limit, 500) + 1)}:*`;
        byUid = false;
      }
      const out: ThreadMember[] = [];
      for await (const msg of client.fetch(
        range,
        {
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
          bodyParts: ["1"],
          headers: ["references"],
        },
        { uid: byUid },
      )) {
        const refs = msg.headers
          ? (msg.headers
              .toString("utf8")
              .replace(/^references:/i, "")
              .match(/<[^>]+>/g) ?? [])
          : [];
        out.push({ ...summarize(msg), mailbox, references: refs });
      }
      return out;
    } finally {
      lock.release();
    }
  }

  async markRead(mailbox: string, uid: number, read: boolean): Promise<void> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (read) {
        await client.messageFlagsAdd(`${uid}`, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(`${uid}`, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  async moveMessage(sourceMailbox: string, uid: number, destinationMailbox: string): Promise<void> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(sourceMailbox);
    try {
      await client.messageMove(`${uid}`, destinationMailbox, { uid: true });
    } finally {
      lock.release();
    }
  }

  /** The Trash folder: the \\Trash special-use folder, else a conventionally named one. */
  async findTrash(): Promise<string | undefined> {
    const boxes = await this.listMailboxes();
    const special = boxes.find((m) => m.specialUse === "\\Trash");
    if (special) return special.path;
    const named = boxes.find((m) =>
      /^(trash|deleted items|deleted messages|bin|papierkorb)$/i.test(m.name),
    );
    return named?.path;
  }

  async deleteMessage(mailbox: string, uid: number): Promise<void> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      await client.messageDelete(`${uid}`, { uid: true });
    } finally {
      lock.release();
    }
  }

  /**
   * Append a raw RFC 822 message to a folder — used for drafts and for
   * keeping a copy of sent messages.
   */
  async append(mailbox: string, raw: string | Buffer, flags: string[]): Promise<void> {
    const client = await this.ensureConnected();
    await client.append(mailbox, raw, flags);
  }

  private async fetchRange(
    client: ImapFlow,
    range: string,
    byUid: boolean,
  ): Promise<MessageSummary[]> {
    const out: MessageSummary[] = [];
    const fetchOpts = {
      envelope: true,
      flags: true,
      internalDate: true,
      size: true,
      bodyParts: ["1"],
    };
    for await (const msg of client.fetch(range, fetchOpts, { uid: byUid })) {
      out.push(summarize(msg));
    }
    return out;
  }
}

function addrText(
  addr: { name?: string; address?: string }[] | { name?: string; address?: string } | undefined,
): string | null {
  if (!addr) return null;
  const list = Array.isArray(addr) ? addr : [addr];
  return (
    list
      .map((a) => {
        const name = a?.name?.trim();
        const email = a?.address?.trim();
        if (name && email) return `${name} <${email}>`;
        return email ?? name ?? null;
      })
      .filter((v): v is string => Boolean(v))
      .join(", ") || null
  );
}

function summarize(msg: FetchMessageObject): MessageSummary {
  const env = msg.envelope;
  // Try to grab a short text preview from bodyParts if present.
  let preview: string | null = null;
  const bodyParts = msg.bodyParts;
  if (bodyParts && bodyParts.size > 0) {
    const part = bodyParts.values().next().value;
    if (part) {
      const text = Buffer.isBuffer(part) ? part.toString("utf8") : String(part);
      preview = text.replace(/\s+/g, " ").slice(0, 200);
    }
  }
  return {
    uid: msg.uid as number,
    seq: msg.seq as number,
    flags: Array.from(msg.flags ?? []),
    date: env?.date ? new Date(env.date).toISOString() : null,
    subject: env?.subject ?? null,
    from: addrText(env?.from),
    to: addrText(env?.to),
    cc: addrText(env?.cc),
    size: (msg.size as number | undefined) ?? null,
    preview,
    messageId: env?.messageId ?? null,
    inReplyTo: env?.inReplyTo ?? null,
  };
}
