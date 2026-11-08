/**
 * Admin API, /admin/v1 (docs/PLATFORM.md, openapi/admin-v1.json).
 *
 * Private interface only, service-token auth. Secrets are write-only: they
 * can be set or replaced, never read back. Breaking changes go to /admin/v2.
 */
import { randomBytes } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { ImapClient } from "../imap-client.js";
import { SmtpClient } from "../smtp-client.js";
import { buildInfo } from "../version.js";
import { PRESETS } from "../policy/capabilities.js";
import type { Platform } from "../engine.js";
import { secretName } from "../platform/runtime.js";
import { ApprovalError, type ApprovalPreview, type ApprovalRecord } from "../platform/approvals.js";
import { safeEqual, newClientToken } from "../platform/tokens.js";
import { isTenantId } from "../platform/ids.js";
import {
  DEFAULT_LIMITS,
  type ClientRecord,
  type MailboxRecord,
  type TenantLimits,
  type TenantRecord,
} from "../platform/tenants.js";

type Log = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
) => void;

export interface AdminDeps {
  token: string;
  tenantBaseUrl: string;
  platform: Platform;
  log: Log;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---- schemas ----

const objectId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "lowercase letters, digits, _ and -, max 32");
const host = z.string().min(1).max(253);
const port = z.number().int().min(1).max(65535);
const endpointIn = z.object({
  host,
  port,
  tls: z.boolean(),
  user: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});
const endpointPatch = endpointIn.partial();
const mailIn = z.object({
  defaultFrom: z.string().min(3).max(320),
  defaultFromName: z.string().max(200).optional(),
  signature: z.string().max(4000).optional(),
  draftsFolder: z.string().min(1).max(200).default("Drafts"),
  sentFolder: z.string().min(1).max(200).nullable().default("Sent"),
});
const caldavIn = z.object({
  url: z.url(),
  user: z.string().min(1),
  password: z.string().min(1).max(1024),
});

const limitsIn = z
  .object({
    maxMailboxes: z.number().int().min(0).max(1000),
    maxClients: z.number().int().min(0).max(10000),
    toolCallsPerDay: z.number().int().min(0).max(10_000_000),
    allowSend: z.boolean(),
    maxRecipientsPerSend: z.number().int().min(1).max(1000),
    auditRetentionDays: z.number().int().min(1).max(3650),
  })
  .partial();

const tenantCreate = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,62}$/)
    .optional(),
  limits: limitsIn.optional(),
});

const mailboxCreate = z.object({
  id: objectId,
  label: z.string().min(1).max(100),
  default: z.boolean().optional(),
  imap: endpointIn,
  smtp: endpointIn,
  mail: mailIn,
  caldav: caldavIn.optional(),
});

const mailboxPatch = z.object({
  label: z.string().min(1).max(100).optional(),
  default: z.boolean().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  imap: endpointPatch.optional(),
  smtp: endpointPatch.optional(),
  mail: mailIn.partial().optional(),
  caldav: caldavIn.nullable().optional(),
});

const mailboxTest = z.object({ imap: endpointIn, smtp: endpointIn });

const preset = z.enum(Object.keys(PRESETS) as [keyof typeof PRESETS, ...(keyof typeof PRESETS)[]]);
const clientCreate = z.object({
  id: objectId.optional(),
  name: z.string().min(1).max(100),
  type: z.string().min(1).max(40).default("generic"),
  preset: preset.default("read-draft"),
  accounts: z.array(objectId).max(1000).optional(),
  sendEnabled: z.boolean().default(false),
  sendMode: z.enum(["direct", "approval"]).default("direct"),
});
const clientPatch = z.object({
  name: z.string().min(1).max(100).optional(),
  preset: preset.optional(),
  accounts: z.array(objectId).max(1000).nullable().optional(),
  sendEnabled: z.boolean().optional(),
  sendMode: z.enum(["direct", "approval"]).optional(),
  paused: z.boolean().optional(),
});

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HttpError(
      400,
      "invalid_request",
      `${issue.path.join(".") || "body"}: ${issue.message}`,
    );
  }
  return r.data;
}

