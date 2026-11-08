# Platform mode: multi-tenant engine and admin API

mcp-mail runs in two shapes from the same code:

- **Self-hosted (default).** One mailbox owner, `accounts.json`, one `/mcp` endpoint. Nothing on
  this page is active unless you turn it on, and behavior is identical to claude-mail-mcp v0.2.x
  (enforced by the [compatibility gate](COMPATIBILITY.md)).
- **Platform mode (opt-in).** Many tenants, each with their own mailboxes, agent clients,
  limits and audit log, managed by a product through a private admin API.

All extension points below are generic: any self-hoster or product can use them.

## MCP protocol support

Every MCP endpoint serves both protocol eras on the same URL:

| Client                                                                                | How it's served                                                                     |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 2026-07-28 (stateless, per-request `_meta`, `server/discover`)                        | SDK v2 strict handler: header validation (`-32020`), version negotiation (`-32022`) |
| 2024-11-05 to 2025-11-25 (`initialize` handshake, e.g. existing Claude.ai connectors) | Stateless, plain JSON responses, exactly as v0.2.x                                  |

## Settings

| Variable                                                 | Default              | Meaning                                                                                                                 |
| -------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `MULTI_TENANT`                                           | `false`              | Serve `POST /t/<tenantId>/mcp`                                                                                          |
| `DATA_DIR`                                               | `/var/lib/mcp-mail`  | Tenants, encrypted secrets, audit logs                                                                                  |
| `TENANT_BASE_URL`                                        | `PUBLIC_URL`         | Public origin used in endpoint URLs, e.g. `https://connect.example.com`                                                 |
| `CONFIG_PROVIDER`                                        | `store`              | `store` (admin API manages tenants) or `http` (an internal service owns tenant config)                                  |
| `CONFIG_PROVIDER_URL`, `CONFIG_PROVIDER_TOKEN[_FILE]`    |                      | For `http`: `GET <url>/tenants/<id>` with `Authorization: Bearer <token>`                                               |
| `CONFIG_CACHE_TTL_MS`                                    | `30000`              | Cache TTL for `http` config                                                                                             |
| `SECRETS_KEY_PROVIDER`                                   | `local`              | `local` (key file) or `oci` (OCI Vault)                                                                                 |
| `SECRETS_KEY_FILE`                                       | `$DATA_DIR/keys/kek` | 32-byte key-encryption key, mode 0600                                                                                   |
| `ADMIN_API`                                              | `false`              | Serve `/admin/v1` (requires `MULTI_TENANT=true`)                                                                        |
| `ADMIN_HOST` / `ADMIN_PORT`                              | `127.0.0.1` / `3330` | Must be loopback or a private address; public binds are refused                                                         |
| `ADMIN_TOKEN[_FILE]`                                     |                      | Service token, at least 32 characters                                                                                   |
| `APPROVAL_TTL_HOURS`                                     | `24`                 | How long a send waits for approval before it expires (the draft stays in Drafts)                                        |
| `APPROVAL_WEBHOOK_URL`, `APPROVAL_WEBHOOK_SECRET[_FILE]` |                      | Optional: `POST` here on every new approval request, signed `x-mcp-mail-signature: t=<unix>,v1=<hmac-sha256("t.body")>` |
| `SECRETS_ENCRYPTION`                                     | unset                | Single-tenant only: `local` decrypts `enc:v1:` passwords in `accounts.json`                                             |

## Tenants

A tenant record holds limits, mailboxes (hosts, ports, users, display names) and agent clients.
It never holds secrets: mailbox passwords live in the secret store and client tokens are stored
only as SHA-256 hashes.

**Isolation.**

- A client token is only ever checked against the tenant named in the URL, so a token for
  tenant A fails on tenant B's endpoint. Unknown tenants and bad tokens get the same `401`.
