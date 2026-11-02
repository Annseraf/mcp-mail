#!/usr/bin/env bash
# mcp-mail installer — https://github.com/Annseraf/mcp-mail
#
#   curl -fsSL https://raw.githubusercontent.com/Annseraf/mcp-mail/main/install.sh | sudo bash -s -- [options]
#
# Options:
#   --auto-update        enable the daily update timer (same major version only)
#   --domain <host>      also set up nginx + a Let's Encrypt certificate for <host>
#   --email <addr>       contact for Let's Encrypt (optional)
#   --port <n>           backend port (default 3220, or the adopted install's port)
#   --version <x.y.z>    install a specific version (default: newest stable)
#   --channel stable     release channel (only "stable" exists)
#   --dry-run            print what would happen, change nothing
#   --uninstall          remove mcp-mail (keeps config and mailbox data)
#
# Idempotent: re-running is safe. Supports Ubuntu and Debian. Existing
# claude-mail-mcp installs are adopted in place: same config, keys, user and
# port; secrets are never moved or regenerated.
set -euo pipefail

REPO="${MCP_MAIL_REPO:-Annseraf/mcp-mail}"
ROOT="${MCP_MAIL_ROOT:-/opt/mcp-mail}"
auto_update=0 domain="" email="" port="" version="" dry=0 uninstall=0

while [ $# -gt 0 ]; do
  case "$1" in
    --auto-update) auto_update=1 ;;
    --domain) domain="$2"; shift ;;
    --email) email="$2"; shift ;;
    --port) port="$2"; shift ;;
    --version) version="${2#v}"; shift ;;
    --channel) [ "$2" = stable ] || { echo "only --channel stable is supported" >&2; exit 2; }; shift ;;
    --dry-run) dry=1 ;;
    --uninstall) uninstall=1 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf 'mcp-mail: %s\n' "$*" >&2; }
run() { if [ "$dry" = 1 ]; then printf '[dry-run] %s\n' "$*" >&2; else "$@"; fi; }

[ "$(id -u)" = 0 ] || { say "run as root (sudo)"; exit 1; }
. /etc/os-release 2>/dev/null || true
case "${ID:-}:${ID_LIKE:-}" in
  ubuntu:* | debian:* | *:*debian*) ;;
  *) say "unsupported OS '${PRETTY_NAME:-unknown}'. Ubuntu and Debian are supported; see docs/INSTALL.md for manual steps."; exit 1 ;;
esac
command -v systemctl >/dev/null || { say "systemd is required"; exit 1; }

# ---- uninstall ----
if [ "$uninstall" = 1 ]; then
  for u in mcp-mail-update.timer mcp-mail-update.service mcp-mail.service; do
    run systemctl disable --now "$u" 2>/dev/null || true
    run rm -f "/etc/systemd/system/$u"
  done
  run systemctl daemon-reload
  run rm -rf "$ROOT" /usr/local/bin/mcp-mail /etc/mcp-mail/install.conf
  say "removed mcp-mail. Config (env file, accounts) and mailbox data were kept."
  exit 0
fi