// ---- views (never include secrets or token hashes) ----

const mailboxView = (m: MailboxRecord) => ({
  id: m.id,
  label: m.label,
  default: Boolean(m.default),
  status: m.status,
  imap: { host: m.imap.host, port: m.imap.port, tls: m.imap.tls, user: m.imap.user },
  smtp: { host: m.smtp.host, port: m.smtp.port, tls: m.smtp.tls, user: m.smtp.user },
  mail: {
    ...m.mail,
    defaultFromName: m.mail.defaultFromName ?? null,
    signature: m.mail.signature ?? null,
  },
  caldav: m.caldav ? { url: m.caldav.url, user: m.caldav.user } : null,
  createdAt: m.createdAt,
});

const clientView = (c: ClientRecord) => ({
  id: c.id,
  name: c.name,
  type: c.type,
  preset: c.preset,
  accounts: c.accounts ?? null,
  sendEnabled: c.sendEnabled,
  sendMode: c.sendMode ?? "direct",
  paused: Boolean(c.paused),
  pausedAt: c.pausedAt ?? null,
  status: c.status,
  createdAt: c.createdAt,
  rotatedAt: c.rotatedAt ?? null,
  revokedAt: c.revokedAt ?? null,
});

const tenantView = (t: TenantRecord) => ({
  id: t.id,
  status: t.status,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  revision: t.revision,
  limits: t.limits,
  mailboxes: t.mailboxes.map(mailboxView),
  clients: t.clients.map(clientView),
});

// ---- app ----

