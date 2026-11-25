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
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly coverage = new Map<string, { since: number; stamp: string }>();

  private async exclusive<T>(tenant: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(tenant) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.operations.set(tenant, pending);
    try {
      return await pending;
    } finally {
      if (this.operations.get(tenant) === pending) this.operations.delete(tenant);
    }
  }

  private async stamp(file: string): Promise<string> {
    const files = await Promise.all(
      [file, `${file}.1`].map(async (name) => {
        try {
          const stat = await fs.stat(name, { bigint: true });
          return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "-";
          throw error;
        }
      }),
    );
    return files.join("/");
  }

  /** The window must be one complete UTC day. Counts cover only retained events. */
  async daily(t: string, day: string) {
    const start = Date.parse(`${day}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(start) ||
      today(new Date(start)) !== day ||
      day >= today()
    ) {
      throw new RangeError("Expected a complete UTC day (YYYY-MM-DD)");
    }
    const end = start + 86_400_000;
    return this.exclusive(t, async () => {
      const file = this.logFile(t);
      const counts = { ok: 0, denied: 0, errors: 0, waiting: 0 };
      const observed = this.coverage.get(t);
      let complete = false;
      try {
        const before = await this.stamp(file);
        complete = !!observed && observed.since <= start && observed.stamp === before;
        for (const name of [file, `${file}.1`]) {
          let raw: string;
          try {
            raw = await fs.readFile(name, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (raw && !raw.endsWith("\n")) complete = false;
          for (const line of raw.split("\n").filter(Boolean)) {
            let entry: AuditEntry;
            try {
              entry = JSON.parse(line);
            } catch {
              complete = false;
              continue;
            }
            const at = Date.parse(entry?.ts);
            if (
              entry?.tenantId !== t ||
              !Number.isFinite(at) ||
              !["ok", "denied", "error"].includes(entry.result)
            ) {
              complete = false;
              continue;
            }
            if (at < start || at >= end) continue;
            if (entry.result === "denied") counts.denied++;
            else if (entry.result === "error") counts.errors++;
            else if (entry.reason === "awaiting-approval") counts.waiting++;
            else counts.ok++;
          }
        }
        complete = complete && before === (await this.stamp(file));
      } catch {
        complete = false;
      }
      return { day, complete, counts: complete ? counts : null };
    });
  }

  private readonly usage = new Map<string, UsageFile>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();

  /**
   * @param dir Directory holding `<tenant>.jsonl` files.
   * @param singleFile Single-tenant mode: one log file for everything (e.g. /var/log/mcp-mail/audit.jsonl).
   */
  constructor(
    private readonly dir: string,
    private readonly singleFile?: string,
  ) {}

  private logFile(t: string) {
    return this.singleFile ?? path.join(this.dir, `${assertTenantId(t)}.jsonl`);
  }
  private usageFile(t: string) {
    return this.singleFile
      ? `${this.singleFile}.usage.json`
      : path.join(this.dir, `${assertTenantId(t)}.usage.json`);
  }

  async record(e: AuditEntry): Promise<void> {
    await this.exclusive(e.tenantId, async () => {
      const file = this.logFile(e.tenantId);
      const observed = this.coverage.get(e.tenantId);
      // Any failed operation or unrecognized prior file state leaves coverage unknown.
      this.coverage.delete(e.tenantId);
      const stamp = await this.stamp(file);
      let since = observed?.stamp === stamp ? observed.since : Date.now();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        const st = await fs.stat(file);
        if (st.size > MAX_BYTES) {
          await fs.rename(file, `${file}.1`);
          since = Date.now();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.appendFile(file, JSON.stringify(e) + "\n", { mode: 0o600 });
      this.coverage.set(e.tenantId, { since, stamp: await this.stamp(file) });
      if (e.result !== "denied") await this.count(e.tenantId, e.clientId);
    });
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
    await this.exclusive(t, async () => {
      this.coverage.delete(t);
      const timer = this.flushTimers.get(t);
      if (timer) clearTimeout(timer);
      this.flushTimers.delete(t);
      this.usage.delete(t);
      await Promise.all([
        removeFile(this.logFile(t)),
        removeFile(`${this.logFile(t)}.1`),
        removeFile(this.usageFile(t)),
      ]);
    });
  }

  /** Drop entries older than `days` (applied by the admin API's retention setting). */
  async applyRetention(t: string, days: number): Promise<void> {
    await this.exclusive(t, async () => {
      this.coverage.delete(t);
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
    });
  }
}

/** Audit sink that writes JSONL to stdout (journald/docker logs). */
export class StdoutAudit {
  async record(e: AuditEntry): Promise<void> {
    process.stdout.write(JSON.stringify({ audit: true, ...e }) + "\n");
  }
}

export type AuditSink = Pick<AuditLog, "record">;
