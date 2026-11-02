import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountsStore } from "../../src/accounts.js";
import { runCli } from "../../src/cli.js";
import {
  decryptValue,
  isEncrypted,
  loadKey,
  mapPasswords,
} from "../../src/platform/local-secrets.js";

const fixture = path.resolve(
  import.meta.dirname,
  "../../compat/fixtures/upstream-v0.2.1/accounts.full.json",
);
let dir: string;
let accounts: string;
let keyFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mcp-mail-enc-"));
  accounts = path.join(dir, "accounts.json");
  keyFile = path.join(dir, "kek");
  await copyFile(fixture, accounts);
  expect(await runCli(["secrets", "init-key", "--key-file", keyFile])).toBe(0);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const decrypting = async () => {
  const key = await loadKey(keyFile);
  return (doc: unknown) =>
    void mapPasswords(doc as { accounts?: unknown }, (v) =>
      isEncrypted(v) ? decryptValue(key, v) : v,
    );
};

describe("SECRETS_ENCRYPTION=local", () => {
  it("encrypts every password field, keeps unknown fields, and writes a backup first", async () => {
    expect(
      await runCli(["secrets", "encrypt", "--key-file", keyFile, "--accounts", accounts]),
    ).toBe(0);
    const text = await readFile(accounts, "utf8");
    expect(text).not.toMatch(/secret-(main|work|dav)/);
    expect(text.match(/enc:v1:/g)).toHaveLength(5);
    expect(text).toContain("x-future-field");
    const backups = (await readdir(dir)).filter((f) => f.startsWith("accounts.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(dir, backups[0]), "utf8")).toContain("secret-main");
    // Idempotent: a second run changes nothing and makes no new backup.
    expect(
      await runCli(["secrets", "encrypt", "--key-file", keyFile, "--accounts", accounts]),
    ).toBe(0);
    expect((await readdir(dir)).filter((f) => f.startsWith("accounts.json.bak-"))).toHaveLength(1);
  });

  it("loads decrypted credentials only when the key is configured", async () => {
    await runCli(["secrets", "encrypt", "--key-file", keyFile, "--accounts", accounts]);
    const store = new AccountsStore(accounts, await decrypting());
    await store.reload();
    expect(store.resolve("main").imap.pass).toBe("secret-main");
    expect(store.resolve("main").caldav?.pass).toBe("secret-dav");
    // Without SECRETS_ENCRYPTION the value is literal, exactly like v0.2.x.
    const plain = new AccountsStore(accounts);
    await plain.reload();
    expect(plain.resolve("main").imap.pass).toMatch(/^enc:v1:/);
  });

  it("fails clearly with the wrong key and never leaks values", async () => {
    await runCli(["secrets", "encrypt", "--key-file", keyFile, "--accounts", accounts]);
    await rm(keyFile);
    await runCli(["secrets", "init-key", "--key-file", keyFile]);
    const store = new AccountsStore(accounts, await decrypting());
    const err = await store.reload().catch((e: Error) => e);
    expect(String(err)).toContain("could not decrypt");
    expect(String(err)).not.toContain("enc:v1:");
  });

  it("decrypts back to the original file contents", async () => {
    const original = JSON.parse(await readFile(accounts, "utf8"));
    await runCli(["secrets", "encrypt", "--key-file", keyFile, "--accounts", accounts]);
    await runCli(["secrets", "decrypt", "--key-file", keyFile, "--accounts", accounts]);
    expect(JSON.parse(await readFile(accounts, "utf8"))).toEqual(original);
  });
});
