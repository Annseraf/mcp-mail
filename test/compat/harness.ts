/**
 * Black-box harness for the compatibility gate.
 *
 * Spawns a built server (`<root>/dist/index.js`) as a child process with a
 * throwaway accounts.json pointing at a local GreenMail instance, and talks
 * to it over Streamable HTTP exactly like a client would. The same harness
 * records baselines from upstream builds and checks the current build, so
 * baseline and check can never drift apart in how they observe the server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

export const mail = {
  host: process.env.COMPAT_MAIL_HOST ?? "127.0.0.1",
  imapPort: Number(process.env.COMPAT_IMAP_PORT ?? 3143),
  smtpPort: Number(process.env.COMPAT_SMTP_PORT ?? 3025),
  users: {
    alice: { email: "alice@example.com", pass: "alicepw" },
    bob: { email: "bob@example.com", pass: "bobpw" },
  },
};

/** Folders the scenario relies on (GreenMail starts with INBOX only). */
export const FOLDERS = ["Drafts", "Sent", "Archive", "Trash"];

export function accountsFixture(): object {
  const acct = (id: string, user: { email: string; pass: string }, isDefault: boolean) => ({
    id,
    label: id === "main" ? "Main" : "Work",
    ...(isDefault ? { default: true } : {}),
    imap: { host: mail.host, port: mail.imapPort, user: user.email, pass: user.pass, tls: false },
    smtp: { host: mail.host, port: mail.smtpPort, user: user.email, pass: user.pass, tls: false },
    mail: { defaultFrom: user.email, draftsFolder: "Drafts", sentFolder: "Sent" },
  });
  return {
    version: 1,
    accounts: [acct("main", mail.users.alice, true), acct("work", mail.users.bob, false)],
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export interface RunningServer {
  url: string;
  token: string;
  rpc(method: string, params?: object, opts?: RpcOptions): Promise<RpcResult>;
  raw(body: unknown, headers?: Record<string, string>): Promise<Response>;
  stop(): Promise<void>;
}

export interface RpcOptions {
  protocolVersion?: string;
  headers?: Record<string, string>;
}

export interface RpcResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

let nextId = 1;

/** Parse either a JSON body or an SSE stream carrying one JSON-RPC response. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    return data.length ? JSON.parse(data[data.length - 1]) : undefined;
  }
  return JSON.parse(text);
}

export async function startServer(
  root: string,
  extraEnv: Record<string, string> = {},
): Promise<RunningServer> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-mail-compat-"));
  const accountsFile = path.join(dir, "accounts.json");
  await writeFile(accountsFile, JSON.stringify(accountsFixture(), null, 2));
  const port = await freePort();
  const token = randomBytes(16).toString("hex");

  const child: ChildProcess = spawn(process.execPath, [path.join(root, "dist/index.js")], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOST: "127.0.0.1",
      PORT: String(port),
      AUTH_TOKEN: token,
      ACCOUNTS_FILE: accountsFile,
      LOG_LEVEL: "warn",
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${stderr}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const raw = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  return {
    url,
    token,
    raw,
    async rpc(method, params = {}, opts = {}) {
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.protocolVersion) headers["mcp-protocol-version"] = opts.protocolVersion;
      const res = await raw({ jsonrpc: "2.0", id: nextId++, method, params }, headers);
      return { status: res.status, body: await readBody(res) };
    },
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Legacy (2025-era) handshake: initialize, then the request we care about. */
export async function legacySession(
  server: RunningServer,
  protocolVersion = "2025-03-26",
): Promise<(method: string, params?: object) => Promise<RpcResult>> {
  const init = await server.rpc("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "mcp-mail-compat", version: "0.0.0" },
  });
  if (init.status !== 200 || init.body?.error) {
    throw new Error(`initialize failed: ${init.status} ${JSON.stringify(init.body)}`);
  }
  return (method, params) => server.rpc(method, params, { protocolVersion });
}

export const MODERN_VERSION = "2026-07-28";

/**
 * 2026-07-28 client: no handshake; every request carries its protocol
 * version, capabilities and client info in `_meta`, mirrored in headers.
 */
export function modernSession(
  server: RunningServer,
): (method: string, params?: object, headers?: Record<string, string>) => Promise<RpcResult> {
  return (method, params = {}, headers = {}) => {
    const p = params as { name?: string; uri?: string; _meta?: object };
    const name = p.name ?? p.uri;
    return server.rpc(
      method,
      {
        ...p,
        _meta: {
          ...p._meta,
          "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "mcp-mail-compat", version: "0.0.0" },
        },
      },
      {
        protocolVersion: MODERN_VERSION,
        headers: { "mcp-method": method, ...(name ? { "mcp-name": name } : {}), ...headers },
      },
    );
  };
}

/** Reset both GreenMail mailboxes to a known state: folders exist, all empty, two messages in alice's INBOX. */
export async function seedMail(): Promise<void> {
  for (const user of Object.values(mail.users)) {
    const client = new ImapFlow({
      host: mail.host,
      port: mail.imapPort,
      secure: false,
      auth: { user: user.email, pass: user.pass },
      logger: false,
    });
    await client.connect();
    const existing = new Set((await client.list()).map((m) => m.path));
    for (const f of FOLDERS) if (!existing.has(f)) await client.mailboxCreate(f);
    for (const f of ["INBOX", ...FOLDERS]) {
      const lock = await client.getMailboxLock(f);
      try {
        if ((client.mailbox as { exists?: number }).exists) {
          await client.messageDelete("1:*");
        }
      } finally {
        lock.release();
      }
    }
    await client.logout();
  }

  const smtp = nodemailer.createTransport({
    host: mail.host,
    port: mail.smtpPort,
    secure: false,
    ignoreTLS: true,
  });
  await smtp.sendMail({
    from: "Carol <carol@example.com>",
    to: mail.users.alice.email,
    subject: "Quarterly report",
    text: "Hi Alice,\n\nThe report is attached.\n\nCarol",
    messageId: "<seed-1@example.com>",
    attachments: [
      { filename: "report.txt", content: "numbers go here", contentType: "text/plain" },
    ],
  });
  await smtp.sendMail({
    from: "Dave <dave@example.com>",
    to: mail.users.alice.email,
    subject: "Lunch on Friday?",
    html: "<p>Are you free for <b>lunch</b> on Friday?</p>",
    messageId: "<seed-2@example.com>",
  });
  // GreenMail delivers asynchronously; wait until both are visible.
  const client = new ImapFlow({
    host: mail.host,
    port: mail.imapPort,
    secure: false,
    auth: { user: mail.users.alice.email, pass: mail.users.alice.pass },
    logger: false,
  });
  await client.connect();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = await client.status("INBOX", { messages: true });
    if (status && (status.messages ?? 0) >= 2) break;
    if (Date.now() > deadline) throw new Error("seed messages never arrived");
    await new Promise((r) => setTimeout(r, 100));
  }
  await client.logout();
}

/** Parse the JSON text payload of a tools/call result, if it is JSON. */
export function toolPayload(result: { content?: { type: string; text?: string }[] }): unknown {
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
