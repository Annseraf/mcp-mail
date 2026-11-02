/**
 * Built-in OAuth 2.1 authorization server (OAUTH=true, docs/CLIENTS.md):
 * discovery metadata, dynamic client registration, PKCE (S256) authorization
 * with a login page, token issuance and rotation, revocation.
 *
 * Wire- and state-compatible with the reference OAuth shim that existing
 * deployments run, so swapping it for the engine needs no reconnect:
 * - access tokens: base64url(JSON) "." base64url(HMAC-SHA256(TOKEN_SECRET)),
 *   payload { typ: "at", cid, scp, aud, exp } (+ sub, iat added here)
 * - state.json: { clients: {<client_id>: RFC 7591 metadata}, refresh: {<sha256>: { cid, scp, aud, exp }} }
 * - login: LOGIN_USER + LOGIN_PASSWORD_HASH (scrypt:N:r:p:salt:hash)
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type Request, type Response, type Router } from "express";
import { readJson, writeFileAtomic } from "../platform/fsutil.js";
import { safeEqual } from "../platform/tokens.js";
import { verifyPassword } from "./password.js";

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_TXN_TTL_S = 10 * 60;
const MAX_CLIENTS = 50;

export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  // ChatGPT's stable callback (used because we implement RFC 9207 issuer identification).
  "https://chatgpt.com/connector_platform_oauth_redirect",
];

export interface OAuthOptions {
  /** Issuer base, e.g. https://mail.example.com or https://connect.example.com/t/<tenant>. */
  publicUrl: string;
  tokenSecretHex: string;
  stateFile: string;
  /** Primary login (shim-compatible). */
  loginUser?: string;
  loginPasswordHash?: string;
  /** Extra logins: JSON { "users": { "<name>": "<scrypt hash>" } }. */
  usersFile?: string;
  allowedRedirectUris?: string[];
  /**
   * Hand the login step to another service (multi-tenant products). /authorize
   * redirects to `url` with a signed `txn`; the service authenticates the user
   * and redirects back to `<issuer>oauth/callback?txn=..&client=<id>&sig=..`
   * where sig = hex HMAC-SHA256(secret, "<txn>.<client>") ("<txn>.denied" to refuse).
   */
  delegate?: { url: string; secret: string; tenantId?: string };
  log?: (level: "info" | "warn", msg: string, extra?: Record<string, unknown>) => void;
}

export interface AccessGrant {
  clientId: string;
  user: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
}

interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: string;
  client_secret?: string;
  [k: string]: unknown;
}

interface RefreshRecord {
  cid: string;
  scp: string[];
  aud: string | null;
  exp: number;
  sub?: string;
  iat?: number;
}

interface State {
  clients: Record<string, RegisteredClient>;
  refresh: Record<string, RefreshRecord>;
}

