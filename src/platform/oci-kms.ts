/**
 * OCI Vault (KMS) key provider: wraps tenant data keys with a master key in
 * OCI Vault via the crypto endpoint's /encrypt and /decrypt operations, using
 * OCI API-key request signing (draft-cavage HTTP signatures, rsa-sha256).
 *
 * Configure with OCI_KMS_CRYPTO_ENDPOINT, OCI_KMS_KEY_ID, OCI_TENANCY_OCID,
 * OCI_USER_OCID, OCI_KEY_FINGERPRINT and OCI_PRIVATE_KEY_FILE (see docs/PLATFORM.md).
 */
import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import type { KeyProvider } from "./secrets.js";

export interface OciKmsOptions {
  cryptoEndpoint: string;
  keyId: string;
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKey: KeyObject;
  fetchImpl?: typeof fetch;
}

/** Headers OCI requires to be signed on requests with a body. */
const SIGNED_HEADERS = [
  "date",
  "(request-target)",
  "host",
  "content-length",
  "content-type",
  "x-content-sha256",
];

export function signOciRequest(
  method: string,
  url: URL,
  body: string,
  keyId: string,
  privateKey: KeyObject,
  date = new Date(),
): Record<string, string> {
  const headers: Record<string, string> = {
    date: date.toUTCString(),
    host: url.host,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "x-content-sha256": createHash("sha256").update(body).digest("base64"),
  };
  const signingString = SIGNED_HEADERS.map((h) =>
    h === "(request-target)"
      ? `(request-target): ${method.toLowerCase()} ${url.pathname}${url.search}`
      : `${h}: ${headers[h]}`,
  ).join("\n");
  const signature = sign("sha256", Buffer.from(signingString), privateKey).toString("base64");
  headers.authorization =
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",` +
    `headers="${SIGNED_HEADERS.join(" ")}",signature="${signature}"`;
  return headers;
}

export class OciKmsKeyProvider implements KeyProvider {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OciKmsOptions) {
    this.id = `oci-kms:${opts.keyId}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  static async fromEnv(env = process.env): Promise<OciKmsKeyProvider> {
    const need = (k: string) => {
      const v = env[k]?.trim();
      if (!v) throw new Error(`${k} is required for SECRETS_KEY_PROVIDER=oci`);
      return v;
    };
    const pem = await fs.readFile(need("OCI_PRIVATE_KEY_FILE"), "utf8");
    return new OciKmsKeyProvider({
      cryptoEndpoint: need("OCI_KMS_CRYPTO_ENDPOINT").replace(/\/$/, ""),
      keyId: need("OCI_KMS_KEY_ID"),
      tenancyOcid: need("OCI_TENANCY_OCID"),
      userOcid: need("OCI_USER_OCID"),
      fingerprint: need("OCI_KEY_FINGERPRINT"),
      privateKey: createPrivateKey(pem),
    });
  }

  private async call(op: "encrypt" | "decrypt", payload: object): Promise<Record<string, string>> {
    const url = new URL(`${this.opts.cryptoEndpoint}/20180608/${op}`);
    const body = JSON.stringify(payload);
    const keyId = `${this.opts.tenancyOcid}/${this.opts.userOcid}/${this.opts.fingerprint}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: signOciRequest("POST", url, body, keyId, this.opts.privateKey),
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Never include request bodies (they carry key material) in errors.
      throw new Error(`OCI KMS ${op} failed: HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, string>;
  }

  async wrap(dek: Buffer, context: string): Promise<string> {
    const r = await this.call("encrypt", {
      keyId: this.opts.keyId,
      plaintext: dek.toString("base64"),
      associatedData: { context },
    });
    return r.ciphertext;
  }

  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    const r = await this.call("decrypt", {
      keyId: this.opts.keyId,
      ciphertext: wrapped,
      associatedData: { context },
    });
    return Buffer.from(r.plaintext, "base64");
  }
}
