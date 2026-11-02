/** Builds the MCP server a single request is served by. */
import { McpServer } from "@modelcontextprotocol/server";
import type { AccountSource } from "./accounts.js";
import type { PoolLike } from "./client-pool.js";
import { registerCalendarTools } from "./tools-calendar.js";
import { registerMailTools, type MailToolOptions } from "./tools-mail.js";
import { SERVER_INSTRUCTIONS } from "./content.js";
import { TOOL_CAPABILITY, type Capability } from "./policy/capabilities.js";

/** MCP tool annotations derived from each tool's capability (clients use them for confirmation UX). */
const ANNOTATIONS: Record<Capability, Record<string, boolean>> = {
  read: { readOnlyHint: true, openWorldHint: false },
  "calendar-read": { readOnlyHint: true, openWorldHint: false },
  draft: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  organize: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  settings: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  "calendar-write": { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  send: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  destructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

/** Fill in annotations for every tool registered on this server (explicit ones win). */
function annotateTools(server: McpServer): void {
  const original = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as unknown as { registerTool: (...a: any[]) => unknown }).registerTool = (
    name: string,
    config: Record<string, unknown>,
    cb: unknown,
  ) => {
    const cap = TOOL_CAPABILITY[name];
    const annotations = cap
      ? { ...ANNOTATIONS[cap], ...(config.annotations as object | undefined) }
      : config.annotations;
    // delete_message moves to Trash by default but can delete permanently.
    if (name === "delete_message") Object.assign(annotations as object, { destructiveHint: true });
    return original(name, { ...config, annotations }, cb);
  };
}

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
  annotateTools(server);
  beforeRegister?.(server);
  registerMailTools(server, pool, accounts, mailOptions);
  registerCalendarTools(server, pool);
  return server;
}
