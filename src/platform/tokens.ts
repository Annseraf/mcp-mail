import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Agent client tokens: shown once, stored only as a SHA-256 hash. */
export function newClientToken(): { token: string; hash: string } {
  const token = `mcpm_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

/** Constant-time string comparison via fixed-length digests. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
