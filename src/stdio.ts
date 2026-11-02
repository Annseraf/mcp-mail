/**
 * `mcp-mail stdio`: serve MCP over stdin/stdout for local clients (Claude
 * Desktop, Claude Code, Cursor, VS Code). No network listener and no
 * AUTH_TOKEN; the local user owns the process. Logs go to stderr only.
 */
import os from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { AccountsStore } from "./accounts.js";
import { OverlayAccountSettings } from "./account-settings.js";
import { ClientPool } from "./client-pool.js";
import { buildMcpServer } from "./mcp-server.js";
import { PRESETS } from "./policy/capabilities.js";
import { guardTools } from "./policy/guard.js";
import type { Preset } from "./platform/tenants.js";
import { buildInfo } from "./version.js";

export async function runStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const accountsFile =
    env.ACCOUNTS_FILE?.trim() || path.join(os.homedir(), ".config", "mcp-mail", "accounts.json");
  const store = new AccountsStore(
    accountsFile,
    undefined,
    env.ACCOUNT_SETTINGS_FILE?.trim() ||
      path.join(path.dirname(accountsFile), "account-settings.json"),
  );
  const pool = new ClientPool(store);
  await store.start(() => void pool.resetAll().catch(() => {}));
  const preset = env.STDIO_PRESET?.trim() as Preset | undefined;
  if (preset && !(preset in PRESETS))
    throw new Error(`STDIO_PRESET must be one of ${Object.keys(PRESETS).join(", ")}`);

  const server = buildMcpServer(
    buildInfo().version,
    pool,
    store,
    preset
      ? (s) => guardTools(s, { policy: { id: "stdio", capabilities: new Set(PRESETS[preset]) } })
      : undefined,
    { settings: new OverlayAccountSettings(store) },
  );
  await server.connect(new StdioServerTransport());
  console.error(
    JSON.stringify({
      level: "info",
      msg: "mcp-mail stdio ready",
      accounts_file: accountsFile,
      accounts: store.ids(),
      preset: preset ?? "full",
    }),
  );
  const stop = async () => {
    store.stop();
    await pool.closeAll().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("end", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
