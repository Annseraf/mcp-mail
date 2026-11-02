/**
 * Maintenance commands:
 *   mcp-mail secrets <init-key|encrypt|decrypt>
 *   mcp-mail clients <add|list|revoke|rotate>
 *   mcp-mail audit tail
 */
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { generatePassword, hashPassword } from "./auth/password.js";
import { ClientsStore, type ClientEntry, type ClientsFile } from "./policy/clients-file.js";
import { PRESETS } from "./policy/capabilities.js";
import { newClientToken } from "./platform/tokens.js";
import { readJson } from "./platform/fsutil.js";
import type { Preset } from "./platform/tenants.js";
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
  mcp-mail clients add <id> [--for claude|chatgpt|cursor|muse|vscode|generic]
                            [--auth oauth|token] [--preset <preset>] [--accounts a,b] [--name <name>]
  mcp-mail clients list
  mcp-mail clients revoke <id>
  mcp-mail clients rotate <id>
  mcp-mail audit tail [--client <id>] [-n <count>]

  mcp-mail secrets init-key [--key-file <path>]       create a new 32-byte key file (0600)
  mcp-mail secrets encrypt  [--key-file <path>] [--accounts <path>]
  mcp-mail secrets decrypt  [--key-file <path>] [--accounts <path>]

Defaults: --key-file $SECRETS_KEY_FILE, --accounts $ACCOUNTS_FILE; clients.json next to
accounts.json (or $CLIENTS_FILE); OAuth logins in oauth-users.json (or $OAUTH_USERS_FILE);
audit log at $AUDIT_LOG. Presets: ${Object.keys(PRESETS).join(", ")}.
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
  if (group === "clients") return clientsCommand(cmd, rest);
  if (group === "audit") return auditCommand(cmd, rest);
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

// ---- clients ----

/** Sensible defaults per client type (auth mode + preset). */
export const CLIENT_TYPES: Record<string, { auth: "oauth" | "token"; preset: Preset }> = {
  claude: { auth: "oauth", preset: "read-draft" },
  chatgpt: { auth: "oauth", preset: "read-only" },
  cursor: { auth: "token", preset: "read-draft" },
  vscode: { auth: "token", preset: "read-draft" },
  muse: { auth: "token", preset: "read-draft" },
  generic: { auth: "token", preset: "read-draft" },
};

const opt = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function paths() {
  const accounts = process.env.ACCOUNTS_FILE?.trim() || "/root/.config/mail-mcp/accounts.json";
  const dir = path.dirname(accounts);
  return {
    clients: process.env.CLIENTS_FILE?.trim() || path.join(dir, "clients.json"),
    users: process.env.OAUTH_USERS_FILE?.trim() || path.join(dir, "oauth-users.json"),
  };
}

async function setLogin(file: string, user: string, hash: string | undefined): Promise<void> {
  const doc = (await readJson<{ users: Record<string, string> }>(file)) ?? { users: {} };
  if (hash) doc.users[user] = hash;
  else delete doc.users[user];
  await writeFileAtomic(file, JSON.stringify(doc, null, 2) + "\n");
}

