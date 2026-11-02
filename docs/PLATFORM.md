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

| Variable                                              | Default              | Meaning                                                                                |
| ----------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `MULTI_TENANT`                                        | `false`              | Serve `POST /t/<tenantId>/mcp`                                                         |
| `DATA_DIR`                                            | `/var/lib/mcp-mail`  | Tenants, encrypted secrets, audit logs                                                 |
| `TENANT_BASE_URL`                                     | `PUBLIC_URL`         | Public origin used in endpoint URLs, e.g. `https://connect.example.com`                |
| `CONFIG_PROVIDER`                                     | `store`              | `store` (admin API manages tenants) or `http` (an internal service owns tenant config) |
| `CONFIG_PROVIDER_URL`, `CONFIG_PROVIDER_TOKEN[_FILE]` |                      | For `http`: `GET <url>/tenants/<id>` with `Authorization: Bearer <token>`              |
| `CONFIG_CACHE_TTL_MS`                                 | `30000`              | Cache TTL for `http` config                                                            |
| `SECRETS_KEY_PROVIDER`                                | `local`              | `local` (key file) or `oci` (OCI Vault)                                                |
| `SECRETS_KEY_FILE`                                    | `$DATA_DIR/keys/kek` | 32-byte key-encryption key, mode 0600                                                  |
| `ADMIN_API`                                           | `false`              | Serve `/admin/v1` (requires `MULTI_TENANT=true`)                                       |
| `ADMIN_HOST` / `ADMIN_PORT`                           | `127.0.0.1` / `3330` | Must be loopback or a private address; public binds are refused                        |
| `ADMIN_TOKEN[_FILE]`                                  |                      | Service token, at least 32 characters                                                  |
| `SECRETS_ENCRYPTION`                                  | unset                | Single-tenant only: `local` decrypts `enc:v1:` passwords in `accounts.json`            |

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

## Not yet in platform mode

Tenant endpoints use per-client static bearer tokens. OAuth for tenant endpoints (for clients
that can only sign in through a browser) is planned; single-tenant OAuth and `clients.json`
policies are described in [CLIENTS.md](CLIENTS.md).
