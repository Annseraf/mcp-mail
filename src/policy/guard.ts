/**
 * Per-client policy enforcement, shared by single-tenant clients.json and
 * multi-tenant clients. Two layers: tools a client may not use are never
 * registered (absent from tools/list), and every call is checked again at
 * dispatch. Every call is audited when a sink is configured.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { AuditEntry, AuditSink } from "../platform/audit.js";
import { capabilityOf, type Capability } from "./capabilities.js";

export interface ClientPolicy {
  id: string;
  capabilities: ReadonlySet<Capability>;
  allowTools?: ReadonlySet<string>;
  denyTools?: ReadonlySet<string>;
  /** Account ids this client may use; undefined = all. */
  accounts?: readonly string[];
  /** Recipients must match an address or an `@domain` entry. */
  sendRecipientAllowlist?: readonly string[];
  /** Max send_message calls per rolling hour. */
  sendRateLimitPerHour?: number;
}

export interface Denial {
  reason: string;
  text: string;
}

export function toolAllowed(
  p: ClientPolicy,
  tool: string,
  args?: Record<string, unknown>,
): boolean {
  if (p.denyTools?.has(tool)) return false;
  if (p.allowTools?.has(tool)) return true;
  return p.capabilities.has(capabilityOf(tool, args));
}

export function recipientsOf(args: Record<string, unknown>): string[] {
  const list = (v: unknown) =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : [];
  return [...list(args.to), ...list(args.cc), ...list(args.bcc)];
}

/** Extract the bare address from "Name <a@b>" forms. */
const address = (r: string) => (/<([^>]+)>/.exec(r)?.[1] ?? r).trim().toLowerCase();

export function recipientAllowed(allow: readonly string[], recipient: string): boolean {
  const a = address(recipient);
  return allow.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e.startsWith("@") ? a.endsWith(e) : a === e;
  });
}

const sendWindows = new Map<string, number[]>();

function rateLimited(key: string, perHour: number): boolean {
  const now = Date.now();
  const w = (sendWindows.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (w.length >= perHour) {
    sendWindows.set(key, w);
    return true;
  }
  w.push(now);
  sendWindows.set(key, w);
  return false;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface GuardOptions {
  policy: ClientPolicy;
  /** Extra checks run after the capability check (tenant suspension, limits, send toggles). */
  check?: (tool: string, args: Record<string, unknown>) => Promise<Denial | undefined>;
  audit?: { log: AuditSink; tenantId: string };
  /** Key for in-memory rate limits; defaults to the client id. */
  rateKey?: string;
}

export function guardTools(server: McpServer, o: GuardOptions): void {
  const { policy } = o;
  const original = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  const record = async (e: Omit<AuditEntry, "tenantId" | "clientId">) => {
    if (o.audit)
      await o.audit.log
        .record({ ...e, tenantId: o.audit.tenantId, clientId: policy.id })
        .catch(() => {});
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as unknown as { registerTool: (...a: any[]) => unknown }).registerTool = (
    name: string,
    config: unknown,
    cb: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>,
  ) => {
    if (!toolAllowed(policy, name)) return undefined;
    return original(name, config, async (args: Record<string, unknown>, extra: unknown) => {
      const started = Date.now();
      const isSend = capabilityOf(name, args) === "send";
      const recipients = isSend ? recipientsOf(args) : [];
      const base = {
        ts: new Date().toISOString(),
        tool: name,
        account: typeof args.account === "string" ? args.account : undefined,
        mailbox: typeof args.mailbox === "string" ? args.mailbox : undefined,
        uid: typeof args.uid === "number" ? args.uid : undefined,
        recipients: isSend ? recipients.length : undefined,
      };
      const deny = async (d: Denial): Promise<ToolResult> => {
        await record({
          ...base,
          result: "denied",
          reason: d.reason,
          durationMs: Date.now() - started,
        });
        return { content: [{ type: "text", text: d.text }], isError: true };
      };

      if (!toolAllowed(policy, name, args)) {
        return deny({
          reason: "capability",
          text:
            name === "delete_message" && args.permanent === true
              ? "Permanent deletion is not allowed for this client. Omit `permanent` to move the message to Trash."
              : `This client is not allowed to use ${name}.`,
        });
      }
      const extraDenial = await o.check?.(name, args);
      if (extraDenial) return deny(extraDenial);
      if (isSend && policy.sendRecipientAllowlist) {
        const blocked = recipients.filter(
          (r) => !recipientAllowed(policy.sendRecipientAllowlist!, r),
        );
        if (blocked.length) {
          return deny({
            reason: "recipient-not-allowed",
            text: `Sending to ${blocked.length} recipient(s) is not allowed for this client.`,
          });
        }
      }
      if (
        isSend &&
        policy.sendRateLimitPerHour !== undefined &&
        rateLimited(o.rateKey ?? policy.id, policy.sendRateLimitPerHour)
      ) {
        return deny({
          reason: "send-rate-limit",
          text: `Send limit reached (${policy.sendRateLimitPerHour} per hour). Try again later.`,
        });
      }

      try {
        const result = await cb(args, extra);
        await record({
          ...base,
          result: result?.isError ? "error" : "ok",
          durationMs: Date.now() - started,
        });
        return result;
      } catch (err) {
        await record({ ...base, result: "error", durationMs: Date.now() - started });
        throw err;
      }
    });
  };
}
