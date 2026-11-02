#!/usr/bin/env node
/**
 * mcp-mail entry point.
 *
 * Single-tenant (default, v0.2.x compatible):
 *   - GET  /health   liveness probe + accounts summary
 *   - GET  /version  build identity (version, commit, image digest)
 *   - POST /mcp      MCP Streamable HTTP (Bearer AUTH_TOKEN), accounts.json
 *
 * Opt-in platform mode (docs/PLATFORM.md): MULTI_TENANT=true adds
 * POST /t/<tenantId>/mcp; ADMIN_API=true serves /admin/v1 on a private
 * interface (ADMIN_HOST/ADMIN_PORT).
 */
import path from "node:path";
import type { config as Config } from "./config.js";
import { AccountsStore } from "./accounts.js";
import { runCli } from "./cli.js";
import { ClientPool } from "./client-pool.js";
import { createEngine, listen, type Log } from "./engine.js";
import { loadPlatformSettings } from "./platform/settings.js";
import { loadAuthSettings } from "./auth/settings.js";
import { decryptValue, isEncrypted, loadKey, mapPasswords } from "./platform/local-secrets.js";
import { buildInfo } from "./version.js";

const VERSION = "0.2.1";

// Loaded lazily so CLI commands don't require server env vars (AUTH_TOKEN).
let config: typeof Config;

const log: Log = (level, message, extra) => {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] < order[config.logLevel]) return;
  console.error(JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...extra }));
};

async function main(): Promise<void> {
  ({ config } = await import("./config.js"));
  const platform = loadPlatformSettings(process.env, config.publicUrl);
  let decrypt: ((doc: unknown) => void) | undefined;
  if (process.env.SECRETS_ENCRYPTION === "local") {
    const keyFile = process.env.SECRETS_KEY_FILE;
    if (!keyFile) throw new Error("SECRETS_ENCRYPTION=local requires SECRETS_KEY_FILE");
    const key = await loadKey(keyFile);
    decrypt = (doc) => {
      mapPasswords(doc as { accounts?: unknown }, (v) =>
        isEncrypted(v) ? decryptValue(key, v) : v,
      );
    };
  }
  const store = new AccountsStore(
    config.accountsFile,
    decrypt,
    process.env.ACCOUNT_SETTINGS_FILE?.trim() ||
      path.join(path.dirname(config.accountsFile), "account-settings.json"),
  );
  const pool = new ClientPool(store);
  await store.start((next, prev) => {
    log("info", "accounts.json changed", {
      previous: prev.map((a) => a.id),
      current: next.map((a) => a.id),
    });
    pool.resetAll().catch((err) =>
      log("warn", "client pool reset failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });
  log("info", "accounts loaded", {
    file: config.accountsFile,
    count: store.list().length,
    ids: store.ids(),
  });

  const engine = await createEngine({
    version: VERSION,
    authToken: config.authToken,
    publicUrl: config.publicUrl,
    accountsFile: config.accountsFile,
    auth: loadAuthSettings(process.env, config.accountsFile),
    store,
    pool,
    platform,
    log,
  });

  const servers = [await listen(engine.app, config.port, config.host)];
  log("info", "claude-mail-mcp listening", {
    host: config.host,
    port: config.port,
    version: VERSION,
    commit: buildInfo().commit,
    public_url: config.publicUrl,
    accounts_file: config.accountsFile,
    accounts: store.ids(),
    multi_tenant: platform.multiTenant,
  });
  if (engine.admin) {
    servers.push(await listen(engine.admin, platform.adminPort, platform.adminHost));
    log("info", "admin API listening", { host: platform.adminHost, port: platform.adminPort });
  }

  const shutdown = async (signal: string): Promise<void> => {
    log("info", "shutting down", { signal });
    store.stop();
    for (const s of servers) s.close();
    await Promise.all([pool.closeAll().catch(() => {}), engine.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const cli = ["secrets", "clients", "audit"].includes(process.argv[2] ?? "");
(cli ? runCli(process.argv.slice(2)).then((code) => process.exit(code)) : main()).catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
