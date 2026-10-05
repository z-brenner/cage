#!/usr/bin/env bash
# Provisions one agent twice in Docker (the same image the VMs use) with a shared cache volume: first online (cold),
# then with no network at all. The second run must succeed from the cache alone: waking up never needs a vendor.
# Each run also sets up the browser's part (provision.sh --browser, as guest/browser.sh does after each boot).
#   test/offline-wake.sh <claude|codex|cursor|antigravity>
# Extra docker flags (proxy, CA, an apt mirror) via CAGE_TEST_DOCKER_ARGS. The cold run has 12 minutes and the warm
# one 6, so both fit in CI's 20 for this step. Provisioning's own lines, each with its time, are always printed, so a
# slow step shows even when the test passes; the whole output is written to CAGE_TEST_ARTIFACTS as it comes, if set,
# so it's there even when CI stops the step.
set -euo pipefail
A="${1:?usage: offline-wake.sh <agent>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
cleanup() {
  docker rm -f "cage-wake-$A-1" "cage-wake-$A-2" >/dev/null 2>&1 || true
  docker run --rm -v "$T:/t" ubuntu:24.04 rm -rf /t/cache >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$T/cache" "$T/config"
printf 'browser|local:browser||\n' > "$T/config/connectors.list"   # the browser too: the biggest set of packages
LOGS="$T"
if [ -n "${CAGE_TEST_ARTIFACTS:-}" ]; then mkdir -p "$CAGE_TEST_ARTIFACTS" && LOGS="$CAGE_TEST_ARTIFACTS"; fi
run() { # run <n> <docker network> <label> <minutes>
  local name="cage-wake-$A-$1" log="$LOGS/offline-wake-$A-$1.log" start=$SECONDS rc=0 took
  docker rm -f "$name" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  timeout $(( $4 * 60 )) docker run --rm --name "$name" --network "$2" ${CAGE_TEST_DOCKER_ARGS:-} \
    -v "$ROOT/guest:/cage:ro" -v "$T/config:/cage-config:ro" -v "$T/cache:/var/cache/cage" \
    ubuntu:24.04 bash -c 'bash /cage/provision.sh "$1" && bash /cage/provision.sh "$1" --browser' _ "$A" > "$log" 2>&1 || rc=$?
  took=$((SECONDS - start))
  grep -E 'provision\[' "$log" | sed 's/^/    /' || true
  if [ "$rc" != 0 ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true   # when the time ran out, it's still going
    tail -40 "$log"
    if [ "$rc" = 124 ]; then echo "FAIL: $3 provisioning took more than $4 minutes"; else echo "FAIL: $3 provisioning"; fi
    exit 1
  fi
  echo "ok - $3: provisioned $A and its browser in ${took}s"
  if [ "$1" = 1 ] && [ "$took" -gt 600 ]; then
    echo "::warning::offline-wake ($A): the cold run took ${took}s; the lines above say which step was slow"
  fi
}
run 1 bridge "cold (online)" 12
run 2 none "warm (no network)" 6
warm="$LOGS/offline-wake-$A-2.log"
grep -q 'base packages (cached)' "$warm" || { cat "$warm"; echo "FAIL: not from the cache"; exit 1; }
grep -q 'browser: done' "$warm" || { cat "$warm"; echo "FAIL: the browser's part didn't install from the cache"; exit 1; }
echo "offline wake-up passed for $A"
