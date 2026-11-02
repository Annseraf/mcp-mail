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

import type { AccountsStore } from "./accounts.js";
import type { ClientPool } from "./client-pool.js";
import { buildMcpServer } from "./mcp-server.js";
import { buildInfo } from "./version.js";
import { createAdminApp } from "./admin/api.js";
import { AuditLog } from "./platform/audit.js";
import { OciKmsKeyProvider } from "./platform/oci-kms.js";
import { guardTools, TenantRuntime, type TenantContext } from "./platform/runtime.js";
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
  accountsFile: string;
  store: AccountsStore;
  pool: ClientPool;
  platform: PlatformSettings;
  log: Log;
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
  const bearerAuth = (req: Request, res: Response, next: NextFunction): void => {
    const match = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
    if (!match || !tokenMatches(match[1])) {
      log("warn", "rejected unauthenticated MCP request", { ip: req.ip, path: req.path });
      res.status(401).json({ error: "unauthorized", message: "Missing or invalid Bearer token" });
      return;
    }
    next();
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
  app.post(
    "/mcp",
    bearerAuth,
    mcpEndpoint(() => buildMcpServer(o.version, o.pool, o.store)),
  );

  // ---- multi-tenant ----
  let platform: Platform | undefined;
  let admin: Express | undefined;
  if (o.platform.multiTenant) {
    platform = await buildPlatform(o);
    const p = platform;
    const tenantEndpoint = mcpEndpoint((authInfo) => {
      const ctx = authInfo?.extra?.tenant as TenantContext;
      return buildMcpServer(o.version, ctx.pool, ctx.accounts, (server) =>
        guardTools(server, ctx, p.audit),
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
