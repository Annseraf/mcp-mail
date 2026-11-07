/**
 * Approval queue: "ask me before sending" (docs/PLATFORM.md).
 *
 * A client with `sendMode: "approval"` doesn't send. Its message is saved to
 * the mailbox's Drafts folder and a small queue entry records where to find
 * it. The owner approves (the draft is sent, copied to Sent and removed) or
 * rejects (the draft is removed) through the admin API. Unanswered requests
 * expire and the draft stays in Drafts. The engine never stores the content:
 * only ids, the Message-ID of the draft and timestamps.
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { simpleParser, type AddressObject } from "mailparser";
import { writeFileAtomic } from "./fsutil.js";
import { assertTenantId } from "./ids.js";
import type { AccountClients } from "../client-pool.js";
import type { OutgoingMessage } from "../smtp-client.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "failed";

export interface ApprovalRecord {
  id: string;
  clientId: string;
  account: string;
  /** Message-ID header of the draft holding the message. */
  draftMessageId: string;
  draftsFolder: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  /** Why sending failed (status "failed"); never message content. */
  error?: string;
}

/** What the owner sees before deciding, read live from the draft. */
export interface ApprovalPreview {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: { filename: string; size: number }[];
}

export interface ApprovalSettings {
  /** How long a request waits before it expires (default 24 h). */
  ttlMs: number;
  /** Told about every new request (optional). */
  webhookUrl?: string;
  webhookSecret?: string;
}

type Log = (level: "info" | "warn", msg: string, extra?: Record<string, unknown>) => void;

/** Keep the last decided requests per tenant so the product can show history. */
const KEEP_DECIDED = 50;

