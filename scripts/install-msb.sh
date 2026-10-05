#!/usr/bin/env bash
# Installs a pinned microsandbox release with its official installer: the version cage is tested with (CAGE_MSB_VERSION
# in ./cage), for `cage fix`, the guided setup, `cage update` and CI.
#   MSB_VERSION=v0.7.5 scripts/install-msb.sh
# The official installer always installs the newest release, which cage hasn't been tested with, and finds it through
# the unauthenticated GitHub API, which shared IPs (CI runners, offices) run out of (HTTP 403). So we redefine its
# version lookup right before it runs; if the installer's shape ever changes, this fails loudly instead of installing
# something unexpected. CAGE_MSB_INSTALLER: a local copy of the official installer to use instead (for tests).
set -euo pipefail
: "${MSB_VERSION:?set MSB_VERSION, e.g. v0.7.5}"
[[ "$MSB_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: bad MSB_VERSION $MSB_VERSION" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [ -n "${CAGE_MSB_INSTALLER:-}" ]; then
  cp "$CAGE_MSB_INSTALLER" "$tmp/install.sh"
else
  curl -fsSL --proto =https --retry 3 --retry-connrefused https://install.microsandbox.dev -o "$tmp/install.sh" ||
    { echo "error: couldn't download the microsandbox installer (https://install.microsandbox.dev)" >&2; exit 1; }
fi
grep -q '^get_latest_version() {$' "$tmp/install.sh" || { echo "error: the microsandbox installer changed: no get_latest_version()" >&2; exit 1; }
[ "$(tail -n 1 "$tmp/install.sh")" = 'main "$@"' ] || { echo "error: the microsandbox installer changed: its last line is not main" >&2; exit 1; }
{
  sed '$d' "$tmp/install.sh"
  printf 'get_latest_version() { VERSION="%s"; }\nmain "$@"\n' "$MSB_VERSION"
} > "$tmp/install-pinned.sh"
sh "$tmp/install-pinned.sh"
got="$("${MSB_HOME:-$HOME/.microsandbox}/bin/msb" --version)"
[ "$got" = "msb ${MSB_VERSION#v}" ] || { echo "error: expected msb ${MSB_VERSION#v}, got: $got" >&2; exit 1; }
echo "installed $got"
