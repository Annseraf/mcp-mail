/**
 * Login password hashes in the reference OAuth shim's format, so existing
 * LOGIN_PASSWORD_HASH values keep working: `scrypt:N:r:p:<salt>:<hash>`
 * (base64url, no `$`, safe in env files).
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 32768;
const R = 8;
const P = 1;
const MAXMEM = 256 * 1024 * 1024;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt:${N}:${R}:${P}:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  if (expected.length < 16 || Number(n) > 1 << 20) return false;
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return timingSafeEqual(actual, expected);
}

/** A random password for generated logins (shown once). */
export const generatePassword = () => randomBytes(18).toString("base64url");
