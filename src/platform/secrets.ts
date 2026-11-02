/**
 * Secret storage for multi-tenant mode (docs/PLATFORM.md, "Secret store").
 *
 * Envelope encryption: every tenant has its own random 256-bit data key
 * (DEK). Secrets are encrypted with AES-256-GCM under the tenant's DEK, and
 * the DEK is stored only wrapped by a key-encryption key (KEK) held by a
 * KeyProvider: a local key file, or an external KMS. Deleting a tenant
 * deletes its wrapped DEK, which makes every copy of its ciphertext useless.
 *
 * Secrets are write-only from the outside: nothing in the admin API, logs,
 * errors or tool output ever returns them. Only the engine reads them, to
 * open mailbox connections.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJson, removeFile, writeFileAtomic } from "./fsutil.js";
import { assertSecretName, assertTenantId } from "./ids.js";

/** Wraps and unwraps data keys with a key-encryption key that never leaves the provider. */
export interface KeyProvider {
  /** Stable identifier recorded next to wrapped keys, e.g. `local:v1` or an OCI key OCID. */
  readonly id: string;
  wrap(dek: Buffer, context: string): Promise<string>;
  unwrap(wrapped: string, context: string): Promise<Buffer>;
}

export interface SecretStore {
  put(tenantId: string, name: string, value: string): Promise<void>;
  /** Engine-internal: used to open mailbox connections. Never exposed. */
  get(tenantId: string, name: string): Promise<string | undefined>;
  has(tenantId: string, name: string): Promise<boolean>;
  delete(tenantId: string, name: string): Promise<void>;
  /** Remove every secret and the data key of a tenant. */
  purgeTenant(tenantId: string): Promise<void>;
}

const GCM_IV = 12;

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(GCM_IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const buf = Buffer.from(sealed, "base64");
  const iv = buf.subarray(0, GCM_IV);
  const tag = buf.subarray(GCM_IV, GCM_IV + 16);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(GCM_IV + 16)), d.final()]);
}

/**
 * KEK in a local file: 32 random bytes, hex or base64. Keep it on a separate
 * volume, readable only by the engine user. Refuses group/world-readable files.
 */
export class LocalKeyFileProvider implements KeyProvider {
  readonly id = "local:v1";

  private constructor(private readonly kek: Buffer) {}

  static async load(file: string): Promise<LocalKeyFileProvider> {
    const st = await fs.stat(file);
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new Error(`Key file ${file} must not be readable by group or others (chmod 600).`);
    }
    const raw = (await fs.readFile(file, "utf8")).trim();
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error(`Key file ${file} must hold exactly 32 bytes.`);
    return new LocalKeyFileProvider(key);
  }

  /** Create a new key file (fails if it exists). */
  static async generate(file: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  }

  static fromKey(key: Buffer): LocalKeyFileProvider {
    if (key.length !== 32) throw new Error("KEK must be 32 bytes");
    return new LocalKeyFileProvider(key);
  }

  async wrap(dek: Buffer, context: string): Promise<string> {
    return seal(this.kek, dek, `kek:${context}`);
  }

  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    return open(this.kek, wrapped, `kek:${context}`);
  }
}

interface TenantSecretsFile {
  version: 1;
  kek: string;
  dek: string;
  entries: Record<string, string>;
}

/** One file per tenant under `<dir>/<tenantId>.json`, mode 0600. */
export class EnvelopeFileSecretStore implements SecretStore {
  private readonly deks = new Map<string, Buffer>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dir: string,
    private readonly keys: KeyProvider,
  ) {}

  private file(tenantId: string): string {
    return path.join(this.dir, `${assertTenantId(tenantId)}.json`);
  }

  /** Serialize writers per tenant so concurrent puts never lose entries. */
  private async locked<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(tenantId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      tenantId,
      next.catch(() => {}),
    );
    return next;
  }

  private async dekFor(tenantId: string, doc: TenantSecretsFile): Promise<Buffer> {
    const cached = this.deks.get(tenantId);
    if (cached) return cached;
    const dek = await this.keys.unwrap(doc.dek, `tenant:${tenantId}`);
    this.deks.set(tenantId, dek);
    return dek;
  }

  async put(tenantId: string, name: string, value: string): Promise<void> {
    assertSecretName(name);
    await this.locked(tenantId, async () => {
      let doc = await readJson<TenantSecretsFile>(this.file(tenantId));
      if (!doc) {
        const dek = randomBytes(32);
        doc = {
          version: 1,
          kek: this.keys.id,
          dek: await this.keys.wrap(dek, `tenant:${tenantId}`),
          entries: {},
        };
        this.deks.set(tenantId, dek);
      }
      const dek = await this.dekFor(tenantId, doc);
      doc.entries[name] = seal(dek, Buffer.from(value, "utf8"), `${tenantId}/${name}`);
      await writeFileAtomic(this.file(tenantId), JSON.stringify(doc));
    });
  }

  async get(tenantId: string, name: string): Promise<string | undefined> {
    assertSecretName(name);
    const doc = await readJson<TenantSecretsFile>(this.file(tenantId));
    const sealed = doc?.entries[name];
    if (!doc || !sealed) return undefined;
    return open(await this.dekFor(tenantId, doc), sealed, `${tenantId}/${name}`).toString("utf8");
  }

  async has(tenantId: string, name: string): Promise<boolean> {
    assertSecretName(name);
    const doc = await readJson<TenantSecretsFile>(this.file(tenantId));
    return Boolean(doc?.entries[name]);
  }

  async delete(tenantId: string, name: string): Promise<void> {
    assertSecretName(name);
    await this.locked(tenantId, async () => {
      const doc = await readJson<TenantSecretsFile>(this.file(tenantId));
      if (!doc || !(name in doc.entries)) return;
      delete doc.entries[name];
      await writeFileAtomic(this.file(tenantId), JSON.stringify(doc));
    });
  }

  async purgeTenant(tenantId: string): Promise<void> {
    await this.locked(tenantId, async () => {
      this.deks.delete(tenantId);
      await removeFile(this.file(tenantId));
    });
  }
}
