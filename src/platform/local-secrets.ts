/**
 * Opt-in encryption at rest for single-tenant accounts.json
 * (SECRETS_ENCRYPTION=local, docs/PLATFORM.md).
 *
 * Password fields may hold `enc:v1:<base64>` values sealed with AES-256-GCM
 * under the key in SECRETS_KEY_FILE. Without SECRETS_ENCRYPTION=local such
 * values are treated as literal passwords, exactly like v0.2.x.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";

const PREFIX = "enc:v1:";
const AAD = Buffer.from("mcp-mail:accounts.json");
const PASSWORD_FIELDS = ["imap", "smtp", "caldav"] as const;

export const isEncrypted = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith(PREFIX);

export function encryptValue(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decryptValue(key: Buffer, value: string): string {
  const buf = Buffer.from(value.slice(PREFIX.length), "base64");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAAD(AAD);
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

/** Apply `fn` to every password field of every account, in place. */
export function mapPasswords(doc: { accounts?: unknown }, fn: (v: string) => string): number {
  let n = 0;
  if (!Array.isArray(doc.accounts)) return n;
  for (const acct of doc.accounts as Record<string, Record<string, unknown> | undefined>[]) {
    for (const f of PASSWORD_FIELDS) {
      const section = acct?.[f];
      if (section && typeof section.pass === "string") {
        const next = fn(section.pass);
        if (next !== section.pass) n++;
        section.pass = next;
      }
    }
  }
  return n;
}

export async function loadKey(file: string): Promise<Buffer> {
  const st = await fs.stat(file);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new Error(`Key file ${file} must not be readable by group or others (chmod 600).`);
  }
  const raw = (await fs.readFile(file, "utf8")).trim();
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`Key file ${file} must hold exactly 32 bytes.`);
  return key;
}
