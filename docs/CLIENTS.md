# Clients, OAuth, policies and audit

Every feature on this page is opt-in. With no `clients.json`, `OAUTH` unset and `AUDIT_LOG`
unset, mcp-mail behaves exactly like claude-mail-mcp v0.2.x.

## Identities

A request to `/mcp` is identified as one of:

| Credential                           | Client                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| The shared `AUTH_TOKEN`              | Built-in `legacy` client with full access (override it with a `clients.json` entry whose id is `legacy`) |
| An OAuth access token (`OAUTH=true`) | Matched to a client by OAuth client id, then by login user; unmatched logins get `defaultPolicy`         |
| A per-client static token            | Matched by its SHA-256 hash in `clients.json`                                                            |

## clients.json

Next to `accounts.json`, or wherever `CLIENTS_FILE` points. Changes apply without a restart.

```json
{
  "version": 1,
  "defaultPolicy": "read-draft",
  "clients": [
    { "id": "claude", "match": { "oauthUser": "claude" }, "preset": "full-no-delete" },
    {
      "id": "muse",
      "match": { "tokenHash": "sha256:…" },
      "preset": "read-draft",
      "accounts": ["main"]
    },
    {
      "id": "assistant",
      "match": { "tokenHash": "sha256:…" },
      "preset": "full-no-delete",
      "denyTools": ["create_event"],
      "sendRecipientAllowlist": ["@example.com", "boss@example.org"],
      "sendRateLimit": { "perHour": 10 }
    }
  ]
}
```

Policies grant capabilities, not tool names, so new tools are governed automatically:

| Preset           | Capabilities           | Tools                                                                      |
| ---------------- | ---------------------- | -------------------------------------------------------------------------- |
| `read-only`      | read, calendar-read    | list/search/get messages, folders, accounts, calendars, events, free slots |
| `read-draft`     | + draft                | + `create_draft`                                                           |
| `organize`       | + organize             | + `mark_read`, `move_message`, `delete_message` (to Trash)                 |
| `full-no-delete` | + send, calendar-write | + `send_message`, `create_event`                                           |
| `full`           | + destructive          | + `delete_message` with `permanent: true`                                  |

Enforcement has two layers: tools a client may not use are left out of its `tools/list`, and
every call is checked again at dispatch. `allowTools` / `denyTools` override the preset.

## Managing clients

```sh
mcp-mail clients add claude --for claude --preset full-no-delete   # OAuth login, password shown once
mcp-mail clients add muse --for muse --accounts main               # static token, shown once
mcp-mail clients list
mcp-mail clients rotate muse      # new token; the old one stops working at once
mcp-mail clients revoke muse      # this client only; others keep working
```

`--for` picks the auth mode and a default preset: `claude` (OAuth, read-draft), `chatgpt`
(OAuth, read-only), `cursor`, `vscode`, `muse`, `generic` (token, read-draft). Only token hashes
and scrypt password hashes are stored.

## Built-in OAuth 2.1

`OAUTH=true` serves OAuth discovery, dynamic client registration, `/authorize` with a login page
(PKCE S256 required), `/token` (rotating refresh tokens), `/revoke`, and protected-resource
metadata. `/mcp` then answers unauthenticated requests with a `WWW-Authenticate` challenge so
clients like Claude.ai can discover it.

| Variable                                   | Meaning                                                 |
| ------------------------------------------ | ------------------------------------------------------- |
| `TOKEN_SECRET[_FILE]`                      | HMAC key for access tokens, hex, at least 32 characters |
| `LOGIN_USER`, `LOGIN_PASSWORD_HASH[_FILE]` | Primary login (`scrypt:N:r:p:salt:hash`)                |
| `OAUTH_USERS_FILE`                         | More logins (written by `clients add --auth oauth`)     |
| `OAUTH_STATE_FILE` (or `STATE_FILE`)       | Registered clients and hashed refresh tokens            |
| `ALLOWED_REDIRECT_URIS`                    | Comma-separated; defaults to Claude.ai's callbacks      |

It reads and writes the same token, state and password formats as the reference OAuth shim, so
an existing shim deployment can point these variables at its current values and connected
clients keep working without reconnecting (see [COMPATIBILITY.md](COMPATIBILITY.md)).

Revoking a client invalidates its tokens immediately; rotating an OAuth client sets a new
password and signs out its existing sessions. Neither affects other clients.

## Audit log

`AUDIT_LOG=/var/log/mcp-mail/audit.jsonl` (or `stdout`) writes one JSON line per tool call:
timestamp, client, tool, account, mailbox, UID, recipient count for sends, result
(`ok`/`denied`/`error`), denial reason and duration. Bodies, subjects, attachments, passwords and
tokens are never logged. The file rotates at 5 MB.

```sh
mcp-mail audit tail --client muse -n 50
```

## Deleting messages

`delete_message` moves the message to the account's Trash folder (found by its `\Trash`
special-use flag or a conventional name). `permanent: true` deletes it for good and needs the
`destructive` capability.
