# Hardening guide

This document covers the security posture of a default `claude-mail-mcp` deployment and the choices an operator should make.

It is opinionated and assumes the deployment layout from [DEPLOYMENT.md](DEPLOYMENT.md) (Linux + nginx + systemd + Let's Encrypt). If you're running something else, treat this as a checklist of properties to recreate.

## What the default deployment gives you

When you follow [DEPLOYMENT.md](DEPLOYMENT.md), you end up with:

```
┌────────────────────────────────────────────────────────────┐
│ Internet → nginx (TLS, HSTS, security headers, rate-limit) │
└──────┬─────────────────────────────────────────────────────┘
       │
       │  proxy_pass http://127.0.0.1:3221  (OAuth shim)
       │  proxy_pass http://127.0.0.1:3220  (/health only)
       ▼
┌────────────────────────────────┐   ┌────────────────────────────────┐
│ mcp-oauth-shim-mail.service    │   │ claude-mail-mcp.service         │
│ user=mailmcp                   │   │ user=mailmcp                    │
│ bound 127.0.0.1:3221           │   │ bound 127.0.0.1:3220            │
│ NoNewPrivileges, ProtectSystem │   │ NoNewPrivileges, ProtectSystem  │
│ ReadWritePaths=/var/lib/mail-… │   │ ReadWritePaths=/var/lib/mail-…  │
│ IPAddressAllow=127.0.0.1/32    │   │ MemoryMax=512M                  │
│ SystemCallFilter=@system-…     │   │ SystemCallFilter=@system-…      │
└──────┬─────────────────────────┘   └────────────────────────────────┘
       │
       ▼ reads /var/lib/mail-mcp/accounts.json (chmod 600, owner mailmcp)
       ▼ shells out: /usr/bin/htpasswd -vb /etc/nginx/.htpasswd_connector
                     (file chmod 640, group mailmcp)
```

### Properties this gives you

| Layer     | Property                                                | Mechanism                                                    |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| Transport | TLS 1.3, auto-renewed                                   | certbot + Let's Encrypt                                      |
| Transport | HSTS 2 years, frame-deny, nosniff, no-referrer, noindex | nginx `add_header … always`                                  |
| Transport | Brute-force throttling on auth endpoints                | nginx `limit_req zone=…auth rate=10r/m burst=5 nodelay`      |
| Network   | Backend never reachable from the public internet        | bind 127.0.0.1 + UFW default-deny + systemd `IPAddressAllow` |
| Process   | No privilege escalation                                 | `NoNewPrivileges`                                            |
| Process   | Read-only filesystem except `/var/lib/mail-mcp`         | `ProtectSystem=strict` + `ReadWritePaths=`                   |
| Process   | No access to other users' home dirs                     | `ProtectHome=true`                                           |
| Process   | Cannot tamper with kernel state                         | `ProtectKernel*`, `ProtectControlGroups`, `ProtectClock`     |
| Process   | Cannot inspect other processes                          | `ProtectProc=invisible`                                      |
| Process   | Cannot make pages executable                            | `LockPersonality`                                            |
| Process   | Limited syscall surface                                 | `SystemCallFilter=@system-service ~@privileged @resources`   |
| Process   | Resource caps                                           | `MemoryMax=512M`, `TasksMax=128`, `LimitNOFILE=4096`         |
| Auth      | OAuth 2.1 + DCR + PKCE                                  | the shim                                                     |
| Auth      | JWT RS256, 1h access / 30d refresh                      | the shim                                                     |
| Auth      | CSRF guard on state-changing endpoints                  | Origin/Referer check                                         |
| Auth      | Subprocess injection prevented                          | `execFile` + regex-gated username                            |
| Storage   | Credentials chmod 600, owned by service user            | install script                                               |

## What it does _not_ give you

These are deliberate scope decisions. If your threat model demands more, address them yourself.

### At-rest encryption of `accounts.json`

The credentials file is plain JSON, chmod 600. An attacker with root on the host can read it. This is the same security boundary as `/etc/shadow` or `~/.ssh/id_rsa`.

Adding app-level encryption would require either:

1. A key stored on the same host (which doesn't protect against a root compromise), or
2. A key provided at process start (which would have to be entered manually after every restart — operationally painful).

If you need (2), the cleanest approach is to put `/var/lib/mail-mcp` on a LUKS-encrypted volume that requires manual unlock, then accept the trade-off that an unattended restart leaves the service down until you unlock.

### Backup strategy

The service is stateful (state in `/var/lib/mail-mcp/`). Losing it means re-entering every account's credentials via the `/settings` UI. The OAuth signing key is also there; losing it invalidates all issued tokens (Claude.ai will re-OAuth on next use, no big deal).

Recommendation: include `/var/lib/mail-mcp/` in your normal backup rotation **with encryption-at-rest** (e.g. `restic`, `borgbackup`, or a `tar | gpg` pipeline). Do not back up to a cloud bucket without encryption.

### Audit log for write operations

The server logs MCP requests as structured JSON to journald (`journalctl -u claude-mail-mcp`), including authentication failures and tool invocations. It does not write a dedicated "write op X happened" log line.

For compliance-relevant deployments, consider adding a `mcp-audit.log` either via a custom log destination or by parsing the journal stream.

### Outbound network controls

The backend speaks to your mailbox provider's IMAP, SMTP and CalDAV. We don't restrict the set of hosts it can reach (`accounts.json` decides). If you want to enforce an allowlist, use a host-level egress firewall or run the service with `IPAddressAllow=` set to the IPs of your provider.

### Multi-operator scenarios

v0.2 is single-tenant in the sense that there's one htpasswd-protected operator. All configured accounts are accessible to anyone who can complete the OAuth flow. If your use case has multiple humans, deploy multiple instances on different subdomains, each with its own htpasswd entry, or wait for v0.3 (multi-tenant on the roadmap).

## Recommended additions

These improve the default but require operator action:

### 1. fail2ban jail

Add to `/etc/fail2ban/filter.d/mcp-oauth-shim.conf`:

```ini
[Definition]
failregex = ^\[oauth-shim\] login fail .+ ip=<HOST>$
            ^\[oauth-shim\] settings auth fail .+ ip=<HOST>$
journalmatch = _SYSTEMD_UNIT=mcp-oauth-shim-mail.service
```

Add to `/etc/fail2ban/jail.local`:

```ini
[mcp-oauth-shim]
enabled = true
filter = mcp-oauth-shim
backend = systemd
maxretry = 5
findtime = 600
bantime = 3600
```

Then `systemctl reload fail2ban`. This bans an IP for 1h after 5 failed logins in 10 minutes.

### 2. AUTH_TOKEN rotation

Rotate every 90 days (or after staff turnover):

```bash
NEW=$(openssl rand -hex 32)
# Update both files atomically
echo -n "$NEW" > /var/lib/mail-mcp/token.tmp
chown mailmcp:mailmcp /var/lib/mail-mcp/token.tmp
chmod 600 /var/lib/mail-mcp/token.tmp
mv /var/lib/mail-mcp/token.tmp /var/lib/mail-mcp/token

sed -i "s/^AUTH_TOKEN=.*/AUTH_TOKEN=$NEW/" /var/www/mcp-mail.markusstoeger.com/.env

systemctl restart claude-mail-mcp mcp-oauth-shim-mail
```

### 3. Outbound allowlist (optional, hardening++)

If you only ever talk to one mail provider, restrict egress:

```ini
# In claude-mail-mcp.service
IPAddressDeny=any
IPAddressAllow=127.0.0.1/32
IPAddressAllow=80.241.60.0/24   # mailbox.org range — replace with yours
```

This catches the case where a (hypothetical) RCE in a dependency tries to exfiltrate to a foreign host.

### 4. Application-layer logging to file

If you don't want to rely on journald (e.g. for SIEM ingestion), wire a syslog forwarder or pipe `journalctl -u claude-mail-mcp -f` to your log shipper.

## Threat scenarios walked through

### Scenario: brute force against the htpasswd login

Path: attacker hits `POST /authorize` with guessed usernames + passwords.
Mitigations: nginx `limit_req` (10 req/min per IP), htpasswd uses bcrypt by default, fail2ban (if installed).
Residual risk: low. Attacker would need 10+ months at burst-limit to test even a small password list.

### Scenario: attacker tricks operator into visiting evil.example.com

Path: operator is logged into `/settings`, visits a malicious page that submits a hidden form to `/settings/save`.
Mitigations: CSRF guard rejects any POST without `Origin: https://mcp-mail.…` header. Browsers set Origin on cross-origin form submissions; cannot be spoofed by JS.
Residual risk: very low.

### Scenario: dependency compromise (`imapflow`, `nodemailer`)

Path: malicious npm package update tries to read `accounts.json` or exfiltrate.
Mitigations: `ProtectSystem=strict` blocks writes outside `/var/lib/mail-mcp`. `IPAddressAllow` (if configured) blocks egress to unknown hosts. Reading credentials is still possible — at-rest encryption is the only true defence here, with the trade-offs noted above.
Residual risk: medium. Pin dependency versions in `package-lock.json` (already done), subscribe to GHSA notifications, run `npm audit` regularly.

### Scenario: MITM between Claude.ai and the connector

Path: attacker on the network path forges responses or steals OAuth tokens.
Mitigations: TLS with valid Let's Encrypt cert, HSTS, no fallback to HTTP.
Residual risk: very low (would require breaking TLS or compromising the CA).

### Scenario: root on the host

Path: attacker gains root via unrelated channel.
Mitigations: none at the application layer — all credentials are recoverable.
Residual risk: total compromise of all configured mailboxes. This is why you keep the host patched, don't share root SSH keys, and use SSH key-based auth only.

## Reporting issues

See [SECURITY.md](../SECURITY.md).
