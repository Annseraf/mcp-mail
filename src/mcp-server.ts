/** Builds the MCP server a single request is served by. */
import { McpServer } from "@modelcontextprotocol/server";
import type { AccountSource } from "./accounts.js";
import type { PoolLike } from "./client-pool.js";
import { registerCalendarTools } from "./tools-calendar.js";
import { registerMailTools, type MailToolOptions } from "./tools-mail.js";
import { SERVER_INSTRUCTIONS } from "./content.js";

export const SERVER_NAME = "claude-mail-mcp";

export function buildMcpServer(
  version: string,
  pool: PoolLike,
  accounts: AccountSource,
  beforeRegister?: (server: McpServer) => void,
  mailOptions?: MailToolOptions,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    { instructions: SERVER_INSTRUCTIONS },
  );
  beforeRegister?.(server);
  registerMailTools(server, pool, accounts, mailOptions);
  registerCalendarTools(server, pool);
  return server;
}
