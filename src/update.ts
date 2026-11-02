/**
 * `mcp-mail update --check | --now | --major | --enable-auto | --disable-auto`
 * delegates to the installer's updater (/opt/mcp-mail/bin/mcp-mail-update),
 * which downloads signed releases, switches versions and rolls back on a
 * failed health check (docs/INSTALL.md).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const UPDATER = process.env.MCP_MAIL_UPDATER ?? "/opt/mcp-mail/bin/mcp-mail-update";

export async function runUpdate(args: string[]): Promise<number> {
  if (!existsSync(UPDATER)) {
    console.error(
      `No updater at ${UPDATER}. Updates are managed by install.sh installs (docs/INSTALL.md).`,
    );
    return 2;
  }
  const r = spawnSync(UPDATER, args.length ? args : ["--check"], { stdio: "inherit" });
  return r.status ?? 1;
}
