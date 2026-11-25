import { appendFile, mkdtemp, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AuditLog, type AuditEntry } from "../../src/platform/audit.js";

it("counts a bounded UTC day across a busy history and fails closed on coverage loss", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "audit-daily-"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2024-01-01T23:59:59Z"));
  const audit = new AuditLog(dir);
  const entry = (
    tenantId: string,
    ts: string,
    result: AuditEntry["result"] = "denied",
    reason?: string,
  ) => ({ tenantId, ts, result, reason, clientId: "reader", tool: "synthetic", durationMs: 0 });
  try {
    const absent = { day: "2024-01-02", complete: false, counts: null };
    expect(await audit.daily("missing", "2024-01-02")).toEqual(absent);
    await expect(audit.daily("alpha", "2024-02-30")).rejects.toThrow(RangeError);
    await expect(audit.daily("alpha", "2999-01-01")).rejects.toThrow(RangeError);
    await audit.record(entry("alpha", "2024-01-01T23:59:59Z"));
    await audit.record(entry("beta", "2024-01-01T23:59:59Z"));
    clock.mockReturnValue(Date.parse("2024-01-02T00:00:00Z"));
    await audit.record(entry("alpha", "2024-01-02T00:00:00Z"));
    await audit.record(entry("alpha", "2024-01-02T23:59:59.999Z", "ok", "awaiting-approval"));
    await audit.record(entry("beta", "2024-01-02T10:00:00Z", "error"));
    clock.mockReturnValue(Date.parse("2024-01-03T00:00:00Z"));
    await Promise.all(
      Array.from({ length: 501 }, () => audit.record(entry("alpha", "2024-01-03T00:00:00Z"))),
    );
    expect(await audit.daily("alpha", "2024-01-02")).toEqual({
      day: "2024-01-02",
      complete: true,
      counts: { ok: 0, denied: 1, errors: 0, waiting: 1 },
    });
    expect(await audit.daily("beta", "2024-01-02")).toMatchObject({
      complete: true,
      counts: { ok: 0, denied: 0, errors: 1, waiting: 0 },
    });
    expect(await new AuditLog(dir).daily("alpha", "2024-01-02")).toEqual(absent);
    await appendFile(path.join(dir, "alpha.jsonl"), '{"partial":');
    expect(await audit.daily("alpha", "2024-01-02")).toEqual(absent);
    await truncate(path.join(dir, "alpha.jsonl"), 0);
    expect(await audit.daily("alpha", "2024-01-02")).toEqual(absent);
    await audit.applyRetention("beta", 0);
    expect(await audit.daily("beta", "2024-01-02")).toEqual(absent);
  } finally {
    clock.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
