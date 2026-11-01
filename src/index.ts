#!/usr/bin/env node
/**
 * claude-mail-mcp — entry point (v0.2).
 *
 * Boots an Express server that exposes:
 *   - GET  /health        liveness probe + accounts summary
 *   - POST /mcp           MCP Streamable HTTP transport (Bearer-auth gated)
 *
 * v0.2: multi-account per deployment. Credentials live in accounts.json
 * (managed by the OAuth shim's /settings UI), watched via fs.watch for
 * hot-reload. Calendar tools are always registered; tools that require
 * CalDAV error friendly if the resolved account has none configured.
 */

import { timingSafeEqual } from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "./config.js";
import { AccountsStore } from "./accounts.js";
import { ClientPool } from "./client-pool.js";
import { registerMailTools } from "./tools-mail.js";
import { registerCalendarTools } from "./tools-calendar.js";

const VERSION = "0.2.1";

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): void {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] < order[config.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...extra,
  };
  console.error(JSON.stringify(line));
}

const expectedToken = Buffer.from(config.authToken);

function tokenMatches(candidate: string): boolean {
  const given = Buffer.from(candidate);
  return given.length === expectedToken.length && timingSafeEqual(given, expectedToken);
}

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !tokenMatches(match[1])) {
    log("warn", "rejected unauthenticated MCP request", {
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({
      error: "unauthorized",
      message: "Missing or invalid Bearer token",
    });
    return;
  }
  next();
}

async function main(): Promise<void> {
  const store = new AccountsStore(config.accountsFile);
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

  // One McpServer per request: a Protocol instance can only be connected to
  // one transport at a time, so a shared instance rejects concurrent requests.
  const createMcpServer = (): McpServer => {
    const mcp = new McpServer({
      name: "claude-mail-mcp",
      version: VERSION,
    });
    registerMailTools(mcp, pool, store);
    registerCalendarTools(mcp, pool);
    return mcp;
  };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "claude-mail-mcp",
      version: VERSION,
      accounts: store.publicSummaries(),
      accounts_file: config.accountsFile,
    });
  });

  app.post("/mcp", bearerAuth, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = createMcpServer();
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("error", "MCP request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  });

  app.use((req, res) => {
    res.status(404).json({
      error: "not_found",
      message: `${req.method} ${req.path} is not a valid endpoint. Use GET /health or POST /mcp.`,
    });
  });

  app.listen(config.port, config.host, () => {
    log("info", "claude-mail-mcp listening", {
      host: config.host,
      port: config.port,
      version: VERSION,
      public_url: config.publicUrl,
      accounts_file: config.accountsFile,
      accounts: store.ids(),
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    log("info", "shutting down", { signal });
    store.stop();
    await pool.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