export function createAdminApp(d: AdminDeps): Express {
  const { platform: p } = d;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
    if (!m || !safeEqual(m[1], d.token)) {
      res.status(401).json({ error: "unauthorized", message: "Missing or invalid service token" });
      return;
    }
    res.set("Cache-Control", "no-store");
    next();
  });

  const r = express.Router();
  const h =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).catch(next);
    };

  const store = () => {
    if (!p.tenants)
      throw new HttpError(
        409,
        "config_managed_externally",
        "Tenant config is managed by CONFIG_PROVIDER=http",
      );
    return p.tenants;
  };
  const tenantOr404 = async (id: string) => {
    const t = isTenantId(id) ? await p.config.getTenant(id) : undefined;
    if (!t) throw new HttpError(404, "not_found", "Tenant not found");
    return t;
  };
  const update = async (id: string, fn: (t: TenantRecord) => void) => {
    const t = await store().update(id, fn);
    if (!t) throw new HttpError(404, "not_found", "Tenant not found");
    p.config.invalidate(id);
    return t;
  };
  const endpointUrl = (tenantId: string) => `${d.tenantBaseUrl}/t/${tenantId}/mcp`;
  const now = () => new Date().toISOString();

  r.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  r.get("/version", (_req, res) => {
    res.json(buildInfo());
  });

  // tenants
  r.post(
    "/tenants",
    h(async (req, res) => {
      const body = parse(tenantCreate, req.body);
      const id = body.id ?? `t-${randomBytes(8).toString("hex")}`;
      const t: TenantRecord = {
        id,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
        revision: 1,
        limits: { ...DEFAULT_LIMITS, ...body.limits },
        mailboxes: [],
        clients: [],
      };
      if (!(await store().create(t))) throw new HttpError(409, "conflict", "Tenant already exists");
      d.log("info", "admin: tenant created", { tenantId: id });
      res.status(201).json(tenantView(t));
    }),
  );
  r.get(
    "/tenants/:id",
    h(async (req, res) => {
      res.json(tenantView(await tenantOr404(String(req.params.id))));
    }),
  );
  for (const [action, status] of [
    ["suspend", "suspended"],
    ["unsuspend", "active"],
  ] as const) {
    r.post(
      `/tenants/:id/${action}`,
      h(async (req, res) => {
        const t = await update(String(req.params.id), (t) => {
          t.status = status;
        });
        d.log("info", `admin: tenant ${action}ed`, { tenantId: t.id });
        res.json(tenantView(t));
      }),
    );
  }
  r.delete(
    "/tenants/:id",
    h(async (req, res) => {
      const id = String(req.params.id);
      await tenantOr404(id);
      // Purge order: connections + cached credentials, secrets (incl. data key), audit, record.
      await p.runtime.drop(id);
      await p.secrets.purgeTenant(id);
      await p.oauth?.purgeTenant(id);
      await p.audit.purgeTenant(id);
      await p.approvals.purgeTenant(id);
      await store().delete(id);
      p.config.invalidate(id);
      d.log("info", "admin: tenant deleted", { tenantId: id });
      res.status(204).end();
    }),
  );
  r.put(
    "/tenants/:id/limits",
    h(async (req, res) => {
      const limits = parse(limitsIn, req.body);
      const t = await update(String(req.params.id), (t) => {
        t.limits = { ...t.limits, ...limits } as TenantLimits;
      });
      await p.audit.applyRetention(t.id, t.limits.auditRetentionDays);
      res.json(tenantView(t));
    }),
  );

  // mailboxes
  r.get(
    "/tenants/:id/mailboxes",
    h(async (req, res) => {
      res.json({
        mailboxes: (await tenantOr404(String(req.params.id))).mailboxes.map(mailboxView),
      });
    }),
  );
  r.post(
    "/tenants/:id/mailboxes/test",
    h(async (req, res) => {
      await tenantOr404(String(req.params.id));
      const b = parse(mailboxTest, req.body);
      res.json(await testMailbox(b.imap, b.smtp));
    }),
  );
  r.post(
    "/tenants/:id/mailboxes",
    h(async (req, res) => {
      const id = String(req.params.id);
      const b = parse(mailboxCreate, req.body);
      const t0 = await tenantOr404(id);
      if (t0.mailboxes.some((m) => m.id === b.id))
        throw new HttpError(409, "conflict", "Mailbox already exists");
      if (t0.mailboxes.length >= t0.limits.maxMailboxes) {
        throw new HttpError(
          422,
          "limit_reached",
          `Mailbox limit (${t0.limits.maxMailboxes}) reached`,
        );
      }
      await p.secrets.put(id, secretName(b.id, "imap"), b.imap.password);
      await p.secrets.put(id, secretName(b.id, "smtp"), b.smtp.password);
      if (b.caldav) await p.secrets.put(id, secretName(b.id, "caldav"), b.caldav.password);
      const rec: MailboxRecord = {
        id: b.id,
        label: b.label,
        default: b.default,
        imap: { host: b.imap.host, port: b.imap.port, tls: b.imap.tls, user: b.imap.user },
        smtp: { host: b.smtp.host, port: b.smtp.port, tls: b.smtp.tls, user: b.smtp.user },
        mail: b.mail,
        caldav: b.caldav ? { url: b.caldav.url, user: b.caldav.user } : undefined,
        status: "active",
        createdAt: now(),
      };
      await update(id, (t) => {
        if (t.mailboxes.length >= t.limits.maxMailboxes) {
          throw new HttpError(
            422,
            "limit_reached",
            `Mailbox limit (${t.limits.maxMailboxes}) reached`,
          );
        }
        if (rec.default) t.mailboxes.forEach((m) => (m.default = false));
        t.mailboxes.push(rec);
      });
      res.status(201).json(mailboxView(rec));
    }),
  );
  r.patch(
    "/tenants/:id/mailboxes/:mid",
    h(async (req, res) => {
      const id = String(req.params.id);
      const mid = String(req.params.mid);
      const b = parse(mailboxPatch, req.body);
      const t0 = await tenantOr404(id);
      if (!t0.mailboxes.some((m) => m.id === mid))
        throw new HttpError(404, "not_found", "Mailbox not found");
      if (b.imap?.password) await p.secrets.put(id, secretName(mid, "imap"), b.imap.password);
      if (b.smtp?.password) await p.secrets.put(id, secretName(mid, "smtp"), b.smtp.password);
      if (b.caldav) await p.secrets.put(id, secretName(mid, "caldav"), b.caldav.password);
      if (b.caldav === null) await p.secrets.delete(id, secretName(mid, "caldav"));
      let view;
      await update(id, (t) => {
        const m = t.mailboxes.find((x) => x.id === mid)!;
        if (b.label !== undefined) m.label = b.label;
        if (b.status !== undefined) m.status = b.status;
        if (b.default) t.mailboxes.forEach((x) => (x.default = x.id === mid));
        else if (b.default === false) m.default = false;
        for (const k of ["imap", "smtp"] as const) {
          const e = b[k];
          if (e)
            m[k] = {
              host: e.host ?? m[k].host,
              port: e.port ?? m[k].port,
              tls: e.tls ?? m[k].tls,
              user: e.user ?? m[k].user,
            };
        }
        if (b.mail) m.mail = { ...m.mail, ...b.mail };
        if (b.caldav) m.caldav = { url: b.caldav.url, user: b.caldav.user };
        if (b.caldav === null) m.caldav = undefined;
        view = mailboxView(m);
      });
      res.json(view);
    }),
  );
  r.delete(
    "/tenants/:id/mailboxes/:mid",
    h(async (req, res) => {
      const id = String(req.params.id);
      const mid = String(req.params.mid);
      const t0 = await tenantOr404(id);
      if (!t0.mailboxes.some((m) => m.id === mid))
        throw new HttpError(404, "not_found", "Mailbox not found");
      await update(id, (t) => {
        t.mailboxes = t.mailboxes.filter((m) => m.id !== mid);
        for (const c of t.clients) if (c.accounts) c.accounts = c.accounts.filter((a) => a !== mid);
      });
      for (const k of ["imap", "smtp", "caldav"] as const)
        await p.secrets.delete(id, secretName(mid, k));
      res.status(204).end();
    }),
  );

  // clients
  r.get(
    "/tenants/:id/clients",
    h(async (req, res) => {
      res.json({ clients: (await tenantOr404(String(req.params.id))).clients.map(clientView) });
    }),
  );
  r.post(
    "/tenants/:id/clients",
    h(async (req, res) => {
      const id = String(req.params.id);
      const b = parse(clientCreate, req.body);
      const { token, hash } = newClientToken();
      const rec: ClientRecord = {
        id: b.id ?? `c-${randomBytes(4).toString("hex")}`,
        name: b.name,
        type: b.type,
        preset: b.preset,
        accounts: b.accounts,
        sendEnabled: b.sendEnabled,
        sendMode: b.sendMode,
        tokenHash: hash,
        status: "active",
        createdAt: now(),
      };
      await update(id, (t) => {
        if (t.clients.some((c) => c.id === rec.id))
          throw new HttpError(409, "conflict", "Client already exists");
        const active = t.clients.filter((c) => c.status === "active").length;
        if (active >= t.limits.maxClients) {
          throw new HttpError(
            422,
            "limit_reached",
            `Client limit (${t.limits.maxClients}) reached`,
          );
        }
        const unknown = rec.accounts?.filter((a) => !t.mailboxes.some((m) => m.id === a)) ?? [];
        if (unknown.length)
          throw new HttpError(400, "invalid_request", `Unknown mailbox: ${unknown[0]}`);
        t.clients.push(rec);
      });
      d.log("info", "admin: client created", { tenantId: id, clientId: rec.id });
      res.status(201).json({ client: clientView(rec), token, endpoint: endpointUrl(id) });
    }),
  );
  r.patch(
    "/tenants/:id/clients/:cid",
    h(async (req, res) => {
      const b = parse(clientPatch, req.body);
      let view;
      await update(String(req.params.id), (t) => {
        const c = t.clients.find((x) => x.id === req.params.cid);
        if (!c) throw new HttpError(404, "not_found", "Client not found");
        if (b.accounts) {
          const unknown = b.accounts.filter((a) => !t.mailboxes.some((m) => m.id === a));
          if (unknown.length)
            throw new HttpError(400, "invalid_request", `Unknown mailbox: ${unknown[0]}`);
        }
        if (b.name !== undefined) c.name = b.name;
        if (b.preset !== undefined) c.preset = b.preset;
        if (b.accounts !== undefined) c.accounts = b.accounts ?? undefined;
        if (b.sendEnabled !== undefined) c.sendEnabled = b.sendEnabled;
        if (b.sendMode !== undefined) c.sendMode = b.sendMode;
        if (b.paused !== undefined && b.paused !== Boolean(c.paused)) {
          c.paused = b.paused || undefined;
          c.pausedAt = b.paused ? now() : undefined;
        }
        view = clientView(c);
      });
      res.json(view);
    }),
  );
  r.post(
    "/tenants/:id/clients/:cid/revoke",
    h(async (req, res) => {
      let view;
      await update(String(req.params.id), (t) => {
        const c = t.clients.find((x) => x.id === req.params.cid);
        if (!c) throw new HttpError(404, "not_found", "Client not found");
        c.status = "revoked";
        c.revokedAt = now();
        view = clientView(c);
      });
      res.json(view);
    }),
  );
  r.post(
    "/tenants/:id/clients/:cid/rotate",
    h(async (req, res) => {
      const { token, hash } = newClientToken();
      let view;
      await update(String(req.params.id), (t) => {
        const c = t.clients.find((x) => x.id === req.params.cid);
        if (!c) throw new HttpError(404, "not_found", "Client not found");
        if (c.status !== "active") throw new HttpError(409, "conflict", "Client is revoked");
        c.tokenHash = hash;
        c.rotatedAt = now();
        view = clientView(c);
      });
      res.json({ client: view, token, endpoint: endpointUrl(String(req.params.id)) });
    }),
  );

  // approval queue ("ask me before sending")
  const approvalView = (a: ApprovalRecord, preview?: ApprovalPreview | null) => ({
    id: a.id,
    clientId: a.clientId,
    account: a.account,
    status: a.status,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    decidedAt: a.decidedAt ?? null,
    error: a.error ?? null,
    ...(preview !== undefined ? { preview } : {}),
  });
  /** The held message's mailbox connections (the client may since be revoked). */
  const approvalClients = async (t: TenantRecord, a: ApprovalRecord) => {
    const client = t.clients.find((c) => c.id === a.clientId) ?? t.clients[0];
    if (!client) throw new HttpError(409, "conflict", "The tenant has no clients");
    const ctx = await p.runtime.context(t, { ...client, accounts: undefined });
    try {
      return ctx.pool.for(a.account);
    } catch {
      throw new HttpError(409, "conflict", "The mailbox for this request no longer exists");
    }
  };
  const approvalOr404 = async (t: TenantRecord, aid: string) => {
    const a = await p.approvals.get(t.id, aid);
    if (!a) throw new HttpError(404, "not_found", "Approval request not found");
    return a;
  };
  r.get(
    "/tenants/:id/approvals",
    h(async (req, res) => {
      const t = await tenantOr404(String(req.params.id));
      const status = req.query.status === undefined ? undefined : String(req.query.status);
      if (status && !["pending", "approved", "rejected", "expired", "failed"].includes(status)) {
        throw new HttpError(400, "invalid_request", "Unknown status");
      }
      const list = (await p.approvals.list(t.id))
        .filter((a) => !status || a.status === status)
        .reverse();
      res.json({ approvals: list.map((a) => approvalView(a)) });
    }),
  );
  r.get(
    "/tenants/:id/approvals/:aid",
    h(async (req, res) => {
      const t = await tenantOr404(String(req.params.id));
      const a = await approvalOr404(t, String(req.params.aid));
      const preview =
        a.status === "pending"
          ? ((await p.approvals.preview(a, await approvalClients(t, a))) ?? null)
          : null;
      res.json(approvalView(a, preview));
    }),
  );
  for (const decision of ["approve", "reject"] as const) {
    r.post(
      `/tenants/:id/approvals/:aid/${decision}`,
      h(async (req, res) => {
        const t = await tenantOr404(String(req.params.id));
        const a = await approvalOr404(t, String(req.params.aid));
        if (decision === "approve" && (t.status !== "active" || !t.limits.allowSend)) {
          throw new HttpError(409, "conflict", "Sending isn't allowed for this tenant right now");
        }
        const started = Date.now();
        let done: ApprovalRecord;
        try {
          done = await p.approvals.decide(t.id, a.id, decision, await approvalClients(t, a));
        } catch (err) {
          if (err instanceof ApprovalError) throw new HttpError(err.status, err.code, err.message);
          throw err;
        }
        await p.audit
          .record({
            ts: new Date().toISOString(),
            tenantId: t.id,
            clientId: a.clientId,
            tool: "send_message",
            account: a.account,
            result: decision === "approve" ? "ok" : "denied",
            reason: decision === "approve" ? "approved-by-owner" : "rejected-by-owner",
            durationMs: Date.now() - started,
          })
          .catch(() => {});
        res.json(approvalView(done));
      }),
    );
  }

  // audit + usage
  r.get(
    "/tenants/:id/audit",
    h(async (req, res) => {
      const t = await tenantOr404(String(req.params.id));
      const q = req.query;
      const limit = q.limit ? Number(q.limit) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
        throw new HttpError(400, "invalid_request", "limit must be 1-500");
      }
      res.json(
        await p.audit.query(t.id, {
          clientId: typeof q.client === "string" ? q.client : undefined,
          cursor: typeof q.cursor === "string" ? q.cursor : undefined,
          limit,
        }),
      );
    }),
  );
  r.get(
    "/tenants/:id/usage",
    h(async (req, res) => {
      const t = await tenantOr404(String(req.params.id));
      const days = await p.audit.usageFor(t.id);
      res.json({ today: await p.audit.callsToday(t.id), limit: t.limits.toolCallsPerDay, days });
    }),
  );

  app.use("/admin/v1", r);
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "Unknown admin endpoint" });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "invalid_request", message: "Malformed JSON body" });
      return;
    }
    d.log("error", "admin request failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "internal_error", message: "Internal error" });
  });
  return app;
}

type EndpointIn = z.infer<typeof endpointIn>;

/** Connect and authenticate without saving anything. Errors never echo credentials. */
async function testMailbox(imap: EndpointIn, smtp: EndpointIn) {
  const scrub = (msg: string) =>
    msg.split(imap.password).join("***").split(smtp.password).join("***").slice(0, 300);
  const result: { imap: { ok: boolean; error?: string }; smtp: { ok: boolean; error?: string } } = {
    imap: { ok: false },
    smtp: { ok: false },
  };
  const ic = new ImapClient({
    host: imap.host,
    port: imap.port,
    user: imap.user,
    pass: imap.password,
    secure: imap.tls,
  });
  try {
    await ic.listMailboxes();
    result.imap.ok = true;
  } catch (err) {
    result.imap.error = scrub(err instanceof Error ? err.message : String(err));
  } finally {
    await ic.close().catch(() => {});
  }
  const sc = new SmtpClient(
    { host: smtp.host, port: smtp.port, user: smtp.user, pass: smtp.password, secure: smtp.tls },
    { from: smtp.user },
  );
  try {
    await sc.verify();
    result.smtp.ok = true;
  } catch (err) {
    result.smtp.error = scrub(err instanceof Error ? err.message : String(err));
  }
  return result;
}
