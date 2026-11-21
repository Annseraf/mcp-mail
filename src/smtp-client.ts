/**
 * SMTP client wrapper around nodemailer.
 *
 * Sends RFC-5322 messages and, for create_draft, returns the raw message
 * source so the IMAP client can APPEND it to the Drafts folder.
 */

import nodemailer, { Transporter, SendMailOptions } from "nodemailer";
import { ConnectTarget, OutboundPolicy, resolveConnectTarget } from "./outbound.js";

export interface SmtpAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
}

/** Transport options for a target. A pinned target keeps the configured name for TLS. */
export function smtpTransportOptions(
  auth: SmtpAuth,
  target: ConnectTarget,
): Parameters<typeof nodemailer.createTransport>[0] {
  return {
    host: target.host,
    port: auth.port,
    secure: auth.secure,
    auth: { user: auth.user, pass: auth.pass },
    ...(target.servername ? { tls: { servername: target.servername } } : {}),
  };
}

export interface SmtpDefaults {
  from: string;
  fromName?: string;
}

export interface OutgoingMessage {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType?: string;
  }>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

export class SmtpClient {
  /** Shared transport. Null when guarded: each use validates the host and builds its own. */
  private readonly transporter: Transporter | null;
  private readonly defaults: SmtpDefaults;
  private readonly auth: SmtpAuth;
  private readonly outbound?: OutboundPolicy;

  constructor(auth: SmtpAuth, defaults: SmtpDefaults, opts: { outbound?: OutboundPolicy } = {}) {
    this.auth = auth;
    this.outbound = opts.outbound;
    this.transporter = this.outbound
      ? null
      : nodemailer.createTransport(smtpTransportOptions(auth, { host: auth.host }));
    this.defaults = defaults;
  }

  /** Connect and authenticate without sending (used by the admin API's mailbox test). */
  async verify(): Promise<void> {
    await this.withTransport((transporter) => transporter.verify(), true);
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const mail = this.toMailOptions(msg);
    const info = await this.withTransport((transporter) => transporter.sendMail(mail));
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
      response: info.response ?? "",
    };
  }

  /**
   * Build raw RFC 822 source via nodemailer's own composer, without using
   * the SMTP transport. Used by create_draft (APPEND to Drafts folder) and
   * by the "save copy to Sent folder" step after send().
   */
  async buildRawSource(msg: OutgoingMessage, opts: { keepBcc?: boolean } = {}): Promise<Buffer> {
    const mail = this.toMailOptions(msg);
    // Lazy import to keep startup light.
    const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");
    const node = new MailComposer(mail).compile();
    // Drafts keep Bcc so the message can be sent later as written.
    if (opts.keepBcc) (node as unknown as { keepBcc: boolean }).keepBcc = true;
    return await new Promise<Buffer>((resolve, reject) => {
      node.build((err, message) => {
        if (err) reject(err);
        else resolve(message);
      });
    });
  }

  /**
   * Run one use of a transporter. Unguarded clients reuse the shared one, and
   * close it only when `closeAfter` is set (verify). Guarded clients validate the
   * host now and dial the validated address for this use only, so a later DNS
   * answer cannot redirect the connection. They always close their own transporter.
   */
  private async withTransport<T>(
    use: (transporter: Transporter) => Promise<T>,
    closeAfter = false,
  ): Promise<T> {
    if (this.transporter) {
      try {
        return await use(this.transporter);
      } finally {
        if (closeAfter) this.transporter.close();
      }
    }
    const target = await resolveConnectTarget(this.auth.host, this.outbound);
    const transporter = nodemailer.createTransport(smtpTransportOptions(this.auth, target));
    try {
      return await use(transporter);
    } finally {
      transporter.close();
    }
  }

  private toMailOptions(msg: OutgoingMessage): SendMailOptions {
    const from = this.defaults.fromName
      ? `"${this.defaults.fromName.replace(/"/g, '\\"')}" <${this.defaults.from}>`
      : this.defaults.from;
    const opts: SendMailOptions = {
      from,
      to: msg.to,
      subject: msg.subject,
    };
    if (msg.cc) opts.cc = msg.cc;
    if (msg.bcc) opts.bcc = msg.bcc;
    if (msg.text) opts.text = msg.text;
    if (msg.html) opts.html = msg.html;
    if (msg.replyTo) opts.replyTo = msg.replyTo;
    if (msg.inReplyTo) opts.inReplyTo = msg.inReplyTo;
    if (msg.references) opts.references = msg.references;
    if (msg.attachments && msg.attachments.length > 0) {
      opts.attachments = msg.attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, "base64"),
        contentType: a.contentType,
      }));
    }
    return opts;
  }
}
