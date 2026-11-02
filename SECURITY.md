# Security Policy

## Supported versions

Until v1.0, only the latest minor release is supported with security fixes.

| Version | Supported                                                |
| ------- | -------------------------------------------------------- |
| 0.2.x   | yes                                                      |
| 0.1.x   | no — upgrade to 0.2.1 (see [CHANGELOG.md](CHANGELOG.md)) |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Preferred channel:

1. **GitHub Private Vulnerability Reporting** — open a private advisory at
   <https://github.com/maxx3250/claude-mail-mcp/security/advisories/new>

Alternative channel:

2. Email **security@markusstoeger.com**. PGP is not required.

## What to include

- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- The affected version / commit
- Whether the issue is already public anywhere

## Response timeline

- **Acknowledgement** within 48 hours
- **Initial assessment** within 7 days
- **Fix or status update** within 14 days

If the report is valid, a fix is published as a patch release and a GitHub Security Advisory with a CVE (where applicable) is opened. Reporters are credited unless they request otherwise.

## Threat model

**Assets we protect:**

- Mailbox credentials (IMAP/SMTP/CalDAV passwords in `accounts.json`)
- Email content (read access, write access, deletion)
- Calendar data
- The Bearer token gating `/mcp`
- The OAuth signing key

**Adversaries we consider:**

- Random internet attacker (port scan, brute force)
- Malicious page loaded in the operator's browser (CSRF against `/settings`)
- Compromised network path between Claude.ai and the connector (MITM)
- A compromised Claude.ai client (malicious tool calls)
- Local-system attacker (other processes on the same host)

**Out of scope:**

- A root-level compromise of the host. With root, all credentials are recoverable from `/var/lib/mail-mcp/accounts.json` — same security boundary as `~/.ssh/id_rsa` or `/etc/shadow`. We do not attempt at-rest encryption that depends on a key also stored on the same host.
- Compromise of the upstream mailbox provider.
- Phishing of the operator's htpasswd login.

## What this project does

### Transport

- TLS terminated by nginx, certificate from Let's Encrypt (90-day rotation by `certbot.timer`).
- HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` on every response.
- Backend and OAuth shim bound to `127.0.0.1` only. systemd kernel-level network filter (`IPAddressDeny=any`, `IPAddressAllow=127.0.0.1/32`) on the shim as a backstop.

### Authentication

- OAuth 2.1 + Dynamic Client Registration (RFC 7591) + PKCE (S256).
- JWT access tokens (RS256, 1h TTL), refresh tokens (30d, stored as SHA-256 hashes).
- Human login via htpasswd; brute-force throttled by nginx (`limit_req`, 10 req/min per IP).
- `/settings` UI gated by HTTP Basic Auth against the same htpasswd file.
- `/settings` POST endpoints additionally protected by Origin/Referer CSRF guard.

### Process isolation

- Both processes (backend + shim) run as the dedicated non-root `mailmcp` system user (no shell, no home directory).
- systemd hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ProtectKernel*`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`, `SystemCallFilter=@system-service ~@privileged @resources`.
- Writable filesystem limited to `/var/lib/mail-mcp` (state dir).
- Memory and task caps via `MemoryMax`, `TasksMax`, `LimitNOFILE`.

### Credentials at rest

- `accounts.json` and `token` files are owned by `mailmcp:mailmcp` and chmod 600.
- `.env` is `root:mailmcp` 640 (root can edit, the service can read).
- htpasswd file is `root:mailmcp` 640 (not world-readable).

### Input validation

- Every MCP tool input validated with [Zod](https://zod.dev) schemas.
- `accounts.json` schema-validated on every load (id pattern, port ranges, required fields).
- `/settings/save` re-validates all fields and rejects bad input with a redirect.
- Subprocess invocations (`htpasswd -vb`) use `execFile` (no shell) with a regex-gated username (`[a-zA-Z0-9_.-]{1,64}`) and a length-bounded password.

### Output filtering

- `list_accounts` returns id/label/default/From/imap_host/caldav_enabled — never credentials.
- `/health` shows the same public summary.
- Server logs never include passwords or Bearer tokens.

## Hardening checklist for operators

These are not vulnerabilities in this project, but operators should:

- [x] Run behind HTTPS with a valid certificate (the included nginx vhost + certbot does this).
- [x] Bind the Node processes to `127.0.0.1` and let nginx handle public traffic.
- [x] Run the systemd units as a dedicated non-root user.
- [x] Use a host firewall (UFW or equivalent) with default-deny incoming.
- [ ] Rotate `AUTH_TOKEN` periodically. Restart both services after rotation.
- [ ] Use app-specific passwords on providers that support them — never your main account password.
- [ ] Restrict who can reach the connector at the network level (VPN, IP allowlist, or htpasswd in front of the OAuth shim).
- [ ] Run a fail2ban jail against the shim's auth-fail log lines (`[oauth-shim] login fail` and `[oauth-shim] settings auth fail`) for additional brute-force protection.
- [ ] Keep `accounts.json` out of any backups that leave the host unencrypted.
- [ ] Subscribe to GitHub Security Advisories for this repo and the dependencies (`imapflow`, `nodemailer`, `tsdav`, `@modelcontextprotocol/sdk`).

See [docs/HARDENING.md](docs/HARDENING.md) for the full operator checklist and threat-model walkthrough.

## Prompt injection (mcp-mail)

Anyone can email you, so every email body is untrusted input for the agent reading it. mcp-mail
reduces the risk in layers:

- **Fencing (default on):** bodies, previews and thread contents are wrapped in
  `<untrusted_email_content>` delimiters with a note that the content is data, not instructions.
  Delimiters inside a message are neutralized. Disable with `UNTRUSTED_FENCING=false`.
- **Clean HTML:** HTML-only mail is converted to text with hidden elements (`display:none`,
  zero-size or white-on-white text, `hidden`), scripts, styles and images (tracking pixels)
  removed; links are shown as text with their target, so nothing is fetched automatically.
- **Server instructions:** clients receive instructions to treat email as data and to confirm
  sends and deletions with the user.
- **Least privilege:** give agents only the capabilities they need (`clients.json` presets,
  docs/CLIENTS.md). Sending can be limited by recipient allowlist and rate; permanent deletion
  needs an explicit capability.

None of this makes an agent immune: keep humans in the loop for sends and deletions.
