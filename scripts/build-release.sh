#!/usr/bin/env bash
# Builds a cage release from the committed tree: cage-<tag>.tar.gz (one top-level cage/ folder, with a VERSION
# file), the installers, and SHA256SUMS over all of them. Used by .github/workflows/release.yml and the tests.
#   scripts/build-release.sh <tag> <out dir>
set -euo pipefail
TAG="${1:?usage: build-release.sh <tag> <out dir>}"
OUT="${2:?usage: build-release.sh <tag> <out dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "not a version tag: $TAG" >&2; exit 2; }
mkdir -p "$OUT"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -C "$ROOT" archive --format=tar --prefix=cage/ HEAD | tar -xf - -C "$work"
printf '%s\n' "$TAG" > "$work/cage/VERSION"
# Reproducible: fixed order, owner, modes (not whatever umask the builder has) and time, so the same commit always
# gives the same tarball. The time is the commit's: every release then brings newer files, which is how the running
# web app notices an update and restarts itself (host/ui/server.py, restart_when_updated).
mtime="$(git -C "$ROOT" log -1 --format=%ct HEAD)"
tar -C "$work" --sort=name --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' --mtime="@$mtime" -cf - cage |
  gzip -n -9 > "$OUT/cage-$TAG.tar.gz"
cp "$work/cage/install.sh" "$work/cage/install.ps1" "$work/cage/Install-cage.cmd" "$OUT/"
(cd "$OUT" && sha256sum "cage-$TAG.tar.gz" install.sh install.ps1 Install-cage.cmd > SHA256SUMS)
echo "built cage $TAG in $OUT"
