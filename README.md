# mcp-mail

**mcp-mail is a self-hosted IMAP/SMTP email MCP server that lets Claude, ChatGPT, Cursor and any other MCP client read, search, draft and send email from your existing mailbox, with per-client permissions, an audit log and a one-line install.**

```sh
curl -fsSL https://raw.githubusercontent.com/Annseraf/mcp-mail/main/install.sh | sudo bash -s -- --auto-update
```

Local clients (Claude Desktop, Claude Code, Cursor, VS Code) can run it directly: `npx -y mcp-mail stdio`.

mcp-mail is a maintained continuation of [claude-mail-mcp](https://github.com/maxx3250/claude-mail-mcp) by Markus Stöger (MIT). Existing claude-mail-mcp v0.2 installs can switch with **no config changes** ([compatibility contract](docs/COMPATIBILITY.md)).

## Works with

- **AI clients:** Claude.ai, Claude Desktop, Claude Code, ChatGPT (developer mode, deep research), Cursor, VS Code, Meta Muse, and any MCP client over Streamable HTTP or stdio. Setup guides: [docs/clients](docs/clients/).
- **Mail providers:** any IMAP/SMTP mailbox: Fastmail, iCloud, Purelymail, Gmail and Google Workspace (app password), Yahoo, Zoho, Mailbox.org, Migadu, Mailcow, Dovecot/Postfix.
- **Calendars:** any CalDAV server (Fastmail, iCloud, Nextcloud, Radicale), optional.
- **MCP protocol:** 2026-07-28 (stateless) and every earlier revision since 2024-11-05, on the same endpoint.

## Tools

| Tool                                              | What it does                                                                               | Capability             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| `list_accounts`                                   | List connected mailboxes, sender names and signatures (never credentials)                  | read                   |
| `list_folders`                                    | List folders with their special use (Inbox, Sent, Drafts, Trash)                           | read                   |
| `list_messages`                                   | Newest messages in a folder, with short previews                                           | read                   |
| `search_messages`                                 | Search one folder, several, or all (`"*"`) by sender, subject, body, date, read or flagged | read                   |
| `get_message`                                     | Read one message: headers, body, attachment list, threading ids                            | read                   |
| `get_attachment`                                  | Download one attachment (size-capped)                                                      | read                   |
| `get_thread`                                      | Read a whole conversation across Inbox and Sent, oldest first                              | read                   |
| `list_threads`                                    | Group a folder's newest messages into conversations                                        | read                   |
| `create_draft`                                    | Save a draft (with attachments); `reply_to_uid` fills in the reply for you                 | draft                  |
| `mark_read`                                       | Mark a message read or unread                                                              | organize               |
| `set_flags`                                       | Star (flag), mark answered, or add custom keywords                                         | organize               |
| `move_message`                                    | Move a message to another folder                                                           | organize               |
| `delete_message`                                  | Move to Trash; `permanent: true` deletes for good                                          | organize / destructive |
| `send_message`                                    | Send an email (with attachments and signature); a copy goes to Sent                        | send                   |
| `update_account_settings`                         | Change the sender display name and signature                                               | settings               |
| `list_calendars`, `list_events`, `find_free_slot` | Read calendars and find free time                                                          | calendar-read          |
| `create_event`                                    | Create a calendar event                                                                    | calendar-write         |
| `search`, `fetch`                                 | ChatGPT deep research adapters (`CHATGPT_COMPAT=true`)                                     | read                   |

## Comparison

|                                     | **mcp-mail**                                                                  | claude-mail-mcp v0.2               |
| ----------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------- |
| Transport                           | Streamable HTTP (2026-07-28 + legacy) and stdio                               | Streamable HTTP                    |
| Auth                                | Built-in OAuth 2.1 (DCR, PKCE), per-client tokens, shared token               | Shared token + separate OAuth shim |
| Per-client permissions              | Presets, tool allow/deny, mailbox scope, recipient allowlist, send rate limit | —                                  |
| Read-only mode                      | `read-only` preset (or `STDIO_PRESET=read-only`)                              | —                                  |
| Revoke one client                   | Yes, others keep working                                                      | Rotate the shared secret           |
| Attachments                         | Send, draft and download                                                      | Send only                          |
| Threads, flags, multi-folder search | Yes                                                                           | —                                  |
| Audit log                           | JSONL, no message content                                                     | —                                  |
| Prompt-injection hygiene            | Untrusted-content fencing, hidden-HTML stripping, server instructions         | —                                  |
| Multi-tenant + admin API            | Opt-in, with OpenAPI spec                                                     | —                                  |
| Install and updates                 | One-line installer, signed releases, auto-update with rollback                | Manual                             |

Other IMAP MCP servers worth a look, depending on your needs: [codefuturist/email-mcp](https://github.com/codefuturist/email-mcp) (TypeScript, IMAP/SMTP, many tools), [tecnologicachile/mail-mcp](https://github.com/tecnologicachile/mail-mcp) (Rust, IMAP/SMTP plus Microsoft Graph and EWS) and [wildsurfer/your-mail-mcp](https://github.com/wildsurfer/your-mail-mcp) (read-only, local notmuch index). Check their READMEs for current features.

## FAQ

### How do I give ChatGPT read-only access to my email?

Run `mcp-mail clients add chatgpt --for chatgpt` (OAuth login, `read-only` preset), enable `OAUTH=true`, and add the server in ChatGPT's developer mode. ChatGPT only ever sees the read tools. See [docs/clients/chatgpt.md](docs/clients/chatgpt.md).

### Can I use this with Fastmail, iCloud, Purelymail or Gmail?

Yes. Anything that speaks IMAP and SMTP works. For Gmail, iCloud, Yahoo and Fastmail, create an app password in the provider's security settings and use it instead of your normal password.

### How do I stop an AI agent from sending email?

Give the agent a preset without `send` (`read-only`, `read-draft` or `organize`). The send tool then disappears from its tool list and is rejected if called anyway. For agents that may send, restrict recipients with `sendRecipientAllowlist` and cap volume with `sendRateLimit`. See [docs/CLIENTS.md](docs/CLIENTS.md).

### Can an email trick the AI into doing something?

Emails are untrusted input. mcp-mail wraps every body in untrusted-content delimiters, strips hidden HTML text and tracking pixels, and tells clients to confirm sends and deletions with you. Keep sending off for agents that don't need it. See [SECURITY.md](SECURITY.md).

### Does deleting a message lose it forever?

No. `delete_message` moves the message to Trash. Permanent deletion needs `permanent: true` and a client with the `destructive` capability.

### Where are my passwords stored?

In `accounts.json` on your server (optionally encrypted at rest with `mcp-mail secrets encrypt`). In multi-tenant mode, credentials are envelope-encrypted per tenant with a local key file or OCI Vault. They are never returned by any tool, API or log.

### Can my agent sign emails?

Yes. Each account can have a sender display name and a signature, set in `accounts.json` or by the agent itself with `update_account_settings`. Pass `include_signature: false` to send without it.

### I'm on claude-mail-mcp. Do I need to change anything?

No. Swap the binary; your `.env`, `accounts.json` and connected clients keep working. CI enforces this against recorded v0.2.1 behavior.

## Security model

- Binds to `127.0.0.1` by default; put nginx or Caddy in front for TLS.
- Clients authenticate with OAuth 2.1 (PKCE, rotating refresh tokens), per-client static tokens (stored hashed), or the legacy shared token.
- Every tool call is checked against the client's policy twice: when listing tools and when calling them.
- The audit log records who did what, never message content.
- Mail content is fenced as untrusted; sends and deletions should be confirmed by a human.
- Releases are built by CI from tagged commits only, with checksums and provenance attestation.

Details: [SECURITY.md](SECURITY.md), [docs/CLIENTS.md](docs/CLIENTS.md), [docs/PLATFORM.md](docs/PLATFORM.md).

## Configuration

- `.env`: transport settings ([.env.example](.env.example)). Everything new is optional.
- `accounts.json`: mailboxes (same format as claude-mail-mcp; optional `fromName`/`signature`).
- `clients.json`: per-client identities and policies ([docs/CLIENTS.md](docs/CLIENTS.md)).
- Multi-tenant mode and the admin API: [docs/PLATFORM.md](docs/PLATFORM.md).

## Upgrading

From claude-mail-mcp v0.2.x: **no config changes required.** Install mcp-mail pointing at the same `.env`, `accounts.json` and (if you use one) OAuth state. New features stay off until you enable them. Two approved behavior changes are listed in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md#intentional-deviations): deleting moves to Trash, and email content is fenced as untrusted (`UNTRUSTED_FENCING=false` restores the old output).

## Development

```sh
npm ci
npm run check        # lint, format, typecheck, unit tests, license scan, build
npm run test:compat  # compatibility gate + integration suites (needs GreenMail, see docs/COMPATIBILITY.md)
```

Adding a tool: [docs/ADDING_A_TOOL.md](docs/ADDING_A_TOOL.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Copyright (c) 2026 Markus Stöger and (c) 2026 Mohith K Das and mcp-mail contributors. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
