/**
 * Maintenance commands: `mcp-mail secrets <init-key|encrypt|decrypt>`.
 * (Full CLI — clients, audit, doctor, update — arrives in later releases.)
 */
import { copyFile, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "./platform/fsutil.js";
import {
  decryptValue,
  encryptValue,
  isEncrypted,
  loadKey,
  mapPasswords,
} from "./platform/local-secrets.js";
import { LocalKeyFileProvider } from "./platform/secrets.js";

const USAGE = `Usage:
  mcp-mail secrets init-key [--key-file <path>]       create a new 32-byte key file (0600)
  mcp-mail secrets encrypt  [--key-file <path>] [--accounts <path>]
  mcp-mail secrets decrypt  [--key-file <path>] [--accounts <path>]

Defaults: --key-file $SECRETS_KEY_FILE, --accounts $ACCOUNTS_FILE.
encrypt/decrypt write a timestamped backup next to accounts.json first.
Then set SECRETS_ENCRYPTION=local so the server decrypts at load time.`;

function arg(args: string[], name: string, fallback?: string): string {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (!v) throw new Error(`${name} is required (or set its environment variable)\n\n${USAGE}`);
  return v;
}

export async function runCli(argv: string[]): Promise<number> {
  const [group, cmd, ...rest] = argv;
  if (group !== "secrets" || !cmd) {
    console.error(USAGE);
    return 2;
  }
  const keyFile = () => arg(rest, "--key-file", process.env.SECRETS_KEY_FILE);
  if (cmd === "init-key") {
    await LocalKeyFileProvider.generate(keyFile());
    console.log(
      `Created ${keyFile()} (mode 600). Keep it off the data volume and back it up separately.`,
    );
    return 0;
  }
  if (cmd !== "encrypt" && cmd !== "decrypt") {
    console.error(USAGE);
    return 2;
  }
  const accounts = arg(rest, "--accounts", process.env.ACCOUNTS_FILE);
  const key = await loadKey(keyFile());
  const doc = JSON.parse(await readFile(accounts, "utf8"));
  const changed = mapPasswords(doc, (v) =>
    cmd === "encrypt"
      ? isEncrypted(v)
        ? v
        : encryptValue(key, v)
      : isEncrypted(v)
        ? decryptValue(key, v)
        : v,
  );
  if (changed === 0) {
    console.log(`Nothing to ${cmd}.`);
    return 0;
  }
  const backup = `${accounts}.bak-${new Date().toISOString().replace(/[:.]/g, "")}-${randomBytes(2).toString("hex")}`;
  await copyFile(accounts, backup);
  await writeFileAtomic(accounts, JSON.stringify(doc, null, 2) + "\n");
  console.log(
    `${cmd === "encrypt" ? "Encrypted" : "Decrypted"} ${changed} password field(s). Backup: ${backup}`,
  );
  return 0;
}
