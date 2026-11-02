# Shared by install.sh and mcp-mail-update. POSIX-ish bash; sourced, not executed.
# shellcheck shell=bash

REPO="${MCP_MAIL_REPO:-Annseraf/mcp-mail}"
ROOT="${MCP_MAIL_ROOT:-/opt/mcp-mail}"
COSIGN_VERSION="v3.1.4"
# shellcheck disable=SC2034 # used by mcp-mail-update
LOG_DIR="/var/log/mcp-mail"
# Releases are signed keylessly by this workflow only.
CERT_IDENTITY="^https://github.com/${REPO}/\.github/workflows/release\.yml@refs/(heads/main|tags/v.+)$"
CERT_ISSUER="https://token.actions.githubusercontent.com"

log() { printf '%s mcp-mail: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) die "unsupported CPU architecture $(uname -m)" ;;
  esac
}

# Highest stable vX.Y.Z release; $1 = major to stay on ("" = any).
latest_version() {
  local major="$1" tags
  tags="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=100" |
    grep -oE '"tag_name": *"v[0-9]+\.[0-9]+\.[0-9]+"' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')" || return 1
  if [ -n "$major" ]; then tags="$(printf '%s\n' "$tags" | grep -E "^${major}\.")" || true; fi
  printf '%s\n' "$tags" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1
}

version_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1)" = "$1" ]; }

ensure_cosign() {
  local bin="$ROOT/bin/cosign" a tmp
  [ -x "$bin" ] && return 0
  a="$(arch)"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/cosign" "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-${a}"
  curl -fsSL -o "$tmp/sums" "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign_checksums.txt"
  (cd "$tmp" && grep " cosign-linux-${a}\$" sums | sed "s/cosign-linux-${a}/cosign/" | sha256sum -c --quiet) ||
    die "cosign checksum mismatch"
  install -d -m 755 "$ROOT/bin"
  install -m 755 "$tmp/cosign" "$bin"
  rm -rf "$tmp"
}

# fetch_release <version> <dest-dir>: download, verify checksum + signature, unpack.
# MCP_MAIL_TARBALL=<file> installs a local tarball instead (tests); verification is
# then skipped only if MCP_MAIL_INSECURE_SKIP_VERIFY=1 is also set.
fetch_release() {
  local version="$1" dest="$2" tmp name
  tmp="$(mktemp -d)"
  name="mcp-mail-v${version}.tar.gz"
  if [ -n "${MCP_MAIL_TARBALL:-}" ]; then
    cp "$MCP_MAIL_TARBALL" "$tmp/$name"
    if [ "${MCP_MAIL_INSECURE_SKIP_VERIFY:-}" = "1" ]; then
      log "WARNING: signature verification skipped (MCP_MAIL_INSECURE_SKIP_VERIFY=1, local tarball)"
    else
      die "local tarballs need MCP_MAIL_INSECURE_SKIP_VERIFY=1 (testing only)"
    fi
  else
    local base="https://github.com/${REPO}/releases/download/v${version}"
    curl -fsSL -o "$tmp/$name" "$base/$name" || die "download failed: $base/$name"
    curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "download failed: SHA256SUMS"
    curl -fsSL -o "$tmp/$name.sigstore.json" "$base/$name.sigstore.json" || die "download failed: signature bundle"
    (cd "$tmp" && grep " ${name}\$" SHA256SUMS | sha256sum -c --quiet) || die "checksum mismatch for $name"
    ensure_cosign
    "$ROOT/bin/cosign" verify-blob --bundle "$tmp/$name.sigstore.json" \
      --certificate-identity-regexp "$CERT_IDENTITY" --certificate-oidc-issuer "$CERT_ISSUER" \
      "$tmp/$name" >/dev/null 2>&1 || die "signature verification failed for $name"
    log "verified $name (sha256 + sigstore signature from ${REPO} release workflow)"
  fi
  install -d -m 755 "$dest"
  tar -xzf "$tmp/$name" -C "$dest" --strip-components=1
  chown -R root:root "$dest"
  rm -rf "$tmp"
}

# health <port> <env-file>: /health + tools/list superset of the compatibility snapshot.
health() {
  local port="$1" envfile="$2"
  for _ in $(seq 1 30); do
    # shellcheck disable=SC1090
    if (set -a; . "$envfile"; set +a; node "$ROOT/current/dist/index.js" doctor --live "http://127.0.0.1:${port}") >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

switch_to() { ln -sfn "$1" "$ROOT/current.new" && mv -Tf "$ROOT/current.new" "$ROOT/current"; }

prune_releases() {
  local keep
  keep="$(readlink -f "$ROOT/current")"
  ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +4 | while read -r d; do
    [ "$(readlink -f "$d")" = "$keep" ] || rm -rf "$d"
  done
}
