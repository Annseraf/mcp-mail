/**
 * OAuth 2.1 for tenant endpoints (TENANT_OAUTH=true, docs/PLATFORM.md).
 *
 * Each tenant gets its own issuer, https://<connect host>/t/<tenant>/, so
 * clients such as Claude.ai and ChatGPT can connect with a browser sign-in.
 * The engine has no user accounts: /authorize hands the login to the
 * product (OAUTH_DELEGATE_URL), which signs the user in, picks or creates
 * the tenant's agent client, and redirects back with an HMAC signature.
 *
 * Isolation: every tenant has its own token key (HMAC of the master secret
 * and tenant id), state file and resource URL, so a token for tenant A
 * never verifies on tenant B.
 */
import { createHmac } from "node:crypto";
import path from "node:path";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { removeFile } from "../platform/fsutil.js";
import { isTenantId } from "../platform/ids.js";
import type { ClientRecord, ConfigProvider, TenantRecord } from "../platform/tenants.js";
import { DEFAULT_REDIRECT_URIS, OAuthServer } from "./oauth.js";

export interface TenantOAuthOptions {
  tokenSecretHex: string;
  delegateUrl: string;
  delegateSecret: string;
  allowedRedirectUris?: string[];
  dataDir: string;
  tenantBaseUrl: string;
  config: ConfigProvider;
  log?: (
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ) => void;
}

export class TenantOAuth {
  private readonly servers = new Map<string, { server: OAuthServer; router: express.Router }>();

  constructor(private readonly o: TenantOAuthOptions) {}

  private issuerBase(tenantId: string) {
    return `${this.o.tenantBaseUrl.replace(/\/$/, "")}/t/${tenantId}/`;
  }

  private stateFile(tenantId: string) {
    return path.join(this.o.dataDir, `${tenantId}.json`);
  }

  /** The OAuth server for an existing tenant (created lazily). */
  private forTenant(tenantId: string) {
    let entry = this.servers.get(tenantId);
    if (!entry) {
      const key = createHmac("sha256", Buffer.from(this.o.tokenSecretHex, "hex"))
        .update(`tenant:${tenantId}`)
        .digest("hex");
      const server = new OAuthServer({
        publicUrl: this.issuerBase(tenantId),
        tokenSecretHex: key,
        stateFile: this.stateFile(tenantId),
        allowedRedirectUris: this.o.allowedRedirectUris ?? DEFAULT_REDIRECT_URIS,
        delegate: { url: this.o.delegateUrl, secret: this.o.delegateSecret, tenantId },
        log: this.o.log,
      });
      entry = { server, router: server.router() };
      this.servers.set(tenantId, entry);
    }
    return entry;
  }

  private async tenant(tenantId: string): Promise<TenantRecord | undefined> {
    return isTenantId(tenantId) ? this.o.config.getTenant(tenantId) : undefined;
  }

  challenge(tenantId: string): string {
    return isTenantId(tenantId)
      ? this.forTenant(tenantId).server.challenge()
      : 'Bearer error="invalid_token"';
  }

  /** Bearer OAuth token -> the tenant's agent client it was issued to. */
  async authenticate(
    tenantId: string,
    token: string,
  ): Promise<{ tenant: TenantRecord; client: ClientRecord } | undefined> {
    const tenant = await this.tenant(tenantId);
    if (!tenant) return undefined;
    const grant = await this.forTenant(tenantId).server.verifyAccessToken(token);
    if (!grant) return undefined;
    const client = tenant.clients.find((c) => c.id === grant.user && c.status === "active");
    if (!client) return undefined;
    // Rotating a client signs out sessions issued before the rotation.
    // Token iat has second resolution; compare at the same resolution.
    if (client.rotatedAt && grant.issuedAt < Math.floor(Date.parse(client.rotatedAt) / 1000))
      return undefined;
    return { tenant, client };
  }

  async purgeTenant(tenantId: string): Promise<void> {
    this.servers.delete(tenantId);
    await removeFile(this.stateFile(tenantId));
  }

  /** Mount /t/<tenant>/{authorize,token,register,revoke,oauth/callback,.well-known/...} and RFC 8414/9728 root paths. */
  mount(app: Express): void {
    const route = (req: Request, res: Response, next: NextFunction) => {
      const tenantId = String(req.params.tenantId);
      this.tenant(tenantId)
        .then((t) => {
          if (!t) {
            res.status(404).json({ error: "not_found", message: "Unknown tenant" });
            return;
          }
          this.forTenant(t.id).router(req, res, next);
        })
        .catch(next);
    };
    // Path-inserted discovery documents (RFC 8414 §3, RFC 9728 §3).
    const rewrite = (to: string) => (req: Request, res: Response, next: NextFunction) => {
      req.url = to;
      route(req, res, next);
    };
    app.get(
      "/.well-known/oauth-authorization-server/t/:tenantId",
      rewrite("/.well-known/oauth-authorization-server"),
    );
    app.get(
      "/.well-known/oauth-protected-resource/t/:tenantId/mcp",
      rewrite("/.well-known/oauth-protected-resource"),
    );
    app.use("/t/:tenantId", (req, res, next) => {
      if (req.path === "/mcp") return next();
      route(req, res, next);
    });
  }
}