- Account ids resolve only within the tenant, and within the client's allowed mailboxes.
- IMAP/SMTP connections, decrypted credentials, rate counters and audit logs are per tenant.
- Deleting a tenant closes its connections, deletes its secrets and data key, audit log, usage
  counters and record.

**Limits** (pushed by the product, enforced by the engine): `maxMailboxes`, `maxClients`,
`toolCallsPerDay`, `allowSend`, `maxRecipientsPerSend`, `auditRetentionDays`. A suspended tenant's
agents get "This account is suspended" on every tool call.

**Client policy.** Each client has a preset that grants capabilities; tools a client may not use
are hidden from `tools/list` and rejected if called anyway. Sending additionally needs the
tenant's `allowSend` and the client's own `sendEnabled` toggle, which is off by default.

| Preset           | Capabilities                 |
| ---------------- | ---------------------------- |
| `read-only`      | read, calendar-read          |
| `read-draft`     | + draft                      |
| `organize`       | + organize (mark read, move) |
| `full-no-delete` | + send, calendar-write       |
| `full`           | + destructive (delete)       |

**Pause.** `PATCH /tenants/{id}/clients/{clientId}` with `{"paused": true}` stops a client
without revoking it: its token and settings stay, it still sees its tools, and every call is
refused with a clear message (audit reason `client-paused`) until `{"paused": false}`. Use it as
an emergency stop that doesn't make the user reconnect the agent. To stop a whole tenant, use
`/suspend`.

## Approval queue ("ask me before sending")

A client with `sendMode: "approval"` never sends directly. `send_message` saves the message,
signature and attachments included, to the mailbox's Drafts folder and tells the agent it is
waiting for the owner. The engine stores only the request: ids, the draft's Message-ID and
timestamps, never the content.

- `GET /tenants/{id}/approvals[?status=pending]` lists requests, newest first.
- `GET /tenants/{id}/approvals/{approvalId}` adds a preview read live from the draft (recipients,
  subject, plain text, attachment names), so edits made in a mail app are what gets approved.
- `POST …/approve` sends the draft as it is now, copies it to Sent and removes the draft.
  `POST …/reject` removes the draft. Each request is decided once; both are written to the
  audit log (`approved-by-owner`, `rejected-by-owner`; the held call is `awaiting-approval`).
- Requests expire after `APPROVAL_TTL_HOURS`; the draft stays in Drafts to send by hand.
- With `APPROVAL_WEBHOOK_URL` set, every new request is posted there (`type: approval.created`,
  `tenantId`, `approvalId`, `clientId`, `account`, `createdAt`, `expiresAt`) so the product can
  notify the owner. Delivery is best effort; the list endpoint is the source of truth.

Sending still needs the tenant's `allowSend` and the client's `sendEnabled`; approving is
refused while the tenant is suspended or `allowSend` is off.

## Secret store

Envelope encryption: each tenant has a random 256-bit data key; secrets are sealed with
AES-256-GCM under it (bound to tenant and secret name), and the data key is stored only wrapped
by a key-encryption key (KEK) from a key provider. Secrets can be set or replaced through the
admin API but never read back through any API, log, error or tool output.

Key providers:

- **`local`**: a KEK file. Create it with `mcp-mail secrets init-key --key-file <path>`. Keep it
  on a different volume from `DATA_DIR`, readable only by the engine user.
- **`oci`**: OCI Vault master key via the crypto endpoint's `encrypt`/`decrypt` with API-key
  request signing. Set `OCI_KMS_CRYPTO_ENDPOINT`, `OCI_KMS_KEY_ID`, `OCI_TENANCY_OCID`,
  `OCI_USER_OCID`, `OCI_KEY_FINGERPRINT`, `OCI_PRIVATE_KEY_FILE`. The signing is unit-tested
  against OCI's documented scheme; validate against your Vault before production use.

Other KMSs implement the two-method `KeyProvider` interface in `src/platform/secrets.ts`.

