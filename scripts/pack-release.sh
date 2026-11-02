#!/usr/bin/env bash
# Build a self-contained release tarball: dist + production node_modules + packaging.
#   scripts/pack-release.sh [out-dir]
# VERSION_OVERRIDE=x.y.z changes the packaged version (installer/update tests only).
# BREAK=1 packages a release that fails to start (rollback tests only).
set -euo pipefail
out="${1:-release}"
version="${VERSION_OVERRIDE:-$(node -p 'require("./package.json").version')}"
name="mcp-mail-v${version}"
stage="$(mktemp -d)/$name"
mkdir -p "$stage" "$out"

[ -f dist/index.js ] || npm run build
cp -R dist package.json package-lock.json README.md LICENSE NOTICE .env.example install.sh "$stage/"
mkdir -p "$stage/compat" && cp -R compat/baseline "$stage/compat/"
cp -R packaging openapi "$stage/"
if [ -n "${VERSION_OVERRIDE:-}" ]; then
  node -e 'const f=process.argv[1],p=require(f);p.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$stage/package.json" "$version"
  node -e 'const f=process.argv[1],b=require(f);b.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(b,null,2)+"\n")' "$stage/dist/build-info.json" "$version"
fi
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)
if [ "${BREAK:-}" = 1 ]; then echo 'console.error("deliberately broken release"); process.exit(1);' >"$stage/dist/index.js"; fi
tar -C "$(dirname "$stage")" -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.tar.gz" >>SHA256SUMS 2>/dev/null || shasum -a 256 "$name.tar.gz" >>SHA256SUMS)
rm -rf "$(dirname "$stage")"
echo "$out/$name.tar.gz"
