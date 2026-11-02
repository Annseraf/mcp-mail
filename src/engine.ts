/**
 * Assembles the HTTP surface. Single-tenant routes (/health, /mcp) behave
 * exactly like v0.2.x; /version is public; multi-tenant routes
 * (/t/<tenantId>/mcp) and the admin API exist only when enabled.
 */
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { Server } from "node:http";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  createMcpHandler,
  isLegacyRequest,
  type AuthInfo,
  type McpServer,
} from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";

import { StaticAccounts, type AccountsStore } from "./accounts.js";
import type { ClientPool, PoolLike } from "./client-pool.js";
import { OAuthServer } from "./auth/oauth.js";
import { OverlayAccountSettings, type AccountSettingsWriter } from "./account-settings.js";
import type { AuthSettings } from "./auth/settings.js";
import { ClientsStore, type Identity } from "./policy/clients-file.js";
import { guardTools, type ClientPolicy } from "./policy/guard.js";
import { buildMcpServer } from "./mcp-server.js";
import { buildInfo } from "./version.js";
import { createAdminApp } from "./admin/api.js";
import { AuditLog, StdoutAudit, type AuditSink } from "./platform/audit.js";
import { OciKmsKeyProvider } from "./platform/oci-kms.js";
import { guardTenantTools, TenantRuntime, type TenantContext } from "./platform/runtime.js";
import {
  EnvelopeFileSecretStore,
  LocalKeyFileProvider,
  type KeyProvider,
  type SecretStore,
} from "./platform/secrets.js";
import type { PlatformSettings } from "./platform/settings.js";
import {
  FileTenantStore,
  HttpConfigProvider,
  StoreConfigProvider,
  type ConfigProvider,
} from "./platform/tenants.js";

export type Log = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
) => void;

export interface EngineOptions {
  version: string;
  authToken: string;
  /** Public origin (PUBLIC_URL), used as the OAuth issuer. */
  publicUrl?: string;
  accountsFile: string;
  store: AccountsStore;
  pool: ClientPool;
  platform: PlatformSettings;
  log: Log;
  /** Client identities, OAuth and auditing for /mcp (docs/CLIENTS.md). */
  auth?: AuthSettings;
  /** Tests inject these; production builds them from settings. */
  keyProvider?: KeyProvider;
  fetchImpl?: typeof fetch;
}

export interface Platform {
  tenants?: FileTenantStore;
  config: ConfigProvider;
  secrets: SecretStore;
  audit: AuditLog;
  runtime: TenantRuntime;
}

export interface Engine {
  app: Express;
  oauth?: OAuthServer;
  clients?: ClientsStore;
  admin?: Express;
  platform?: Platform;
  close(): Promise<void>;
}

const jsonError = (res: Response, status: number, error: string, message: string) =>
  res.status(status).json({ error, message });

async function buildPlatform(o: EngineOptions): Promise<Platform> {
  const s = o.platform;
  const keys =
    o.keyProvider ??
    (s.keyProvider === "oci"
      ? await OciKmsKeyProvider.fromEnv()
      : await LocalKeyFileProvider.load(s.keyFile));
  const secrets = new EnvelopeFileSecretStore(path.join(s.dataDir, "secrets"), keys);
  const audit = new AuditLog(path.join(s.dataDir, "audit"));
  let tenants: FileTenantStore | undefined;
  let config: ConfigProvider;
  if (s.configProvider === "http") {
    config = new HttpConfigProvider(
      s.configProviderUrl!,
      s.configProviderToken!,
      s.configCacheTtlMs,
      o.fetchImpl,
    );
  } else {
    tenants = new FileTenantStore(path.join(s.dataDir, "tenants"));
    config = new StoreConfigProvider(tenants);
  }
  return {
    tenants,
    config,
    secrets,
    audit,
    runtime: new TenantRuntime(config, secrets, audit, o.log),
  };
}

