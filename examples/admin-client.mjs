#!/usr/bin/env node
/**
 * Minimal example of a product driving the mcp-mail admin API (/admin/v1).
 *
 *   ADMIN_URL=http://127.0.0.1:3330 ADMIN_TOKEN=... node examples/admin-client.mjs \
 *     you@example.com 'app-password' imap.example.com smtp.example.com
 *
 * Creates a tenant, tests and adds a mailbox, adds a read+draft agent client,
 * and prints the agent's endpoint and token (shown once).
 */
const base = `${process.env.ADMIN_URL ?? "http://127.0.0.1:3330"}/admin/v1`;
const token = process.env.ADMIN_TOKEN;
const [email, password, imapHost, smtpHost] = process.argv.slice(2);
if (!token || !email || !password || !imapHost || !smtpHost) {
  console.error(
    "usage: ADMIN_TOKEN=... node admin-client.mjs <email> <password> <imap-host> <smtp-host>",
  );
  process.exit(2);
}

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error}: ${data?.message}`);
  return data;
}

const tls = process.env.MAIL_TLS !== "false";
const imap = {
  host: imapHost,
  port: Number(process.env.IMAP_PORT ?? 993),
  tls,
  user: email,
  password,
};
const smtp = {
  host: smtpHost,
  port: Number(process.env.SMTP_PORT ?? 465),
  tls,
  user: email,
  password,
};

// 1. A tenant per customer, with the limits of their plan.
const tenant = await api("POST", "/tenants", {
  limits: { maxMailboxes: 3, maxClients: 5, toolCallsPerDay: 2000, allowSend: false },
});
console.log(`tenant ${tenant.id}`);

// 2. Test the credentials live, then save them. They are never returned.
const check = await api("POST", `/tenants/${tenant.id}/mailboxes/test`, { imap, smtp });
if (!check.imap.ok || !check.smtp.ok) {
  console.error("connection test failed:", check);
  await api("DELETE", `/tenants/${tenant.id}`);
  process.exit(1);
}
await api("POST", `/tenants/${tenant.id}/mailboxes`, {
  id: "main",
  label: "Main",
  default: true,
  imap,
  smtp,
  mail: { defaultFrom: email, draftsFolder: "Drafts", sentFolder: "Sent" },
});

// 3. An agent with read + draft access to that mailbox.
const {
  client,
  token: agentToken,
  endpoint,
} = await api("POST", `/tenants/${tenant.id}/clients`, {
  name: "Claude",
  type: "claude",
  preset: "read-draft",
  accounts: ["main"],
});
console.log(`client ${client.id} (${client.preset})`);
console.log(`endpoint: ${endpoint}`);
console.log(`token (shown once): ${agentToken}`);

// 4. Later: activity and usage for the dashboard.
const { entries } = await api("GET", `/tenants/${tenant.id}/audit?limit=5`);
const usage = await api("GET", `/tenants/${tenant.id}/usage`);
console.log(`${entries.length} recent audit entries, ${usage.today}/${usage.limit} calls today`);