interface CodeRecord {
  clientId: string;
  challenge: string;
  redirectUri: string;
  scopes: string[];
  resource: string | null;
  user: string;
  exp: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const nowS = () => Math.floor(Date.now() / 1000);
const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class OAuthServer {
  readonly issuer: string;
  readonly resource: string;
  readonly resourceMetadataUrl: string;
  private readonly secret: Buffer;
  private readonly redirects: string[];
  private readonly codes = new Map<string, CodeRecord>();
  private readonly failures = new Map<string, number[]>();
  private state: State = { clients: {}, refresh: {} };
  private loaded = false;

  constructor(private readonly o: OAuthOptions) {
    if (!/^[0-9a-f]{32,}$/i.test(o.tokenSecretHex))
      throw new Error("TOKEN_SECRET must be >= 32 hex characters");
    this.secret = Buffer.from(o.tokenSecretHex, "hex");
    const base = new URL(o.publicUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    this.issuer = base.href;
    this.resource = new URL("mcp", base).href;
    // RFC 9728: metadata lives at /.well-known/oauth-protected-resource + the resource path.
    this.resourceMetadataUrl = new URL(
      `/.well-known/oauth-protected-resource${new URL(this.resource).pathname}`,
      base,
    ).href;
    this.redirects = o.allowedRedirectUris ?? DEFAULT_REDIRECT_URIS;
  }

  // ---- state ----

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const s = await readJson<Partial<State>>(this.o.stateFile);
    this.state = { clients: s?.clients ?? {}, refresh: s?.refresh ?? {} };
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const t = nowS();
    for (const [h, r] of Object.entries(this.state.refresh))
      if (r.exp < t) delete this.state.refresh[h];
    const ids = Object.keys(this.state.clients);
    if (ids.length > MAX_CLIENTS) {
      ids.sort(
        (a, b) =>
          this.state.clients[a].client_id_issued_at - this.state.clients[b].client_id_issued_at,
      );
      for (const id of ids.slice(0, ids.length - MAX_CLIENTS)) delete this.state.clients[id];
    }
    await writeFileAtomic(this.o.stateFile, JSON.stringify(this.state));
  }

  // ---- tokens ----

  private sign(payload: object): string {
    const body = b64url(JSON.stringify(payload));
    return `${body}.${b64url(createHmac("sha256", this.secret).update(body).digest())}`;
  }

  private unsign(token: string): Record<string, unknown> | null {
    const [body, mac, ...rest] = String(token).split(".");
    if (!body || !mac || rest.length) return null;
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
  }

  private defaultUser(): string {
    return this.o.loginUser ?? "user";
  }

  /** Verify a bearer access token. Returns undefined for anything invalid. */
  async verifyAccessToken(token: string): Promise<AccessGrant | undefined> {
    await this.ensureLoaded();
    const p = this.unsign(token);
    if (!p || p.typ !== "at" || typeof p.exp !== "number" || p.exp < nowS()) return undefined;
    const cid = String(p.cid);
    if (!this.state.clients[cid]) return undefined;
    const aud = p.aud as string | null | undefined;
    if (aud && !this.resourceAllowed(aud)) return undefined;
    return {
      clientId: cid,
      user: typeof p.sub === "string" ? p.sub : this.defaultUser(),
      scopes: Array.isArray(p.scp) ? (p.scp as string[]) : [],
      // Tokens minted by the shim carry no iat; they were issued one TTL before expiry.
      issuedAt: typeof p.iat === "number" ? p.iat : (p.exp as number) - ACCESS_TTL_S,
      expiresAt: p.exp as number,
    };
  }

  private async issueTokens(cid: string, scopes: string[], aud: string | null, sub: string) {
    const iat = nowS();
    const access = this.sign({
      typ: "at",
      cid,
      scp: scopes,
      aud,
      exp: iat + ACCESS_TTL_S,
      sub,
      iat,
    });
    const refresh = b64url(randomBytes(32));
    this.state.refresh[sha256hex(refresh)] = {
      cid,
      scp: scopes,
      aud,
      exp: iat + REFRESH_TTL_S,
      sub,
      iat,
    };
    await this.save();
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    };
  }

  private resourceAllowed(resource: string): boolean {
    const r = resource.replace(/\/$/, "");
    return r === this.resource.replace(/\/$/, "") || r === this.issuer.replace(/\/$/, "");
  }

  // ---- logins ----

