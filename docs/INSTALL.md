# Installing and updating

## One-line install (Ubuntu / Debian, systemd)

```sh
curl -fsSL https://raw.githubusercontent.com/Annseraf/mcp-mail/main/install.sh | sudo bash -s -- --auto-update
```

| Option              | Meaning                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `--auto-update`     | Daily update check (randomized time), same major version only             |
| `--domain <host>`   | Also configure nginx and a Let's Encrypt certificate (`--email` optional) |
| `--port <n>`        | Backend port for a fresh install (default 3220)                           |
| `--version <x.y.z>` | Install a specific version                                                |
| `--dry-run`         | Show what would happen                                                    |
| `--uninstall`       | Remove the program; keeps config and mailbox data                         |

The installer is idempotent. It installs Node.js 22 if needed, creates the `mailmcp` system user,
writes `/etc/mcp-mail/mcp-mail.env` (with a generated `AUTH_TOKEN`) only if it doesn't exist, and
runs mcp-mail as a hardened systemd unit (`mcp-mail.service`) on `127.0.0.1`.

**Adopting claude-mail-mcp.** If a `claude-mail-mcp.service` unit exists, the installer reuses its
`EnvironmentFile`, user, port, accounts file and keys, starts `mcp-mail.service` with them, and
disables the old unit only after the new one passes its health check. Nothing is moved or
regenerated. To go back: `systemctl disable --now mcp-mail && systemctl enable --now claude-mail-mcp`.

## Layout

| Path                                | Contents                                                      |
| ----------------------------------- | ------------------------------------------------------------- |
| `/opt/mcp-mail/releases/<version>/` | Unpacked releases (the three newest are kept)                 |
| `/opt/mcp-mail/current`             | Symlink to the running release                                |
| `/opt/mcp-mail/bin/mcp-mail-update` | Updater                                                       |
| `/usr/local/bin/mcp-mail`           | CLI (runs with the service's settings)                        |
| `/etc/mcp-mail/mcp-mail.env`        | Settings (fresh installs)                                     |
| `/var/lib/mcp-mail/`                | `accounts.json`, `clients.json`, OAuth state (fresh installs) |
| `/var/log/mcp-mail/`                | `audit.jsonl`, `update.log`                                   |

## Updates

```sh
mcp-mail update --check          # current vs newest in the same major version
sudo mcp-mail update --now       # update now
sudo mcp-mail update --now --major
sudo mcp-mail update --enable-auto | --disable-auto
mcp-mail version
```

Every update:

1. downloads the release tarball, `SHA256SUMS` and a Sigstore bundle from GitHub Releases;
2. verifies the checksum and that the signature was made by this repository's release workflow
   (`cosign verify-blob` with a pinned cosign);
3. unpacks it next to the current release and switches the `current` symlink;
4. restarts the service and runs `mcp-mail doctor --live`: `/health` must answer and `tools/list`
   must still contain every tool in the compatibility snapshot;
5. on any failure, switches back, restarts and logs to `/var/log/mcp-mail/update.log`.

**Supply-chain trade-off.** Auto-update means trusting new releases from this repository. Releases
are built only by GitHub Actions from tagged commits (never from a laptop), signed keylessly with
Sigstore and published with build-provenance attestations, and auto-update never crosses a major
version. If you would rather review each release, leave `--auto-update` off and run
`mcp-mail update --check` yourself.

## Docker

```sh
docker run -d --name mcp-mail -p 127.0.0.1:3220:3220 \
  -e AUTH_TOKEN=$(openssl rand -hex 32) -v mcp-mail-data:/data \
  ghcr.io/annseraf/mcp-mail:1
```

Images are multi-arch (amd64, arm64) with provenance attestations
(`gh attestation verify oci://ghcr.io/annseraf/mcp-mail:1 --repo Annseraf/mcp-mail`).

## Local clients

`npx -y @annseraf/mcp-mail stdio`; see [clients/claude-desktop-code.md](clients/claude-desktop-code.md).
