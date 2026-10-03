#!/usr/bin/env bash
# Package the exported data (frontend/public/data, from export-data.mjs) as a
# GitHub Release asset and point the Pages deploy at it via data-release.txt.
# Commit and push data-release.txt afterwards to deploy.
set -euo pipefail
cd "$(dirname "$0")/.."

ver=$(node -p "require('./frontend/public/data/manifest.json').version")
tag="data-$ver"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

tar -cf "$tmp/data.tar" -C frontend/public/data manifest.json "$ver"
echo "data.tar: $(du -h "$tmp/data.tar" | cut -f1)"
gh release create "$tag" "$tmp/data.tar" \
  --title "Data $ver" \
  --notes "Static data for the Pages build (tools/export-data.mjs, version $ver)."
echo "$tag" > data-release.txt
echo "data-release.txt -> $tag"