export async function createEngine(o: EngineOptions): Promise<Engine> {
  const { log } = o;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "5mb" }));

  // ---- single-tenant (v0.2.x compatible) ----
  const expectedToken = Buffer.from(o.authToken);
  const tokenMatches = (candidate: string) => {
    const given = Buffer.from(candidate);
    return given.length === expectedToken.length && timingSafeEqual(given, expectedToken);
  };
  const authSettings = o.auth ?? {
    clientsFile: path.join(path.dirname(o.accountsFile), "clients.json"),
  };
  const clients = new ClientsStore(authSettings.clientsFile);
  const oauth = authSettings.oauth
    ? new OAuthServer({
        publicUrl: o.publicUrl ?? "http://localhost:3220",
        ...authSettings.oauth,
        log,
      })
    : undefined;
  const audit: AuditSink | undefined =
    authSettings.auditLog === "stdout"
      ? new StdoutAudit()
      : authSettings.auditLog
        ? new AuditLog(path.dirname(authSettings.auditLog), authSettings.auditLog)
        : undefined;
  if (oauth) app.use(oauth.router());

  let warnedLegacy = false;
  const unauthorized = (req: Request, res: Response) => {
    log("warn", "rejected unauthenticated MCP request", { ip: req.ip, path: req.path });
    if (oauth) res.set("WWW-Authenticate", oauth.challenge());
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid Bearer token" });
  };

  /**
   * Resolve who is calling: the shared AUTH_TOKEN (built-in "legacy" client),
   * an OAuth access token, or a static client token from clients.json; then
   * attach the client's policy. Without clients.json, OAuth or AUDIT_LOG the
   * request is served exactly like v0.2.x.
   */
  const clientAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const match = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
    if (!match) return unauthorized(req, res);
    const token = match[1];
    let identity: Identity | undefined;
    if (tokenMatches(token)) {
      identity = { kind: "legacy" };
    } else if (oauth) {
      const grant = await oauth.verifyAccessToken(token);
      if (grant)
        identity = {
          kind: "oauth",
          user: grant.user,
          clientId: grant.clientId,
          issuedAt: grant.issuedAt,
        };
    }
    identity ??= { kind: "token", token };
    let resolution;
    try {
      resolution = await clients.resolve(identity);
    } catch (err) {
      log("error", "clients.json could not be loaded", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ error: "unavailable", message: "Client configuration is invalid" });
      return;
    }
    if ("rejected" in resolution) return unauthorized(req, res);
    const hasClientsFile = (await clients.load()) !== undefined;
    if (identity.kind === "legacy" && hasClientsFile && !warnedLegacy) {
      warnedLegacy = true;
      log(
        "warn",
        "request used the shared AUTH_TOKEN; consider per-client tokens (mcp-mail clients add)",
      );
    }
    (req as Request & { auth?: AuthInfo }).auth = {
      token: "",
      clientId: resolution.policy.id,
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { policy: resolution.policy, guarded: hasClientsFile || audit !== undefined },
    };
    next();
  };

  const accountSettings = o.store.overlayFile ? new OverlayAccountSettings(o.store) : undefined;
  const singleTenantServer = (authInfo?: AuthInfo): McpServer => {
    const policy = authInfo?.extra?.policy as ClientPolicy | undefined;
    if (!policy || !authInfo?.extra?.guarded) {
      return buildMcpServer(o.version, o.pool, o.store, undefined, { settings: accountSettings });
    }
    const accounts = policy.accounts
      ? new StaticAccounts(o.store.list().filter((a) => policy.accounts!.includes(a.id)))
      : o.store;
    const pool: PoolLike = policy.accounts
      ? { for: (id?: string) => o.pool.for(accounts.resolve(id).id) }
      : o.pool;
    return buildMcpServer(
      o.version,
      pool,
      accounts,
      (server) =>
        guardTools(server, {
          policy,
          audit: audit ? { log: audit, tenantId: "local" } : undefined,
        }),
      { settings: accountSettings },
    );
  };

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "claude-mail-mcp",
      version: o.version,
      accounts: o.store.publicSummaries(),
      accounts_file: o.accountsFile,
    });
  });

  app.get("/version", (_req, res) => {
    res.set("Cache-Control", "no-store").json(buildInfo());
  });

  /**
   * One MCP endpoint, two protocol eras, a fresh McpServer per request:
   * - 2026-07-28 requests (per-request _meta) go to the SDK's strict handler.
   * - 2025-era requests (initialize, no _meta) get exactly the v0.2.x
   *   transport: stateless, plain JSON responses (no SSE).
   */
  const mcpEndpoint = (factory: (auth?: AuthInfo) => McpServer) => {
    const modern = toNodeHandler(
      createMcpHandler(({ authInfo }) => factory(authInfo), {
        legacy: "reject",
        responseMode: "json",
      }),
    );
    const handle = async (req: Request & { auth?: AuthInfo }, res: Response) => {
      if (await isLegacyRequest(await toWebRequest(req, req.body), req.body)) {
        const server = factory(req.auth);
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      await modern(req, res, req.body);
    };
    return (req: Request, res: Response) => {
      handle(req, res).catch((err: unknown) => {
        log("error", "MCP request failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          jsonError(
            res,
            500,
            "internal_error",
            err instanceof Error ? err.message : "Unknown error",
          );
        }
      });
    };
  };
  const singleEndpoint = mcpEndpoint(singleTenantServer);
  app.post(
    "/mcp",
    (req, res, next) => {
      clientAuth(req, res, next).catch(next);
    },
    singleEndpoint,
  );

  // ---- multi-tenant ----
  let platform: Platform | undefined;
  let admin: Express | undefined;
  if (o.platform.multiTenant) {
    platform = await buildPlatform(o);
    const p = platform;
    const tenantEndpoint = mcpEndpoint((authInfo) => {
      const ctx = authInfo?.extra?.tenant as TenantContext;
      // Agents can change a mailbox's sender name and signature in the tenant record.
      const settings: AccountSettingsWriter | undefined = p.tenants
        ? {
            update: async (accountId, patch) => {
              const id = ctx.accounts.resolve(accountId).id;
              await p.tenants!.update(ctx.tenant.id, (t) => {
                const m = t.mailboxes.find((x) => x.id === id);
                if (!m) throw new Error("Mailbox not found");
                if (patch.fromName !== undefined)
                  m.mail.defaultFromName = patch.fromName ?? undefined;
                if (patch.signature !== undefined) m.mail.signature = patch.signature ?? undefined;
              });
              p.config.invalidate(ctx.tenant.id);
              return id;
            },
          }
        : undefined;
      return buildMcpServer(
        o.version,
        ctx.pool,
        ctx.accounts,
        (server) => guardTenantTools(server, ctx, p.audit),
        { settings },
      );
    });
    app.post("/t/:tenantId/mcp", async (req, res) => {
      const match = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
      const tenantId = String(req.params.tenantId);
      let auth;
      try {
        auth = match ? await p.runtime.authenticate(tenantId, match[1]) : undefined;
      } catch (err) {
        log("error", "tenant lookup failed", {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        jsonError(res, 503, "unavailable", "Configuration temporarily unavailable");
        return;
      }
      if (!auth) {
        // Same answer for unknown tenants and bad tokens: nothing to enumerate.
        res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
        jsonError(res, 401, "unauthorized", "Missing or invalid Bearer token");
        return;
      }
      const ctx = await p.runtime.context(auth.tenant, auth.client);
      (req as Request & { auth?: unknown }).auth = {
        token: "",
        clientId: auth.client.id,
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        extra: { tenant: ctx },
      };
      tenantEndpoint(req, res);
    });

    if (o.platform.adminApi) {
      admin = createAdminApp({
        token: o.platform.adminToken!,
        tenantBaseUrl: o.platform.tenantBaseUrl,
        platform: p,
        log,
      });
    }
  }

  app.use((req, res) => {
    jsonError(
      res,
      404,
      "not_found",
      `${req.method} ${req.path} is not a valid endpoint. Use GET /health or POST /mcp.`,
    );
  });

  return {
    app,
    oauth,
    clients,
    admin,
    platform,
    async close() {
      await platform?.runtime.closeAll();
    },
  };
}

/** Listen and resolve once bound. */
export function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}
