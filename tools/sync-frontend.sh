#!/usr/bin/env bash
# Copy the shared frontend from the server edition (unicen_js) into this repo.
#
#   tools/sync-frontend.sh            copy, then record the source commit in UPSTREAM
#   tools/sync-frontend.sh --check    report drift only; exit 1 if any
#   tools/sync-frontend.sh --routes-ported
#                                     record that frontend/src/data/routes.js now
#                                     matches unicen_js's backend/server.js at HEAD
#
# The server edition is the source: frontend changes are made there, committed,
# then copied here. Shared = every tracked file under frontend/src and
# frontend/public, plus frontend/index.html and frontend/eslint.config.js,
# EXCEPT frontend/src/data/ (each edition's own; edition.js is the seam) and
# frontend/public/data/ (exported data). package.json and vite.config.js are
# per-edition; the shared dependencies must carry the same versions, which
# this script checks.
#
# Files are copied from unicen_js's committed HEAD, never its git history:
# that history holds SSH keys and must not reach this public repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UP="${UNICEN_JS:-$ROOT/../unicen_js}"
MARK="$ROOT/UPSTREAM"
mode="${1:-sync}"

die() { echo "error: $*" >&2; exit 1; }
[ -d "$UP/.git" ] || die "no unicen_js checkout at $UP (set UNICEN_JS)"

shared() {  # tracked shared paths in a checkout ($1), relative to its root
  git -C "$1" ls-files frontend/src frontend/public frontend/index.html frontend/eslint.config.js \
    | grep -vE '^frontend/(src|public)/data/' || true
}
mark_get() { [ -f "$MARK" ] && sed -n "s/^$1=\([0-9a-f]*\).*/\1/p" "$MARK" || true; }
mark_set() {  # mark_set <key> <sha>
  local fe sv
  fe="$(mark_get frontend)"; sv="$(mark_get server)"
  [ "$1" = frontend ] && fe="$2"
  [ "$1" = server ] && sv="$2"
  cat > "$MARK" <<EOF
# Written by tools/sync-frontend.sh: the unicen_js commits this repo is in step with.
# frontend = shared frontend files copied from that commit
# server   = backend/server.js at that commit is what frontend/src/data/routes.js ports
frontend=$fe
server=$sv
EOF
}

head="$(git -C "$UP" rev-parse HEAD)"
short="$(git -C "$UP" rev-parse --short HEAD)"

if [ "$mode" = "--routes-ported" ]; then
  mark_set server "$head"
  echo "UPSTREAM: server=$short (routes.js reviewed against backend/server.js at $short)"
  exit 0
fi

# Shared dependencies: same version spec in both package.json files.
deps_drift="$(node -e '
  const [a, b] = process.argv.slice(1).map((p) => require(p));
  for (const k of ["dependencies", "devDependencies"])
    for (const [n, v] of Object.entries(a[k] || {}))
      if ((b[k] || {})[n] !== v) console.log(`  ${k} ${n}: unicen_js ${v}, here ${(b[k] || {})[n] || "missing"}`);
' "$UP/frontend/package.json" "$ROOT/frontend/package.json")"

if [ "$mode" = "--check" ]; then
  drift=0
  while read -r f; do
    if [ ! -f "$ROOT/$f" ]; then echo "  missing here: $f"; drift=1
    elif ! git -C "$UP" show "HEAD:$f" | cmp -s - "$ROOT/$f"; then echo "  differs: $f"; drift=1; fi
  done < <(shared "$UP")
  while read -r f; do
    git -C "$UP" cat-file -e "HEAD:$f" 2>/dev/null || { echo "  only here: $f"; drift=1; }
  done < <(shared "$ROOT")
  [ -z "$deps_drift" ] || { echo "$deps_drift"; drift=1; }
  if [ "$drift" = 0 ]; then echo "shared frontend matches unicen_js $short"; fi
  exit "$drift"
fi

[ "$mode" = sync ] || die "unknown option $mode"
if [ -n "$(git -C "$UP" status --porcelain -- frontend)" ]; then
  echo "warning: unicen_js has uncommitted frontend changes; copying its committed HEAD ($short) only" >&2
fi

# Remove shared files deleted upstream, then copy upstream's committed files.
while read -r f; do
  git -C "$UP" cat-file -e "HEAD:$f" 2>/dev/null || { git -C "$ROOT" rm -q "$f"; echo "removed $f"; }
done < <(shared "$ROOT")
shared "$UP" | tr '\n' '\0' | xargs -0 git -C "$UP" archive HEAD -- | tar -x -C "$ROOT"

mark_set frontend "$head"
git -C "$ROOT" status --short -- frontend UPSTREAM
[ -z "$deps_drift" ] || { echo "dependency versions differ; align frontend/package.json by hand:"; echo "$deps_drift"; }
echo "synced shared frontend from unicen_js $short"