**Single-tenant encryption at rest** (opt-in): `mcp-mail secrets encrypt` rewrites the password
fields of `accounts.json` as `enc:v1:…` values after writing a timestamped backup; then set
`SECRETS_ENCRYPTION=local` and `SECRETS_KEY_FILE`. `mcp-mail secrets decrypt` reverses it.

## Admin API

`/admin/v1`, specified in [`openapi/admin-v1.json`](../openapi/admin-v1.json). Every response in
the integration suite is validated against the spec, and CI fails if any operation is untested.
Breaking changes ship as `/admin/v2`, with v1 kept for at least one major version.

| Area      | Operations                                                                               |
| --------- | ---------------------------------------------------------------------------------------- |
| Tenants   | create, get, suspend, unsuspend, delete (purge), set limits                              |
| Mailboxes | list, add, update (incl. password replacement), remove, test connectivity without saving |
| Clients   | list, add (returns endpoint + token once), update, revoke, rotate                        |
| Activity  | audit log (paginated, filter by client), usage per day and client                        |
| Meta      | health, version                                                                          |

A minimal product-side client is in [`examples/admin-client.mjs`](../examples/admin-client.mjs).

## Audit log

One JSONL line per tool call per tenant (`$DATA_DIR/audit/<tenant>.jsonl`, rotated at 5 MB):
timestamp, client, tool, account, mailbox, UID, recipient count for sends, result
(`ok`/`denied`/`error`), denial reason and duration. Message bodies, subjects, attachments,
passwords and tokens are never logged.

## `/version`

Public on every deployment: package version, commit SHA, build time and (for CI-built images)
the container image digest, so anyone can match a running deployment to a public commit.

## OAuth for tenant endpoints (delegated login)

Clients that can only connect through a browser sign-in (Claude.ai, ChatGPT) use OAuth. With
`TENANT_OAUTH=true` each tenant gets its own issuer at `<TENANT_BASE_URL>/t/<tenant>/`. The
engine has no user accounts, so the login step is handed to the product:

1. The client discovers OAuth from the 401 challenge on `/t/<tenant>/mcp`, registers (DCR) and
   opens `/t/<tenant>/authorize`.
2. The engine redirects the browser to `OAUTH_DELEGATE_URL` with `txn` (signed, 10 minutes),
   `tenant`, `client_name`, `redirect_host` and `return_to`.
3. The product signs the user in, checks they own the tenant, picks or creates the agent client
   (admin API `POST /tenants/<id>/clients`), and redirects to
   `return_to?txn=<txn>&client=<client id>&sig=<hex HMAC-SHA256(OAUTH_DELEGATE_SECRET, "<txn>.<client id>")>`.
   To refuse: `error=access_denied&sig=<HMAC of "<txn>.denied">`.
4. The engine issues tokens bound to that tenant and agent client. Revoking or rotating the
   client signs the session out.

| Variable                       | Meaning                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `TENANT_OAUTH`                 | `true` to enable (requires `MULTI_TENANT`)                                 |
| `TENANT_TOKEN_SECRET[_FILE]`   | Master key, 64+ hex characters; each tenant's token key is derived from it |
| `OAUTH_DELEGATE_URL`           | The product's login/consent page                                           |
| `OAUTH_DELEGATE_SECRET[_FILE]` | Shared HMAC secret, 32+ characters                                         |
| `TENANT_ALLOWED_REDIRECT_URIS` | Optional; defaults to Claude.ai's and ChatGPT's callbacks                  |

Discovery follows RFC 8414 and RFC 9728 path insertion
(`/.well-known/oauth-authorization-server/t/<tenant>`,
`/.well-known/oauth-protected-resource/t/<tenant>/mcp`) and is also served under
`/t/<tenant>/.well-known/…`. Each tenant has its own token key, state file and resource URL, so a
token for one tenant never works on another. Deleting a tenant removes its OAuth state.

## Not yet in platform mode

Single-tenant OAuth and `clients.json` policies are described in [CLIENTS.md](CLIENTS.md).