async function clientsCommand(cmd: string | undefined, args: string[]): Promise<number> {
  const p = paths();
  const store = new ClientsStore(p.clients);
  const doc: ClientsFile = (await store.load()) ?? {
    version: 1,
    defaultPolicy: "read-draft",
    clients: [],
  };
  const id = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const find = () => {
    const e = doc.clients.find((c) => c.id === id);
    if (!e) throw new Error(`No client "${id}" in ${p.clients}`);
    return e;
  };
  const authOf = (e: ClientEntry) =>
    e.match?.tokenHash ? "token" : e.match?.oauthUser ? "oauth" : "-";

  switch (cmd) {
    case "add": {
      if (!id) throw new Error(USAGE);
      if (doc.clients.some((c) => c.id === id)) throw new Error(`Client "${id}" already exists`);
      const type = opt(args, "--for") ?? "generic";
      const defaults = CLIENT_TYPES[type];
      if (!defaults)
        throw new Error(`Unknown --for ${type}. Use: ${Object.keys(CLIENT_TYPES).join(", ")}`);
      const auth = (opt(args, "--auth") ?? defaults.auth) as "oauth" | "token";
      const preset = (opt(args, "--preset") ?? defaults.preset) as Preset;
      if (!(preset in PRESETS)) throw new Error(`Unknown preset ${preset}`);
      const accounts = opt(args, "--accounts")
        ?.split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      const entry: ClientEntry = {
        id,
        name: opt(args, "--name") ?? id,
        type,
        preset,
        ...(accounts ? { accounts } : {}),
        status: "active",
      };
      let secretLine: string;
      if (auth === "token") {
        const { token, hash } = newClientToken();
        entry.match = { tokenHash: hash };
        secretLine = `Token (shown once): ${token}\nUse it as: Authorization: Bearer <token>`;
      } else {
        const password = generatePassword();
        await setLogin(p.users, id, hashPassword(password));
        entry.match = { oauthUser: id };
        secretLine = `OAuth login (shown once): username ${id}  password ${password}\nRequires OAUTH=true; sign in when the client opens the login page.`;
      }
      doc.clients.push(entry);
      await store.save(doc);
      console.log(
        `Added client "${id}" (${type}, ${auth}, preset ${preset}${accounts ? `, accounts ${accounts.join(",")}` : ""}).`,
      );
      console.log(secretLine);
      return 0;
    }
    case "list": {
      if (!doc.clients.length) {
        console.log(
          `No clients in ${p.clients}. Without clients.json every caller has full access (v0.2.x behavior).`,
        );
        return 0;
      }
      for (const c of doc.clients) {
        console.log(
          [
            c.id,
            authOf(c),
            c.preset ?? doc.defaultPolicy ?? "read-draft",
            c.accounts?.join(",") ?? "all",
            c.status ?? "active",
          ].join("\t"),
        );
      }
      return 0;
    }
    case "revoke": {
      const e = find();
      e.status = "revoked";
      e.revokedAt = new Date().toISOString();
      if (e.match?.oauthUser) await setLogin(p.users, e.match.oauthUser, undefined);
      await store.save(doc);
      console.log(
        `Revoked "${e.id}". Its tokens stop working immediately; other clients are unaffected.`,
      );
      return 0;
    }
    case "rotate": {
      const e = find();
      if (e.status === "revoked") throw new Error(`Client "${e.id}" is revoked`);
      if (e.match?.tokenHash) {
        const { token, hash } = newClientToken();
        e.match.tokenHash = hash;
        await store.save(doc);
        console.log(`New token for "${e.id}" (shown once): ${token}`);
      } else if (e.match?.oauthUser) {
        const password = generatePassword();
        await setLogin(p.users, e.match.oauthUser, hashPassword(password));
        e.notBefore = new Date().toISOString();
        await store.save(doc);
        console.log(
          `New password for "${e.id}" (shown once): ${password}\nExisting sessions were signed out.`,
        );
      } else {
        throw new Error(`Client "${e.id}" has no credential to rotate`);
      }
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

// ---- audit ----

async function auditCommand(cmd: string | undefined, args: string[]): Promise<number> {
  const file = process.env.AUDIT_LOG?.trim();
  if (cmd !== "tail" || !file || file === "stdout") {
    console.error(
      cmd !== "tail"
        ? USAGE
        : "Set AUDIT_LOG to the audit file path (audit tail can't read stdout).",
    );
    return 2;
  }
  const client = opt(args, "--client");
  const n = Number(opt(args, "-n") ?? 20);
  let lines: string[];
  try {
    lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  } catch {
    console.log("No audit entries yet.");
    return 0;
  }
  const entries = lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => !client || e.clientId === client);
  for (const e of entries.slice(-n)) {
    console.log(
      [
        e.ts,
        e.clientId,
        e.tool,
        e.account ?? "-",
        e.result,
        e.reason ?? "",
        `${e.durationMs}ms`,
      ].join("\t"),
    );
  }
  return 0;
}
