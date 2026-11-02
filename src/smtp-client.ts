/**
 * SMTP client wrapper around nodemailer.
 *
 * Sends RFC-5322 messages and, for create_draft, returns the raw message
 * source so the IMAP client can APPEND it to the Drafts folder.
 */

import nodemailer, { Transporter, SendMailOptions } from "nodemailer";

export interface SmtpAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
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
  private readonly transporter: Transporter;
  private readonly defaults: SmtpDefaults;

  constructor(auth: SmtpAuth, defaults: SmtpDefaults) {
    this.transporter = nodemailer.createTransport({
      host: auth.host,
      port: auth.port,
      secure: auth.secure,
      auth: { user: auth.user, pass: auth.pass },
    });
    this.defaults = defaults;
  }

  /** Connect and authenticate without sending (used by the admin API's mailbox test). */
  async verify(): Promise<void> {
    try {
      await this.transporter.verify();
    } finally {
      this.transporter.close();
    }
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const mail = this.toMailOptions(msg);
    const info = await this.transporter.sendMail(mail);
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
  async buildRawSource(msg: OutgoingMessage): Promise<Buffer> {
    const mail = this.toMailOptions(msg);
    // Lazy import to keep startup light.
    const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");
    const composer = new MailComposer(mail);
    return await new Promise<Buffer>((resolve, reject) => {
      composer.compile().build((err, message) => {
        if (err) reject(err);
        else resolve(message);
      });
    });
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