/** File-backed queue: `<dir>/<tenantId>.json`, one writer at a time per tenant. */
export class ApprovalStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dir: string,
    readonly settings: ApprovalSettings,
    private readonly log: Log,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private file(tenantId: string): string {
    return path.join(this.dir, `${assertTenantId(tenantId)}.json`);
  }

  private async read(tenantId: string): Promise<ApprovalRecord[]> {
    try {
      return JSON.parse(await readFile(this.file(tenantId), "utf8")) as ApprovalRecord[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Read-modify-write under a per-tenant lock; expires overdue requests on the way. */
  private async mutate<T>(tenantId: string, fn: (list: ApprovalRecord[]) => T): Promise<T> {
    const prev = this.locks.get(tenantId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const list = await this.read(tenantId);
      expire(list);
      const out = fn(list);
      const pending = list.filter((a) => a.status === "pending");
      const decided = list.filter((a) => a.status !== "pending").slice(-KEEP_DECIDED);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file(tenantId), JSON.stringify([...decided, ...pending]));
      return out;
    });
    this.locks.set(
      tenantId,
      run.catch(() => {}),
    );
    return run;
  }

  async list(tenantId: string): Promise<ApprovalRecord[]> {
    return this.mutate(tenantId, (list) => list.map((a) => ({ ...a })));
  }

  async get(tenantId: string, id: string): Promise<ApprovalRecord | undefined> {
    return (await this.list(tenantId)).find((a) => a.id === id);
  }

  async purgeTenant(tenantId: string): Promise<void> {
    await rm(this.file(tenantId), { force: true });
  }

  /**
   * Hold a message for approval: save it to Drafts and queue it. Returns the
   * request; the caller tells the agent it's waiting.
   */
  async hold(
    tenantId: string,
    clientId: string,
    account: string,
    clients: AccountClients,
    msg: OutgoingMessage,
  ): Promise<ApprovalRecord> {
    const raw = await clients.smtp.buildRawSource(msg, { keepBcc: true });
    const messageId = /^message-id:\s*(<[^>\r\n]+>)/im.exec(raw.toString("latin1"))?.[1];
    if (!messageId) throw new Error("Couldn't prepare the message for approval.");
    await clients.imap.append(clients.draftsFolder, raw, ["\\Draft"]);
    const created = new Date();
    const rec: ApprovalRecord = {
      id: `ap-${randomBytes(6).toString("hex")}`,
      clientId,
      account,
      draftMessageId: messageId,
      draftsFolder: clients.draftsFolder,
      status: "pending",
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.settings.ttlMs).toISOString(),
    };
    await this.mutate(tenantId, (list) => list.push(rec));
    this.notify(tenantId, rec);
    return rec;
  }

  /** The held message as it is now in Drafts (undefined if the draft is gone). */
  async preview(
    rec: ApprovalRecord,
    clients: AccountClients,
  ): Promise<ApprovalPreview | undefined> {
    const draft = await findDraft(rec, clients);
    if (!draft) return undefined;
    const p = await simpleParser(draft.source);
    return {
      from: p.from?.text ?? "",
      to: addresses(p.to),
      cc: addresses(p.cc),
      bcc: addresses(p.bcc),
      subject: p.subject ?? "",
      text: (p.text ?? "").slice(0, 20_000),
      attachments: p.attachments.map((a) => ({
        filename: a.filename ?? "attachment",
        size: a.size,
      })),
    };
  }

  /**
   * Approve: send the draft as it is now (the owner may have edited it), copy
   * it to Sent and remove the draft. Reject: remove the draft.
   */
  async decide(
    tenantId: string,
    id: string,
    decision: "approve" | "reject",
    clients: AccountClients,
  ): Promise<ApprovalRecord> {
    const rec = await this.get(tenantId, id);
    if (!rec) throw new ApprovalError(404, "not_found", "Approval request not found");
    if (rec.status !== "pending") {
      throw new ApprovalError(409, "conflict", `This request is already ${rec.status}`);
    }
    // Claim it first so two approvals can't both send.
    await this.setStatus(tenantId, id, "pending", decision === "approve" ? "approved" : "rejected");
    const draft = await findDraft(rec, clients).catch(() => undefined);
    if (decision === "reject") {
      if (draft) await clients.imap.deleteMessage(rec.draftsFolder, draft.uid).catch(() => {});
      return (await this.get(tenantId, id))!;
    }
    try {
      if (!draft) throw new Error("The draft is no longer in Drafts (deleted or sent elsewhere)");
      const msg = await toOutgoing(draft.source);
      await clients.smtp.send(msg);
      if (clients.sentFolder) {
        const copy = await clients.smtp.buildRawSource(msg);
        await clients.imap.append(clients.sentFolder, copy, ["\\Seen"]).catch(() => {});
      }
      await clients.imap.deleteMessage(rec.draftsFolder, draft.uid).catch(() => {});
    } catch (err) {
      await this.setStatus(
        tenantId,
        id,
        "approved",
        "failed",
        (err as Error).message.slice(0, 300),
      );
      throw new ApprovalError(502, "send_failed", `Sending failed: ${(err as Error).message}`);
    }
    return (await this.get(tenantId, id))!;
  }

  private async setStatus(
    tenantId: string,
    id: string,
    from: ApprovalStatus,
    to: ApprovalStatus,
    error?: string,
  ): Promise<void> {
    await this.mutate(tenantId, (list) => {
      const a = list.find((x) => x.id === id);
      if (!a || a.status !== from) {
        throw new ApprovalError(409, "conflict", `This request is already ${a?.status ?? "gone"}`);
      }
      a.status = to;
      a.decidedAt = new Date().toISOString();
      if (error) a.error = error;
    });
  }

  /** Tell the product about a new request (fire and forget, signed). */
  private notify(tenantId: string, rec: ApprovalRecord): void {
    const { webhookUrl, webhookSecret } = this.settings;
    if (!webhookUrl) return;
    const body = JSON.stringify({
      type: "approval.created",
      tenantId,
      approvalId: rec.id,
      clientId: rec.clientId,
      account: rec.account,
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
    });
    const ts = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (webhookSecret) {
      const sig = createHmac("sha256", webhookSecret).update(`${ts}.${body}`).digest("hex");
      headers["x-mcp-mail-signature"] = `t=${ts},v1=${sig}`;
    }
    this.fetchImpl(webhookUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) })
      .then((r) => {
        if (!r.ok) this.log("warn", "approval webhook failed", { tenantId, status: r.status });
      })
      .catch((err) =>
        this.log("warn", "approval webhook failed", { tenantId, error: (err as Error).message }),
      );
  }
}

export class ApprovalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function expire(list: ApprovalRecord[]): void {
  const now = new Date().toISOString();
  for (const a of list) {
    if (a.status === "pending" && a.expiresAt <= now) {
      a.status = "expired";
      a.decidedAt = now;
    }
  }
}

async function findDraft(
  rec: ApprovalRecord,
  clients: AccountClients,
): Promise<{ uid: number; source: Buffer } | undefined> {
  const uids = await clients.imap.searchHeader(rec.draftsFolder, "Message-ID", rec.draftMessageId);
  const uid = uids.at(-1);
  if (uid === undefined) return undefined;
  return { uid, source: await clients.imap.getSource(rec.draftsFolder, uid) };
}

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((x) => x.value.map((v) => v.address ?? "")).filter(Boolean);
}

/** Rebuild a sendable message from the draft (Bcc goes in the envelope, not the headers). */
async function toOutgoing(source: Buffer): Promise<OutgoingMessage> {
  const p = await simpleParser(source);
  const to = addresses(p.to);
  if (!to.length) throw new Error("The draft has no recipients");
  const refs = p.references;
  return {
    to,
    cc: addresses(p.cc),
    bcc: addresses(p.bcc),
    subject: p.subject ?? "",
    text: p.text || undefined,
    html: typeof p.html === "string" ? p.html : undefined,
    replyTo: p.replyTo?.text || undefined,
    inReplyTo: p.inReplyTo || undefined,
    references: refs ? (Array.isArray(refs) ? refs : [refs]) : undefined,
    attachments: p.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      contentBase64: a.content.toString("base64"),
      contentType: a.contentType,
    })),
  };
}
