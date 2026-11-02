/**
 * Executable spec of the OAuth shim formats that existing deployments use
 * (docs/COMPATIBILITY.md, "OAuth continuity"). The engine's built-in OAuth
 * must accept these byte-for-byte so connected clients never have to
 * reconnect. Fixture values are test-only.
 */
import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.resolve(import.meta.dirname, "../../compat/fixtures/oauth-shim-v0.1");
const fx = JSON.parse(readFileSync(path.join(dir, "fixture.json"), "utf8"));
const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));

/** Access token: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload part, TOKEN_SECRET)). */
function verify(token: string, secretHex: string): Record<string, unknown> | null {
  const [body, mac, ...rest] = token.split(".");
  if (!body || !mac || rest.length) return null;
  const expected = createHmac("sha256", Buffer.from(secretHex, "hex")).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

describe("OAuth shim v0.1 formats", () => {
  it("access tokens are HMAC-SHA256 signed JSON with typ/cid/scp/aud/exp", () => {
    const p = verify(fx.accessTokenValid, fx.tokenSecretHex);
    expect(p).toEqual({
      typ: "at",
      cid: fx.clientId,
      scp: [],
      aud: `${fx.publicUrl}/mcp`,
      exp: expect.any(Number),
    });
    expect(verify(fx.accessTokenValid, "ff".repeat(32))).toBeNull();
  });

  it("refresh tokens are stored as sha256 hex of the token", () => {
    const h = createHash("sha256").update(fx.refreshToken).digest("hex");
    expect(state.refresh[h]).toMatchObject({
      cid: fx.clientId,
      scp: [],
      aud: `${fx.publicUrl}/mcp`,
    });
  });

  it("DCR clients are stored by client_id with RFC 7591 metadata", () => {
    expect(state.clients[fx.clientId]).toMatchObject({
      client_id: fx.clientId,
      client_name: "Claude",
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
  });

  it("login password hash is scrypt:N:r:p:salt:hash (base64url)", () => {
    const [kind, N, r, p, salt, hash] = fx.loginPasswordHash.split(":");
    expect(kind).toBe("scrypt");
    const actual = scryptSync(fx.loginPassword, Buffer.from(salt, "base64url"), 32, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
    expect(actual.equals(Buffer.from(hash, "base64url"))).toBe(true);
  });

  // Enabled when the engine gains built-in OAuth (Phase 3/4).
  it.todo("engine accepts fixture.accessTokenValid for /mcp with TOKEN_SECRET set");
  it.todo("engine rejects accessTokenExpired and accessTokenUnknownClient with 401");
  it.todo("engine exchanges fixture.refreshToken from an existing state.json and rotates it");
  it.todo(
    "engine serves the same discovery, /register, /authorize, /token, /revoke and /login paths",
  );
  it.todo("engine verifies LOGIN_USER + LOGIN_PASSWORD_HASH logins");
});
