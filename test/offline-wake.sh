#!/usr/bin/env bash
# Provisions one agent twice in Docker (the same image the VMs use) with a shared cache volume: first online (cold),
# then with no network at all. The second run must succeed from the cache alone: waking up never needs a vendor.
#   test/offline-wake.sh <claude|codex|cursor|antigravity>
set -euo pipefail
A="${1:?usage: offline-wake.sh <agent>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'docker run --rm -v "$T:/t" ubuntu:24.04 rm -rf /t/cache >/dev/null 2>&1 || true; rm -rf "$T"' EXIT
mkdir -p "$T/cache" "$T/config"
printf 'browser|local:browser||\n' > "$T/config/connectors.list"   # the browser too: the biggest set of packages
run() { # run <docker network> <label>
  local start=$SECONDS
  docker run --rm --network "$1" -v "$ROOT/guest:/cage:ro" -v "$T/config:/cage-config:ro" -v "$T/cache:/var/cache/cage" \
    ubuntu:24.04 bash /cage/provision.sh "$A" > "$T/$2.log" 2>&1 || { tail -40 "$T/$2.log"; echo "FAIL: $2 provisioning"; exit 1; }
  echo "ok - $2: provisioned $A in $((SECONDS - start))s"
}
run bridge "cold (online)"
run none "warm (no network)"
grep -q 'base packages (cached)' "$T/warm (no network).log" || { cat "$T/warm (no network).log"; echo "FAIL: not from the cache"; exit 1; }
echo "offline wake-up passed for $A"
