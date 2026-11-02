/**
 * `mcp-mail doctor [--live <url>] [--no-connect]`: validate configuration,
 * mailbox connectivity and (with --live) a running server's compatibility.
 * Exit code 0 = healthy. The auto-updater runs `doctor --live` after every
 * update and rolls back on failure.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountsStore } from "./accounts.js";
import { ImapClient } from "./imap-client.js";
import { SmtpClient } from "./smtp-client.js";
import { ClientsStore } from "./policy/clients-file.js";
import { buildInfo } from "./version.js";

type Check = { name: string; ok: boolean; detail?: string };

/** Tool names every release must keep (compatibility snapshot shipped with the release). */
function requiredTools(): string[] {
  const file = new URL("../compat/baseline/v0.2.1/meta.json", import.meta.url);
  return (JSON.parse(readFileSync(file, "utf8")) as { tools: string[] }).tools;
}

async function liveChecks(url: string, token: string | undefined): Promise<Check[]> {
  const checks: Check[] = [];
  const base = url.replace(/\/$/, "");
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    checks.push({ name: "GET /health", ok: health.ok, detail: `HTTP ${health.status}` });
  } catch (err) {
    checks.push({ name: "GET /health", ok: false, detail: String(err) });
    return checks;
  }
  if (!token) {
    checks.push({ name: "tools/list", ok: false, detail: "AUTH_TOKEN not set; can't call /mcp" });
    return checks;
  }
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: { tools: { name: string }[] } };
    const names = new Set((body.result?.tools ?? []).map((t) => t.name));
    const missing = requiredTools().filter((t) => !names.has(t));
    checks.push({
      name: "tools/list keeps every v0.2.1 tool",
      ok: res.ok && missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(", ")}` : `${names.size} tools`,
    });
  } catch (err) {
    checks.push({ name: "tools/list", ok: false, detail: String(err) });
  }
  return checks;
}

export async function runDoctor(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const live = args.includes("--live") ? args[args.indexOf("--live") + 1] : undefined;
  const connect = !args.includes("--no-connect") && !live;
  const json = args.includes("--json");
  const checks: Check[] = [];
  const info = buildInfo();
  checks.push({
    name: "version",
    ok: true,
    detail: `${info.version} (${info.commit.slice(0, 12)})`,
  });
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node.js >= 20", ok: major >= 20, detail: process.versions.node });

  if (live) {
    checks.push(...(await liveChecks(live, env.AUTH_TOKEN)));
  } else {
    const accountsFile =
      env.ACCOUNTS_FILE?.trim() ||
      (env.AUTH_TOKEN
        ? "/root/.config/mail-mcp/accounts.json"
        : path.join(os.homedir(), ".config", "mcp-mail", "accounts.json"));
    const store = new AccountsStore(accountsFile);
    try {
      await store.reload();
      checks.push({
        name: `accounts.json (${accountsFile})`,
        ok: true,
        detail: `${store.ids().length} account(s): ${store.ids().join(", ") || "none"}`,
      });
    } catch (err) {
      checks.push({
        name: `accounts.json (${accountsFile})`,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    const clientsFile =
      env.CLIENTS_FILE?.trim() || path.join(path.dirname(accountsFile), "clients.json");
    try {
      const doc = await new ClientsStore(clientsFile).load();
      checks.push({
        name: "clients.json",
        ok: true,
        detail: doc ? `${doc.clients.length} client(s)` : "absent (v0.2.x behavior: full access)",
      });
    } catch (err) {
      checks.push({
        name: "clients.json",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    if (connect) {
      for (const a of store.list()) {
        const imap = new ImapClient({
          host: a.imap.host,
          port: a.imap.port,
          user: a.imap.user,
          pass: a.imap.pass,
          secure: a.imap.tls,
        });
        try {
          await imap.listMailboxes();
          checks.push({ name: `IMAP ${a.id}`, ok: true, detail: `${a.imap.host}:${a.imap.port}` });
        } catch (err) {
          checks.push({
            name: `IMAP ${a.id}`,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await imap.close().catch(() => {});
        }
        const smtp = new SmtpClient(
          {
            host: a.smtp.host,
            port: a.smtp.port,
            user: a.smtp.user,
            pass: a.smtp.pass,
            secure: a.smtp.tls,
          },
          { from: a.mail.defaultFrom },
        );
        try {
          await smtp.verify();
          checks.push({ name: `SMTP ${a.id}`, ok: true, detail: `${a.smtp.host}:${a.smtp.port}` });
        } catch (err) {
          checks.push({
            name: `SMTP ${a.id}`,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  const failed = checks.filter((c) => !c.ok);
  if (json) console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  else
    for (const c of checks)
      console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  return failed.length ? 1 : 0;
}
