# Compatibility contract

Anyone running claude-mail-mcp v0.2.x must be able to swap in mcp-mail with **zero config
edits**, and connected MCP clients (including Claude.ai custom connectors) must keep working
**without reconnecting**. This document is the contract, and CI enforces it.

## What must not change

| Surface               | Rule                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment variables | Every v0.2.x variable keeps its name, meaning and default. New variables are optional and default to v0.2.x behavior.                                                                                                                       |
| `accounts.json`       | `"version": 1` files load forever, from the same default path or `ACCOUNTS_FILE`. New fields are optional. Unknown fields are tolerated. The file is never rewritten unless you run an explicit migration command, which backs it up first. |
| Tool names            | All 14 v0.2.x tools keep their exact names.                                                                                                                                                                                                 |
| Tool inputs           | Additive only. New parameters are optional. A parameter is never made required, removed, or narrowed (type, enum, bounds, pattern, format). Relaxing is fine.                                                                               |
| Tool outputs          | Additive only. No field is renamed, removed or retyped.                                                                                                                                                                                     |
| HTTP surface          | `POST /mcp` (Bearer `AUTH_TOKEN`) and `GET /health` keep their paths and behavior.                                                                                                                                                          |
| Protocol              | Clients that use the `initialize` handshake (protocol revisions 2024-11-05 through 2025-11-25) keep working alongside newer revisions.                                                                                                      |
| OAuth continuity      | Deployments that front the server with the reference OAuth shim keep their registered clients, refresh tokens, access tokens and login (see below).                                                                                         |

## How it is enforced

`npm run test:compat` (CI job "Compatibility gate") builds the server, starts it against a
throwaway [GreenMail](https://greenmail-mail-test.github.io/greenmail/) IMAP/SMTP server, and:

1. Compares `tools/list` with the recorded baseline in `compat/baseline/<ref>/tools-list.json`.
   It fails on a removed tool, a newly required parameter, a removed parameter, or any
   narrowing of a parameter's accepted values.
2. Replays a fixed scenario of tool calls (all 14 tools, both accounts, error paths) and
   compares the JSON shape of every output with `compat/baseline/<ref>/outputs.json`. It fails
   if a field disappears or changes type, or if a call starts or stops erroring.
3. Replays the same scenario as a 2026-07-28 client (no handshake, per-request `_meta`) against
   the same baseline, and checks `server/discover`, header validation (`-32020`) and version
   negotiation (`-32022`).
4. Runs `initialize` → `tools/list` → `tools/call` for every legacy protocol revision, checks
   that legacy responses are plain JSON, Bearer auth, and overlapping concurrent requests.

Unit tests (`npm test`) also load the golden v0.2.1 `accounts.json` and `.env` files in
`compat/fixtures/upstream-v0.2.1/`, and pin the OAuth shim formats in
`compat/fixtures/oauth-shim-v0.1/`.

### Run it locally

```sh
docker run -d --name greenmail -p 127.0.0.1:3025:3025 -p 127.0.0.1:3143:3143 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=alice:alicepw@example.com,bob:bobpw@example.com -Dgreenmail.users.login=email' \
  greenmail/standalone:2.1.5
npm run test:compat
```

Point the harness at another server with `COMPAT_MAIL_HOST`, `COMPAT_IMAP_PORT` and
`COMPAT_SMTP_PORT`.

### Baselines

Baselines are recorded from a git ref, never from the code under test:

```sh
npm run compat:baseline -- v0.2.1
```

This builds the ref in a temporary worktree and replays the same scenario. Re-record only when
the scenario itself changes (for example to cover a new tool), and review the diff: a baseline
change that drops or narrows anything is a contract change.

## OAuth shim formats

Existing deployments may run the reference OAuth 2.1 shim in front of `/mcp`. Its state must
remain valid when mcp-mail's built-in OAuth replaces it:

- **Access tokens:** `base64url(JSON) "." base64url(HMAC-SHA256(first part, TOKEN_SECRET))`,
  payload `{ typ: "at", cid, scp, aud, exp }`, 1 hour lifetime.
- **Refresh tokens:** random, stored as the SHA-256 hex of the token in `state.json` under
  `refresh`, with `{ cid, scp, aud, exp }`; 30 days; rotated on use.
- **Clients:** RFC 7591 dynamic registrations in `state.json` under `clients`, keyed by `client_id`.
- **Login:** `LOGIN_USER` plus `LOGIN_PASSWORD_HASH` in the form `scrypt:N:r:p:<salt>:<hash>`
  (base64url).
- **Paths:** OAuth discovery metadata, `/register`, `/authorize`, `/token`, `/revoke`, `/login`,
  and `/.well-known/oauth-protected-resource`.

## Intentional deviations

Approved by the maintainer; the tool schemas and output fields stay compatible.

| Change                                                                                                                                                                                      | Why                                                      | Opt out                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------- |
| `delete_message` moves the message to Trash; permanent deletion needs `permanent: true` (and the `destructive` capability when a client policy applies)                                     | Reversible by default                                    | Pass `permanent: true`    |
| Email bodies and previews are wrapped in `<untrusted_email_content>` delimiters, HTML-only mail is converted with hidden text and images removed, and outputs gain a `content_notice` field | Prompt-injection hygiene ([SECURITY.md](../SECURITY.md)) | `UNTRUSTED_FENCING=false` |
| Calendar tools say "No calendar (CalDAV) is connected…" instead of pointing to a `/settings` page                                                                                           | The old text referred to a UI this project doesn't ship  | none                      |

Everything else is additive: new optional parameters, new tools, new output fields.
