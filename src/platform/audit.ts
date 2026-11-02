/**
 * Per-tenant audit log and usage counters.
 *
 * One JSONL line per tool call. Never logs message bodies, subjects,
 * attachments, passwords or tokens: only who did what, to which account and
 * message, and how it went.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJson, removeFile, writeFileAtomic } from "./fsutil.js";
import { assertTenantId } from "./ids.js";

export interface AuditEntry {
  ts: string;
  tenantId: string;
  clientId: string;
  tool: string;
  account?: string;
  mailbox?: string;
  uid?: number;
  recipients?: number;
  result: "ok" | "denied" | "error";
  reason?: string;
  durationMs: number;
}

export interface AuditQuery {
  clientId?: string;
  /** Opaque cursor from a previous page. */
  cursor?: string;
  limit?: number;
}

interface UsageFile {
  days: Record<string, { total: number; byClient: Record<string, number> }>;
}

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_DAYS = 35;

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

export class AuditLog {
  private readonly usage = new Map<string, UsageFile>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly dir: string) {}

  private logFile(t: string) {
    return path.join(this.dir, `${assertTenantId(t)}.jsonl`);
  }
  private usageFile(t: string) {
    return path.join(this.dir, `${assertTenantId(t)}.usage.json`);
  }

  async record(e: AuditEntry): Promise<void> {
    const file = this.logFile(e.tenantId);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const st = await fs.stat(file);
      if (st.size > MAX_BYTES) await fs.rename(file, `${file}.1`);
    } catch {
      /* first write */
    }
    await fs.appendFile(file, JSON.stringify(e) + "\n", { mode: 0o600 });
    if (e.result !== "denied") await this.count(e.tenantId, e.clientId);
  }

  private async loadUsage(t: string): Promise<UsageFile> {
    let u = this.usage.get(t);
    if (!u) {
      u = (await readJson<UsageFile>(this.usageFile(t))) ?? { days: {} };
      this.usage.set(t, u);
    }
    return u;
  }

  private async count(t: string, clientId: string): Promise<void> {
    const u = await this.loadUsage(t);
    const d = (u.days[today()] ??= { total: 0, byClient: {} });
    d.total += 1;
    d.byClient[clientId] = (d.byClient[clientId] ?? 0) + 1;
    const days = Object.keys(u.days).sort();
    for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete u.days[old];
    if (!this.flushTimers.has(t)) {
      this.flushTimers.set(
        t,
        setTimeout(() => {
          this.flushTimers.delete(t);
          void writeFileAtomic(this.usageFile(t), JSON.stringify(u)).catch(() => {});
        }, 1000).unref(),
      );
    }
  }

  async callsToday(t: string): Promise<number> {
    return (await this.loadUsage(t)).days[today()]?.total ?? 0;
  }

  async usageFor(t: string): Promise<UsageFile["days"]> {
    return (await this.loadUsage(t)).days;
  }

  /** Newest first. The cursor is the line offset from the end (opaque to callers). */
  async query(
    t: string,
    q: AuditQuery = {},
  ): Promise<{ entries: AuditEntry[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const skip = q.cursor
      ? Number.parseInt(Buffer.from(q.cursor, "base64url").toString(), 10) || 0
      : 0;
    const lines: string[] = [];
    for (const f of [this.logFile(t), `${this.logFile(t)}.1`]) {
      try {
        lines.push(...(await fs.readFile(f, "utf8")).split("\n").filter(Boolean).reverse());
      } catch {
        /* missing */
      }
    }
    let all = lines.map((l) => JSON.parse(l) as AuditEntry);
    if (q.clientId) all = all.filter((e) => e.clientId === q.clientId);
    const page = all.slice(skip, skip + limit);
    const more = skip + limit < all.length;
    return {
      entries: page,
      nextCursor: more ? Buffer.from(String(skip + limit)).toString("base64url") : undefined,
    };
  }

  async purgeTenant(t: string): Promise<void> {
    const timer = this.flushTimers.get(t);
    if (timer) clearTimeout(timer);
    this.flushTimers.delete(t);
    this.usage.delete(t);
    await Promise.all([
      removeFile(this.logFile(t)),
      removeFile(`${this.logFile(t)}.1`),
      removeFile(this.usageFile(t)),
    ]);
  }

  /** Drop entries older than `days` (applied by the admin API's retention setting). */
  async applyRetention(t: string, days: number): Promise<void> {
    const cutoff = Date.now() - days * 86_400_000;
    const file = this.logFile(t);
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      return;
    }
    const kept = text
      .split("\n")
      .filter(Boolean)
      .filter((l) => Date.parse((JSON.parse(l) as AuditEntry).ts) >= cutoff);
    await writeFileAtomic(file, kept.length ? kept.join("\n") + "\n" : "");
    await removeFile(`${file}.1`);
  }
}