# ---- dependencies ----
need=()
for c in curl tar openssl; do command -v "$c" >/dev/null || need+=("$c"); done
[ ${#need[@]} -eq 0 ] || run apt-get install -y -qq curl tar openssl ca-certificates
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 20 ]; then
  say "installing Node.js 22 (NodeSource)"
  run bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs'
fi

# ---- adopt an existing claude-mail-mcp install, or set up fresh ----
SERVICE=mcp-mail
ADOPT_UNIT=""
if systemctl cat claude-mail-mcp.service >/dev/null 2>&1; then
  ADOPT_UNIT=claude-mail-mcp.service
  ENV_FILE="$(systemctl show -p EnvironmentFiles claude-mail-mcp.service | sed -E 's/^EnvironmentFiles=([^ ]+).*/\1/')"
  SVC_USER="$(systemctl show -p User --value claude-mail-mcp.service)"
  say "adopting existing claude-mail-mcp install (env ${ENV_FILE:-none}, user ${SVC_USER:-root})"
  [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || { say "could not find the existing EnvironmentFile; aborting without changes"; exit 1; }
else
  ENV_FILE=/etc/mcp-mail/mcp-mail.env
  SVC_USER=mailmcp
fi
[ -f /etc/mcp-mail/install.conf ] && . /etc/mcp-mail/install.conf || true
SVC_USER="${SVC_USER:-mailmcp}"

if ! id "$SVC_USER" >/dev/null 2>&1; then
  run useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SVC_USER"
fi

if [ ! -f "$ENV_FILE" ]; then
  say "creating $ENV_FILE with a new AUTH_TOKEN"
  run install -d -m 750 -o root -g "$SVC_USER" "$(dirname "$ENV_FILE")"
  if [ "$dry" = 0 ]; then
    umask 077
    cat >"$ENV_FILE" <<ENV
# mcp-mail settings — see .env.example in the release for every option.
HOST=127.0.0.1
PORT=${port:-3220}
PUBLIC_URL=${domain:+https://$domain}
LOG_LEVEL=info
AUTH_TOKEN=$(openssl rand -hex 32)
ACCOUNTS_FILE=/var/lib/mcp-mail/accounts.json
DATA_DIR=/var/lib/mcp-mail
AUDIT_LOG=/var/log/mcp-mail/audit.jsonl
ENV
    chown root:"$SVC_USER" "$ENV_FILE"
    chmod 640 "$ENV_FILE"
  fi
fi
PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
if [ -n "$port" ] && [ -n "$PORT" ] && [ "$port" != "$PORT" ]; then
  say "keeping PORT=${PORT} from ${ENV_FILE} (edit that file to change it)"
fi
PORT="${PORT:-${port:-3220}}"
ACCOUNTS_DIR="$(dirname "$(sed -n 's/^ACCOUNTS_FILE=//p' "$ENV_FILE" 2>/dev/null | tail -n1 || true)")"
[ "$ACCOUNTS_DIR" = "." ] && ACCOUNTS_DIR=/var/lib/mcp-mail
DATA_DIR="$(sed -n 's/^DATA_DIR=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
DATA_DIR="${DATA_DIR:-$ACCOUNTS_DIR}"
for d in "$ACCOUNTS_DIR" "$DATA_DIR"; do
  [ -d "$d" ] || run install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$d"
done
run install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" /var/log/mcp-mail

# ---- fetch the release ----
run install -d -m 755 "$ROOT" "$ROOT/releases" "$ROOT/bin"
tmp_lib="$(mktemp)"
if [ -n "${MCP_MAIL_TARBALL:-}" ]; then
  tar -xzf "$MCP_MAIL_TARBALL" -O --wildcards '*/packaging/lib.sh' >"$tmp_lib"
else
  curl -fsSL "https://raw.githubusercontent.com/${REPO}/main/packaging/lib.sh" -o "$tmp_lib"
fi
# shellcheck source=packaging/lib.sh
. "$tmp_lib"
if [ -z "$version" ]; then
  if [ -n "${MCP_MAIL_TARBALL:-}" ]; then
    version="$(tar -xzf "$MCP_MAIL_TARBALL" -O --wildcards '*/package.json' | sed -n 's/^  "version": "\(.*\)",$/\1/p' | head -n1)"
  else
    version="$(latest_version "")"
  fi
fi
[ -n "$version" ] || { say "could not determine a version to install"; exit 1; }
say "installing mcp-mail ${version}"
if [ "$dry" = 0 ]; then
  [ -d "$ROOT/releases/$version" ] || fetch_release "$version" "$ROOT/releases/$version"
  install -m 644 "$ROOT/releases/$version/packaging/lib.sh" "$ROOT/lib.sh"
  install -m 755 "$ROOT/releases/$version/packaging/mcp-mail-update" "$ROOT/bin/mcp-mail-update"
  prev="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
  switch_to "$ROOT/releases/$version"
fi

# ---- systemd units, CLI wrapper, install record ----
if [ "$dry" = 0 ]; then
  sed -e "s#@ENV_FILE@#${ENV_FILE}#g" -e "s#@USER@#${SVC_USER}#g" -e "s#@ROOT@#${ROOT}#g" \
    -e "s#@RW_PATHS@#${ACCOUNTS_DIR} ${DATA_DIR} /var/log/mcp-mail#g" \
    "$ROOT/current/packaging/mcp-mail.service" >/etc/systemd/system/mcp-mail.service
  install -m 644 "$ROOT/current/packaging/mcp-mail-update.service" /etc/systemd/system/
  install -m 644 "$ROOT/current/packaging/mcp-mail-update.timer" /etc/systemd/system/
  cat >/usr/local/bin/mcp-mail <<WRAP
#!/usr/bin/env bash
# mcp-mail CLI: runs the installed release with the service's settings.
set -a; [ -r "$ENV_FILE" ] && . "$ENV_FILE"; set +a
exec node "$ROOT/current/dist/index.js" "\$@"
WRAP
  chmod 755 /usr/local/bin/mcp-mail
  install -d -m 755 /etc/mcp-mail
  printf 'SERVICE=%s\nENV_FILE=%s\nPORT=%s\nSVC_USER=%s\n' "$SERVICE" "$ENV_FILE" "$PORT" "$SVC_USER" >/etc/mcp-mail/install.conf
  systemctl daemon-reload
fi

# ---- start (switching over from an adopted unit only once healthy) ----
if [ -n "$ADOPT_UNIT" ]; then run systemctl stop "$ADOPT_UNIT"; fi
run systemctl enable --now mcp-mail.service
run systemctl restart mcp-mail.service
if [ "$dry" = 0 ]; then
  if health "$PORT" "$ENV_FILE"; then
    say "mcp-mail ${version} is running on 127.0.0.1:${PORT}"
    if [ -n "$ADOPT_UNIT" ]; then
      systemctl disable "$ADOPT_UNIT" 2>/dev/null || true
      say "old unit $ADOPT_UNIT disabled (kept for rollback: systemctl disable --now mcp-mail && systemctl enable --now $ADOPT_UNIT)"
    fi
  else
    say "mcp-mail did not become healthy; rolling back"
    if [ -n "${prev:-}" ] && [ -d "$prev" ]; then switch_to "$prev"; systemctl restart mcp-mail.service; fi
    if [ -n "$ADOPT_UNIT" ]; then systemctl stop mcp-mail.service; systemctl start "$ADOPT_UNIT"; fi
    journalctl -u mcp-mail -n 30 --no-pager >&2 || true
    exit 1
  fi
fi

if [ "$auto_update" = 1 ]; then run systemctl enable --now mcp-mail-update.timer; say "auto-update enabled (daily, same major version)"; fi

# ---- optional nginx + TLS ----
if [ -n "$domain" ]; then
  run apt-get install -y -qq nginx certbot python3-certbot-nginx
  if [ "$dry" = 0 ]; then
    sed -e "s#@DOMAIN@#${domain}#g" -e "s#@PORT@#${PORT}#g" "$ROOT/current/packaging/nginx.conf" \
      >"/etc/nginx/sites-available/mcp-mail-${domain}.conf"
    ln -sfn "/etc/nginx/sites-available/mcp-mail-${domain}.conf" "/etc/nginx/sites-enabled/mcp-mail-${domain}.conf"
    nginx -t && systemctl reload nginx
    contact=(--register-unsafely-without-email)
    [ -n "$email" ] && contact=(--email "$email")
    certbot --nginx -d "$domain" --non-interactive --agree-tos --redirect "${contact[@]}"
  fi
  say "https://${domain}/mcp is ready"
fi

say "next: add mailboxes to ${ACCOUNTS_DIR}/accounts.json and clients with 'mcp-mail clients add' (docs/CLIENTS.md)"
