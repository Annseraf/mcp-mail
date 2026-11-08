# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [1.2.0](https://github.com/Annseraf/mcp-mail/compare/v1.1.0...v1.2.0) (2026-11-08)


### Features

* pause a client without revoking it ([#35](https://github.com/Annseraf/mcp-mail/issues/35)) ([4ec5d0d](https://github.com/Annseraf/mcp-mail/commit/4ec5d0dcd4d8b693b787da811e06783b04b0047b))


### Bug Fixes

* plainer message for a paused client ([#37](https://github.com/Annseraf/mcp-mail/issues/37)) ([8f86575](https://github.com/Annseraf/mcp-mail/commit/8f865754be53a8a589d2d7a8cdafe9155ff161ee))

## [1.1.0](https://github.com/Annseraf/mcp-mail/compare/v1.0.2...v1.1.0) (2026-11-07)


### Features

* approval queue for sends ("ask me before sending") ([#24](https://github.com/Annseraf/mcp-mail/issues/24)) ([3189289](https://github.com/Annseraf/mcp-mail/commit/3189289ceec7ab4fbb644160af9459484ec9d379))

## [1.0.2](https://github.com/Annseraf/mcp-mail/compare/v1.0.1...v1.0.2) (2026-11-02)


### Bug Fixes

* use the case-sensitive io.github.Annseraf MCP Registry namespace ([#21](https://github.com/Annseraf/mcp-mail/issues/21)) ([9339025](https://github.com/Annseraf/mcp-mail/commit/93390250ec5d3b88f425390ab2087a39ecd90423))

## [1.0.1](https://github.com/Annseraf/mcp-mail/compare/v1.0.0...v1.0.1) (2026-11-02)


### Bug Fixes

* publish to npm as @annseraf/mcp-mail ([#18](https://github.com/Annseraf/mcp-mail/issues/18)) ([0d2543d](https://github.com/Annseraf/mcp-mail/commit/0d2543dfae57ed4c74d72bbace3c09b81fd4b0a8))
* **release:** pin cosign-installer v4.1.2 and allow re-publishing a tag ([#17](https://github.com/Annseraf/mcp-mail/issues/17)) ([fc6f17f](https://github.com/Annseraf/mcp-mail/commit/fc6f17f796687855001ee3707e069c680fe63992))

## [1.0.0](https://github.com/Annseraf/mcp-mail/compare/v0.2.1...v1.0.0) (2026-11-02)


### Features

* ChatGPT search/fetch adapters, tool annotations, stdio transport ([a03cf20](https://github.com/Annseraf/mcp-mail/commit/a03cf2092c3f9978acfb32f90967948c3748360b))
* client identities, built-in OAuth 2.1, policies and audit log ([1c36334](https://github.com/Annseraf/mcp-mail/commit/1c36334a4b1d3c3b1cd8d948b6416604f84958e5))
* mail tool gaps, signatures and prompt-injection hygiene ([206cafe](https://github.com/Annseraf/mcp-mail/commit/206cafe49b4d05aa462446a47adf845ec3285a97))
* multi-tenant mode, envelope-encrypted secret store and admin API ([cf66db4](https://github.com/Annseraf/mcp-mail/commit/cf66db4de37e8613701924da7f7ec21e3d8d9468))
* OAuth for tenant endpoints with delegated login ([2f7682f](https://github.com/Annseraf/mcp-mail/commit/2f7682f3b969d8cf011fbd2ffc65f13e69f3f22e))
* release pipeline, one-line installer and verified auto-update ([24ec04d](https://github.com/Annseraf/mcp-mail/commit/24ec04de6afa1d03c6bf8645b95a6d091a4166eb))
* serve MCP 2026-07-28 via SDK v2 alongside legacy clients ([f6b44b1](https://github.com/Annseraf/mcp-mail/commit/f6b44b1c11984302545a98921881546cabbb8b57))


### Bug Fixes

* **install:** avoid SIGPIPE on tar listing under pipefail; CI unit uses env node ([978f3d6](https://github.com/Annseraf/mcp-mail/commit/978f3d671cad930b86aa42e37071eb054953a9d8))
* **install:** read the release's own package.json version; CI test fixes ([8870d6f](https://github.com/Annseraf/mcp-mail/commit/8870d6f8a5eae1be220ade884388ab6c420d512b))
* one McpServer per request and constant-time bearer check ([21160b0](https://github.com/Annseraf/mcp-mail/commit/21160b051d1e057b68a406754ae970508721d958))

## [0.2.1] — 2026-05-21

Security hardening pass. No new features; no breaking API changes.

### Security

- **Upgraded `nodemailer` to 8.0.7** — fixes 4 high-severity CVEs (GHSA-mm7p-fcc7-pg87 wrong-domain, GHSA-rcmh-qjqh-p98v DoS via addressparser, GHSA-c7w3-x93f-qmm8 SMTP injection via envelope.size, GHSA-vvjj-xcjg-gr5g SMTP injection via transport name).
- **Backend now binds to `127.0.0.1` by default** (`HOST` env var, default `127.0.0.1`). Defense-in-depth on top of UFW.
- **CSRF guard on `/settings/save`, `/settings/delete`, `/settings/set-default`** — Origin/Referer header must match the configured issuer. Rejects state-changing cross-origin POSTs.
- **nginx security headers added**: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow, noarchive`.
- **nginx rate-limit on auth endpoints**: 10 req/min per IP with burst of 5 on `/authorize` and `/settings`. Brute-force htpasswd attempts return 429.
- **Backend and OAuth shim now run as a dedicated non-root `mailmcp` system user** (no shell, no home directory). Both services have full systemd hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`, `ProtectKernel*`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`, `SystemCallFilter=@system-service ~@privileged @resources`.
- **Backend migrated from pm2 to a hardened systemd unit** (`claude-mail-mcp.service`). pm2 still works for local dev; production uses systemd.
- **State directory moved to `/var/lib/mail-mcp/`** (owned by `mailmcp`, chmod 700) from `/root/.config/mail-mcp/`. The htpasswd file is now `chmod 640 root:mailmcp` (was `644`).
- **New [SECURITY.md](SECURITY.md) and [docs/HARDENING.md](docs/HARDENING.md)** — full threat model, defaults explained, operator hardening checklist, walked-through scenarios.

### Added

- `HOST` env var for the listen interface (default `127.0.0.1`).

### Changed

- The DEPLOYMENT.md recipe now uses systemd for the backend (not pm2), runs as `mailmcp`, and stores state under `/var/lib/mail-mcp/`. The pm2 example is kept for local dev.

## [0.2.0] — 2026-05-21

Multi-account per deployment. Browser-based setup flow.

### Added

- **`list_accounts` tool** — returns all configured accounts (id, label, default flag, From-address, CalDAV-enabled flag), never credentials
- **Optional `account` parameter on every tool** — selects which mailbox to act on; omit for the default account
- **`accounts.json` credential store** — JSON file replaces v0.1's IMAP/SMTP env vars; chmod 600, hot-reloaded via `fs.watch`
- **Browser-based setup UI** in the bundled OAuth shim — add / edit / delete accounts through a form, no SSH required
- Friendly error when no accounts are configured: `list_accounts` returns an explanatory note; other tools surface a clear "open /settings" message

### Changed

- **BREAKING:** `.env` no longer contains IMAP_, SMTP_, CALDAV_, DEFAULT_FROM_, DRAFTS_FOLDER, SENT_FOLDER. Those move to `accounts.json`. Only PORT, PUBLIC_URL, LOG_LEVEL, AUTH_TOKEN, ACCOUNTS_FILE remain.
- Calendar tools (`list_calendars`, `list_events`, `create_event`, `find_free_slot`) are now always registered; they error with a clear message if the resolved account has no CalDAV configured.
- IMAP/SMTP/CalDAV clients are instantiated per account via a lazy `ClientPool`. Reset on every `accounts.json` change.

### Migration from v0.1

Before:
```env
IMAP_HOST=imap.mailbox.org
IMAP_USER=hi@example.com
IMAP_PASS=secret
... etc
```

After (`accounts.json`, chmod 600):
```json
{
  "version": 1,
  "accounts": [
    {
      "id": "main",
      "label": "Main mailbox",
      "default": true,
      "imap": { "host": "imap.mailbox.org", "port": 993, "user": "hi@example.com", "pass": "secret", "tls": true },
      "smtp": { "host": "smtp.mailbox.org", "port": 465, "user": "hi@example.com", "pass": "secret", "tls": true },
      "mail": { "defaultFrom": "hi@example.com", "draftsFolder": "Drafts", "sentFolder": "Sent" }
    }
  ]
}
```

Or visit `/settings` on the deployed connector and fill in the form.

## [0.1.0] — 2026-05-21

Initial release. Single-tenant alpha.

### Added

- **Mail tools (9):** `list_folders`, `list_messages`, `search_messages`, `get_message`, `send_message`, `create_draft`, `mark_read`, `move_message`, `delete_message`
- **Calendar tools (4):** `list_calendars`, `list_events`, `create_event`, `find_free_slot` — only registered if `CALDAV_URL` is set
- IMAP via `imapflow` (single long-lived connection + per-mailbox locks)
- SMTP via `nodemailer` (optional best-effort copy to Sent folder)
- CalDAV via `tsdav` + iCalendar parsing via `ical.js`
- Bearer-token auth on `/mcp`, public `/health` endpoint
- Streamable HTTP MCP transport (compatible with Claude.ai web)
- pm2 ecosystem config for production deployment

### Known limitations

- Single-tenant: one IMAP/SMTP/CalDAV credential set per deployment
- `find_free_slot` working-hours window is interpreted in UTC — pass ISO with offset for local-time anchoring
- CalDAV does not send iMIP invitations automatically (attendees on `create_event` are stored but not notified)
- No threading view (`list_threads` planned for v0.3)
