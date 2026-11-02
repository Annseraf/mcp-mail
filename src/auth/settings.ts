/** Settings for client identities, OAuth and auditing (docs/CLIENTS.md). All opt-in. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_REDIRECT_URIS } from "./oauth.js";

export interface AuthSettings {
  clientsFile: string;
  oauth?: {
    tokenSecretHex: string;
    stateFile: string;
    loginUser?: string;
    loginPasswordHash?: string;
    usersFile: string;
    allowedRedirectUris: string[];
  };
  /** "stdout", a file path, or undefined (off). */
  auditLog?: string;
}

const flag = (v: string | undefined) => v === "true" || v === "1";

function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  const v = env[name]?.trim();
  return v ? v : undefined;
}

export function loadAuthSettings(env: NodeJS.ProcessEnv, accountsFile: string): AuthSettings {
  const dir = path.dirname(accountsFile);
  const s: AuthSettings = {
    clientsFile: env.CLIENTS_FILE?.trim() || path.join(dir, "clients.json"),
    auditLog: env.AUDIT_LOG?.trim() || undefined,
  };
  if (flag(env.OAUTH)) {
    const tokenSecretHex = secret(env, "TOKEN_SECRET");
    if (!tokenSecretHex)
      throw new Error("OAUTH=true requires TOKEN_SECRET (hex, at least 32 characters)");
    s.oauth = {
      tokenSecretHex,
      stateFile:
        env.OAUTH_STATE_FILE?.trim() ||
        env.STATE_FILE?.trim() ||
        path.join(dir, "oauth-state.json"),
      loginUser: env.LOGIN_USER?.trim() || undefined,
      loginPasswordHash: secret(env, "LOGIN_PASSWORD_HASH"),
      usersFile: env.OAUTH_USERS_FILE?.trim() || path.join(dir, "oauth-users.json"),
      allowedRedirectUris: env.ALLOWED_REDIRECT_URIS
        ? env.ALLOWED_REDIRECT_URIS.split(",")
            .map((u) => u.trim())
            .filter(Boolean)
        : DEFAULT_REDIRECT_URIS,
    };
  }
  return s;
}
