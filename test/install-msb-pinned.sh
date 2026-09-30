#!/usr/bin/env bash
# Installs a pinned microsandbox release with the official installer, for CI.
#   MSB_VERSION=v0.7.5 test/install-msb-pinned.sh
# The installer normally resolves "latest" through the unauthenticated GitHub API, which shared CI runner IPs
# exhaust (HTTP 403). Pinning also keeps CI from silently picking up a new microsandbox release.
# We redefine the installer's version lookup right before it runs; if the installer's shape ever changes,
# this fails loudly instead of installing something unexpected.
set -euo pipefail
: "${MSB_VERSION:?set MSB_VERSION, e.g. v0.7.5}"
[[ "$MSB_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad MSB_VERSION $MSB_VERSION" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL https://install.microsandbox.dev -o "$tmp/install.sh"
grep -q '^get_latest_version() {$' "$tmp/install.sh" || { echo "installer changed: no get_latest_version()" >&2; exit 1; }
[ "$(tail -n 1 "$tmp/install.sh")" = 'main "$@"' ] || { echo "installer changed: last line is not main" >&2; exit 1; }
{
  sed '$d' "$tmp/install.sh"
  printf 'get_latest_version() { VERSION="%s"; }\nmain "$@"\n' "$MSB_VERSION"
} > "$tmp/install-pinned.sh"
sh "$tmp/install-pinned.sh"
got="$("${MSB_HOME:-$HOME/.microsandbox}/bin/msb" --version)"
[ "$got" = "msb ${MSB_VERSION#v}" ] || { echo "expected msb ${MSB_VERSION#v}, got: $got" >&2; exit 1; }
echo "installed $got"
