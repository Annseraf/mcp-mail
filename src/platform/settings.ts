/**
 * Platform settings (docs/PLATFORM.md). Everything is opt-in: with none of
 * these variables set the server behaves exactly like v0.2.x.
 */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

export interface PlatformSettings {
  multiTenant: boolean;
  dataDir: string;
  /** Public origin for tenant endpoints, e.g. https://connect.example.com. */
  tenantBaseUrl: string;
  configProvider: "store" | "http";
  configProviderUrl?: string;
  configProviderToken?: string;
  configCacheTtlMs: number;
  keyProvider: "local" | "oci";
  keyFile: string;
  adminApi: boolean;
  adminHost: string;
  adminPort: number;
  adminToken?: string;
  /** Approval queue ("ask me before sending"): expiry and an optional webhook to the product. */
  approvals?: { ttlMs: number; webhookUrl?: string; webhookSecret?: string };
  /** OAuth for tenant endpoints with login delegated to the product (TENANT_OAUTH=true). */
  tenantOAuth?: {
    tokenSecretHex: string;
    delegateUrl: string;
    delegateSecret: string;
    allowedRedirectUris?: string[];
  };
}

const flag = (v: string | undefined) => v === "true" || v === "1";

function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** Loopback, RFC 1918, CGNAT (Tailscale) or IPv6 ULA/loopback only. */
export function isPrivateHost(host: string): boolean {
  if (host === "localhost") return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(host) === 6) return host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host);
  return false;
}

export function loadPlatformSettings(
  env: NodeJS.ProcessEnv = process.env,
  publicUrl = "http://localhost:3220",
): PlatformSettings {
  const dataDir = env.DATA_DIR?.trim() || "/var/lib/mcp-mail";
  const s: PlatformSettings = {
    multiTenant: flag(env.MULTI_TENANT),
    dataDir,
    tenantBaseUrl: (env.TENANT_BASE_URL?.trim() || publicUrl).replace(/\/$/, ""),
    configProvider: env.CONFIG_PROVIDER === "http" ? "http" : "store",
    configProviderUrl: env.CONFIG_PROVIDER_URL?.trim() || undefined,
    configProviderToken: secret(env, "CONFIG_PROVIDER_TOKEN"),
    configCacheTtlMs: Number(env.CONFIG_CACHE_TTL_MS ?? 30_000),
    keyProvider: env.SECRETS_KEY_PROVIDER === "oci" ? "oci" : "local",
    keyFile: env.SECRETS_KEY_FILE?.trim() || path.join(dataDir, "keys", "kek"),
    adminApi: flag(env.ADMIN_API),
    adminHost: env.ADMIN_HOST?.trim() || "127.0.0.1",
    adminPort: Number(env.ADMIN_PORT ?? 3330),
    adminToken: secret(env, "ADMIN_TOKEN"),
    approvals: {
      ttlMs: Number(env.APPROVAL_TTL_HOURS ?? 24) * 3_600_000,
      webhookUrl: env.APPROVAL_WEBHOOK_URL?.trim() || undefined,
      webhookSecret: secret(env, "APPROVAL_WEBHOOK_SECRET"),
    },
  };
  const ttl = s.approvals!.ttlMs;
  if (!Number.isFinite(ttl) || ttl < 60_000 || ttl > 30 * 86_400_000) {
    throw new Error("APPROVAL_TTL_HOURS must be between 0.02 and 720");
  }
  if (s.adminApi) {
    if (!s.multiTenant) throw new Error("ADMIN_API=true requires MULTI_TENANT=true");
    if (!s.adminToken || s.adminToken.length < 32) {
      throw new Error(
        "ADMIN_API=true requires ADMIN_TOKEN (or ADMIN_TOKEN_FILE) of at least 32 characters",
      );
    }
    if (!isPrivateHost(s.adminHost)) {
      throw new Error(
        `ADMIN_HOST=${s.adminHost} is not a private interface; the admin API must never be public`,
      );
    }
  }
  if (flag(env.TENANT_OAUTH)) {
    if (!s.multiTenant) throw new Error("TENANT_OAUTH=true requires MULTI_TENANT=true");
    const tokenSecretHex = secret(env, "TENANT_TOKEN_SECRET");
    const delegateSecret = secret(env, "OAUTH_DELEGATE_SECRET");
    const delegateUrl = env.OAUTH_DELEGATE_URL?.trim();
    if (!tokenSecretHex || !/^[0-9a-f]{64,}$/i.test(tokenSecretHex)) {
      throw new Error(
        "TENANT_OAUTH=true requires TENANT_TOKEN_SECRET (at least 64 hex characters)",
      );
    }
    if (!delegateUrl || !delegateSecret || delegateSecret.length < 32) {
      throw new Error(
        "TENANT_OAUTH=true requires OAUTH_DELEGATE_URL and OAUTH_DELEGATE_SECRET (32+ characters)",
      );
    }
    s.tenantOAuth = {
      tokenSecretHex,
      delegateUrl,
      delegateSecret,
      allowedRedirectUris: env.TENANT_ALLOWED_REDIRECT_URIS
        ? env.TENANT_ALLOWED_REDIRECT_URIS.split(",")
            .map((u) => u.trim())
            .filter(Boolean)
        : undefined,
    };
  }
  if (
    s.multiTenant &&
    s.configProvider === "http" &&
    (!s.configProviderUrl || !s.configProviderToken)
  ) {
    throw new Error("CONFIG_PROVIDER=http requires CONFIG_PROVIDER_URL and CONFIG_PROVIDER_TOKEN");
  }
  return s;
}