  private loginUsers(): Record<string, string> {
    const users: Record<string, string> = {};
    if (this.o.loginUser && this.o.loginPasswordHash)
      users[this.o.loginUser] = this.o.loginPasswordHash;
    if (this.o.usersFile) {
      try {
        Object.assign(
          users,
          (JSON.parse(readFileSync(this.o.usersFile, "utf8")) as { users?: Record<string, string> })
            .users,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return users;
  }

  private checkLogin(user: string, pass: string): string | undefined {
    if (!pass || pass.length > 1024) return undefined;
    let matched: string | undefined;
    for (const [name, hash] of Object.entries(this.loginUsers())) {
      // Compare every candidate so timing doesn't reveal which names exist.
      if (safeEqual(user, name) && verifyPassword(pass, hash)) matched = name;
    }
    return matched;
  }

  private recentFailures(key: string): number[] {
    const cutoff = Date.now() - 15 * 60 * 1000;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    this.failures.set(key, list);
    return list;
  }

  private throttled(ip: string) {
    return (
      this.recentFailures(`ip:${ip}`).length >= 5 || this.recentFailures("global").length >= 20
    );
  }

  private recordFailure(ip: string) {
    this.recentFailures(`ip:${ip}`).push(Date.now());
    this.recentFailures("global").push(Date.now());
  }

  // ---- revocation hooks (used by clients.json revoke/rotate) ----

  /** Drop refresh tokens for a login user and/or OAuth client id. */
  async revokeGrants(match: { user?: string; clientId?: string }): Promise<number> {
    await this.ensureLoaded();
    let n = 0;
    for (const [h, r] of Object.entries(this.state.refresh)) {
      const sub = r.sub ?? this.defaultUser();
      if ((match.user && sub === match.user) || (match.clientId && r.cid === match.clientId)) {
        delete this.state.refresh[h];
        n++;
      }
    }
    if (n) await this.save();
    return n;
  }

  // ---- HTTP ----

  metadata() {
    const u = (p: string) => new URL(p.replace(/^\//, ""), this.issuer).href;
    return {
      issuer: this.issuer,
      authorization_endpoint: u("/authorize"),
      token_endpoint: u("/token"),
      registration_endpoint: u("/register"),
      revocation_endpoint: u("/revoke"),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      authorization_response_iss_parameter_supported: true,
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
    };
  }

  /** WWW-Authenticate value for 401s on /mcp. */
  challenge(): string {
    return `Bearer resource_metadata="${this.resourceMetadataUrl}"`;
  }

  router(): Router {
    const r = express.Router();
    const form = express.urlencoded({ extended: false, limit: "16kb" });
    const json = express.json({ limit: "16kb" });
    const wrap =
      (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
        res.set("Cache-Control", "no-store");
        fn(req, res).catch((err: unknown) => {
          if (err instanceof OAuthError) {
            res.status(err.status).json({ error: err.code, error_description: err.message });
            return;
          }
          this.o.log?.("warn", "oauth request failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          res.status(500).json({ error: "server_error", error_description: "Internal error" });
        });
      };

    r.get("/.well-known/oauth-authorization-server", (_req, res) => {
      res.json(this.metadata());
    });
    for (const p of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      r.get(p, (_req, res) => {
        res.json(this.protectedResourceMetadata());
      });
    }

    r.post(
      "/register",
      json,
      wrap(async (req, res) => {
        await this.ensureLoaded();
        const body = (req.body ?? {}) as Record<string, unknown>;
        const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
        if (uris.length === 0 || !uris.every((u) => this.redirects.includes(u))) {
          this.o.log?.("warn", "rejected client registration", { redirect_uris: uris });
          throw new OAuthError(
            "invalid_redirect_uri",
            "redirect_uris not permitted on this server",
          );
        }
        const method =
          typeof body.token_endpoint_auth_method === "string"
            ? body.token_endpoint_auth_method
            : "none";
        if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
          throw new OAuthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method");
        }
        const client: RegisteredClient = {
          ...body,
          redirect_uris: uris,
          token_endpoint_auth_method: method,
          client_id: randomUUID(),
          client_id_issued_at: nowS(),
          ...(method === "none" ? {} : { client_secret: b64url(randomBytes(32)) }),
        };
        this.state.clients[client.client_id] = client;
        await this.save();
        this.o.log?.("info", "client registered", {
          client_id: client.client_id,
          client_name: client.client_name,
        });
        res.status(201).json(client);
      }),
    );

    const authorize = wrap(async (req, res) => {
      await this.ensureLoaded();
      const q = {
        ...(req.query as Record<string, string>),
        ...((req.body as Record<string, string>) ?? {}),
      };
      const client = this.state.clients[q.client_id ?? ""];
      if (!client) throw new OAuthError("invalid_client", "Unknown client");
      const redirectUri =
        q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
      if (!client.redirect_uris.includes(redirectUri))
        throw new OAuthError("invalid_request", "redirect_uri not registered");
      const fail = (code: string, description: string) => {
        const u = new URL(redirectUri);
        u.searchParams.set("error", code);
        u.searchParams.set("error_description", description);
        if (q.state) u.searchParams.set("state", q.state);
        u.searchParams.set("iss", this.issuer);
        res.redirect(302, u.href);
      };
      if (q.response_type !== "code")
        return fail("unsupported_response_type", "response_type must be code");
      if (!q.code_challenge || q.code_challenge_method !== "S256")
        return fail("invalid_request", "PKCE S256 required");
      if (q.resource && !this.resourceAllowed(q.resource))
        return fail("invalid_target", "Unknown resource");
      const txn = this.sign({
        typ: "txn",
        cid: client.client_id,
        cc: q.code_challenge,
        ru: redirectUri,
        st: q.state ?? null,
        sc: q.scope ? q.scope.split(" ").filter(Boolean) : [],
        rs: q.resource ?? null,
        exp: nowS() + LOGIN_TXN_TTL_S,
      });
      if (this.o.delegate) {
        const target = new URL(this.o.delegate.url);
        target.searchParams.set("txn", txn);
        target.searchParams.set("client_name", String(client.client_name ?? "An MCP client"));
        target.searchParams.set("redirect_host", new URL(redirectUri).host);
        target.searchParams.set("return_to", new URL("oauth/callback", this.issuer).href);
        if (this.o.delegate.tenantId) target.searchParams.set("tenant", this.o.delegate.tenantId);
        res.redirect(302, target.href);
        return;
      }
      this.renderLogin(res, { txn, client, redirectUri });
    });
    r.get("/authorize", authorize);
    r.post("/authorize", form, authorize);

    r.get(
      "/oauth/callback",
      wrap(async (req, res) => {
        await this.ensureLoaded();
        const d = this.o.delegate;
        const q = req.query as Record<string, string>;
        if (!d || !q.txn || !q.sig)
          throw new OAuthError("invalid_request", "Missing parameters", 400);
        const outcome = q.error === "access_denied" ? "denied" : (q.client ?? "");
        const expected = createHmac("sha256", d.secret).update(`${q.txn}.${outcome}`).digest();
        const given = Buffer.from(q.sig, "hex");
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
          throw new OAuthError("access_denied", "Invalid signature", 400);
        }
        const txn = this.unsign(q.txn);
        if (!txn || txn.typ !== "txn" || (txn.exp as number) < nowS()) {
          res
            .status(400)
            .type("text/plain")
            .send("Login session expired. Start the connection again from your app.");
          return;
        }
        const client = this.state.clients[String(txn.cid)];
        if (!client || !client.redirect_uris.includes(String(txn.ru)))
          throw new OAuthError("invalid_client", "Unknown client");
        const target = new URL(String(txn.ru));
        if (txn.st) target.searchParams.set("state", String(txn.st));
        target.searchParams.set("iss", this.issuer);
        if (outcome === "denied" || !outcome) {
          target.searchParams.set("error", "access_denied");
          res.redirect(302, target.href);
          return;
        }
        const code = b64url(randomBytes(32));
        this.codes.set(code, {
          clientId: client.client_id,
          challenge: String(txn.cc),
          redirectUri: String(txn.ru),
          scopes: (txn.sc as string[]) ?? [],
          resource: (txn.rs as string | null) ?? null,
          user: outcome,
          exp: Date.now() + CODE_TTL_MS,
        });
        this.o.log?.("info", "delegated login ok", { client_id: client.client_id, user: outcome });
        target.searchParams.set("code", code);
        res.redirect(302, target.href);
      }),
    );

    r.post(
      "/login",
      form,
      wrap(async (req, res) => {
        await this.ensureLoaded();
        const ip = req.ip ?? "unknown";
        const txn = this.unsign(String(req.body?.txn ?? ""));
        if (!txn || txn.typ !== "txn" || (txn.exp as number) < nowS()) {
          res
            .status(400)
            .type("text/plain")
            .send("Login session expired. Start the connection again from your app.");
          return;
        }
        const client = this.state.clients[String(txn.cid)];
        if (!client || !client.redirect_uris.includes(String(txn.ru))) {
          res.status(400).type("text/plain").send("Unknown client.");
          return;
        }
        const ctx = { txn: String(req.body.txn), client, redirectUri: String(txn.ru) };
        if (this.throttled(ip)) {
          this.o.log?.("warn", "login throttled", { ip });
          this.renderLogin(res.status(429), {
            ...ctx,
            error: "Too many failed attempts. Try again later.",
          });
          return;
        }
        const user = this.checkLogin(
          String(req.body.username ?? ""),
          String(req.body.password ?? ""),
        );
        if (!user) {
          this.recordFailure(ip);
          this.o.log?.("warn", "login fail", { ip });
          this.renderLogin(res, { ...ctx, error: "Invalid username or password." });
          return;
        }
        const code = b64url(randomBytes(32));
        this.codes.set(code, {
          clientId: client.client_id,
          challenge: String(txn.cc),
          redirectUri: String(txn.ru),
          scopes: (txn.sc as string[]) ?? [],
          resource: (txn.rs as string | null) ?? null,
          user,
          exp: Date.now() + CODE_TTL_MS,
        });
        for (const [k, v] of this.codes) if (v.exp < Date.now()) this.codes.delete(k);
        this.o.log?.("info", "login ok", { ip, client_id: client.client_id, user });
        const target = new URL(String(txn.ru));
        target.searchParams.set("code", code);
        if (txn.st) target.searchParams.set("state", String(txn.st));
        target.searchParams.set("iss", this.issuer);
        res.redirect(302, target.href);
      }),
    );

    const clientAuth = (req: Request, body: Record<string, string>): RegisteredClient => {
      let id = body.client_id;
      let secret = body.client_secret;
      const basic = /^Basic\s+(.+)$/i.exec(req.header("authorization") ?? "");
      if (basic) {
        const [u, p] = Buffer.from(basic[1], "base64").toString().split(":");
        id = decodeURIComponent(u ?? "");
        secret = decodeURIComponent(p ?? "");
      }
      const client = this.state.clients[id ?? ""];
      if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
      if (client.client_secret && !(secret && safeEqual(secret, client.client_secret))) {
        throw new OAuthError("invalid_client", "Client authentication failed", 401);
      }
      return client;
    };

    r.post(
      "/token",
      form,
      json,
      wrap(async (req, res) => {
        await this.ensureLoaded();
        const b = (req.body ?? {}) as Record<string, string>;
        const client = clientAuth(req, b);
        if (b.grant_type === "authorization_code") {
          const c = this.codes.get(b.code ?? "");
          this.codes.delete(b.code ?? "");
          if (!c || c.clientId !== client.client_id || c.exp < Date.now()) {
            throw new OAuthError("invalid_grant", "Invalid authorization code");
          }
          if (b.redirect_uri && b.redirect_uri !== c.redirectUri)
            throw new OAuthError("invalid_grant", "redirect_uri mismatch");
          const verifier = b.code_verifier ?? "";
          if (!verifier || b64url(createHash("sha256").update(verifier).digest()) !== c.challenge) {
            throw new OAuthError("invalid_grant", "PKCE verification failed");
          }
          if (b.resource && c.resource && b.resource !== c.resource)
            throw new OAuthError("invalid_grant", "resource mismatch");
          this.o.log?.("info", "token issued", {
            client_id: client.client_id,
            grant: "authorization_code",
          });
          res.json(
            await this.issueTokens(
              client.client_id,
              c.scopes,
              c.resource ?? b.resource ?? null,
              c.user,
            ),
          );
          return;
        }
        if (b.grant_type === "refresh_token") {
          const h = sha256hex(b.refresh_token ?? "");
          const rt = this.state.refresh[h];
          if (!rt || rt.cid !== client.client_id || rt.exp < nowS())
            throw new OAuthError("invalid_grant", "Invalid refresh token");
          delete this.state.refresh[h]; // rotate
          if (b.resource && rt.aud && b.resource !== rt.aud) {
            await this.save();
            throw new OAuthError("invalid_grant", "resource mismatch");
          }
          const requested = b.scope ? b.scope.split(" ").filter(Boolean) : [];
          const granted = requested.length ? requested.filter((s) => rt.scp.includes(s)) : rt.scp;
          this.o.log?.("info", "token issued", {
            client_id: client.client_id,
            grant: "refresh_token",
          });
          res.json(
            await this.issueTokens(client.client_id, granted, rt.aud, rt.sub ?? this.defaultUser()),
          );
          return;
        }
        throw new OAuthError("unsupported_grant_type", "Unsupported grant_type");
      }),
    );

    r.post(
      "/revoke",
      form,
      json,
      wrap(async (req, res) => {
        await this.ensureLoaded();
        const b = (req.body ?? {}) as Record<string, string>;
        const client = clientAuth(req, b);
        const h = sha256hex(b.token ?? "");
        if (this.state.refresh[h]?.cid === client.client_id) {
          delete this.state.refresh[h];
          await this.save();
        }
        res.status(200).end();
      }),
    );
    return r;
  }

  private renderLogin(
    res: Response,
    v: { txn: string; client: RegisteredClient; redirectUri: string; error?: string },
  ) {
    const host = (() => {
      try {
        return new URL(v.redirectUri).host;
      } catch {
        return "?";
      }
    })();
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    res.status(res.statusCode === 429 ? 429 : v.error ? 401 : 200).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in to mcp-mail</title>
<style>
body{font:16px system-ui,sans-serif;background:#f4f4f5;color:#18181b;display:grid;place-items:center;min-height:100vh;margin:0}
@media (prefers-color-scheme:dark){body{background:#18181b;color:#f4f4f5}form{background:#27272a!important}input{background:#18181b;color:#f4f4f5;border-color:#52525b!important}}
form{background:#fff;padding:2rem;border-radius:12px;width:min(340px,90vw);box-shadow:0 1px 3px #0002}
h1{font-size:1.15rem;margin:0 0 .5rem}p{font-size:.85rem;opacity:.75;margin:0 0 1.25rem}
label{display:block;font-size:.85rem;margin:.75rem 0 .25rem}input{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #d4d4d8;border-radius:8px;font:inherit}
button{margin-top:1.25rem;width:100%;padding:.65rem;border:0;border-radius:8px;background:#2563eb;color:#fff;font:inherit;cursor:pointer}
.err{color:#dc2626;font-size:.85rem;margin-top:.75rem}
</style></head><body>
<form method="post" action="login" autocomplete="on">
<h1>Authorize mail connector</h1>
<p><b>${escapeHtml(v.client.client_name || "An MCP client")}</b> wants access to your mailboxes on ${escapeHtml(new URL(this.issuer).host)}.<br>You'll be returned to <b>${escapeHtml(host)}</b>.</p>
<input type="hidden" name="txn" value="${escapeHtml(v.txn)}">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" required>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in &amp; authorize</button>
${v.error ? `<div class="err">${escapeHtml(v.error)}</div>` : ""}
</form></body></html>`);
  }
}
