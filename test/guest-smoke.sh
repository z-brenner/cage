#!/usr/bin/env bash
# Guest-side smoke test. A Docker container stands in for the microsandbox VM: same ubuntu:24.04 image,
# same mounts and entry command that `cage up` passes to `msb run`. Needs Docker and internet.
#   test/guest-smoke.sh <claude|codex|cursor|antigravity>
# Extra docker flags (proxy, CA, network) via CAGE_TEST_DOCKER_ARGS.
set -euo pipefail
A="${1:?usage: guest-smoke.sh <agent>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
NAME="cage-smoke-$A"
VOL="cage-smoke-$A-home"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
fail() { echo "FAIL[$A]: $*" >&2; docker logs --tail 40 "$NAME" >&2 2>/dev/null || true; exit 1; }
ok() { echo "ok - [$A] $*"; }

# Render the real config through ./cage (stub msb: nothing exists yet, every call succeeds).
mkdir -p "$T/bin"
printf '#!/bin/sh\n[ "$1" = inspect ] && exit 1\nexit 0\n' > "$T/bin/msb"
chmod +x "$T/bin/msb"
export CAGE_HOME="$T/home"
PATH="$T/bin:$PATH" "$ROOT/cage" init 2>/dev/null
cat >> "$CAGE_HOME/cage.env" <<EOF
CAGE_TELEGRAM_ALLOW="111"
CAGE_TELEGRAM_TOKEN_$A="123456:FAKE-token-for-smoke-test"
EOF
PATH="$T/bin:$PATH" "$ROOT/cage" up "$A" 2>/dev/null

# shellcheck disable=SC2086
docker run -d --name "$NAME" \
  -v "$ROOT/guest:/cage:ro" -v "$CAGE_HOME/agents/$A:/cage-config:ro" -v "$VOL:/home/agent" \
  -e CC_CONNECT_VERSION=v1.5.0 ${CAGE_TEST_DOCKER_ARGS:-} \
  ubuntu:24.04 /bin/bash /cage/entry.sh "$A" >/dev/null

wait_for() { # wait_for <pattern> <seconds>
  local i=0
  # Capture first: `docker logs | grep -q` under pipefail fails when grep's early exit SIGPIPEs docker logs.
  until grep -q "$1" <<<"$(docker logs "$NAME" 2>&1)"; do
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "container exited"
    i=$((i + 5)); [ $i -gt "$2" ] && fail "timed out waiting for: $1"
    sleep 5
  done
}
wait_for "starting cc-connect as agent" 900
ok "first boot provisioned and started cc-connect"

case "$A" in cursor) BIN=cursor-agent ;; antigravity) BIN=agy ;; *) BIN="$A" ;; esac
docker exec -u agent -e HOME=/home/agent "$NAME" "$BIN" --version >/dev/null || fail "$BIN not runnable as agent"
ok "$BIN runs as the unprivileged agent user"

sleep 3
[ "$(docker exec "$NAME" ps -o user= -C cc-connect | head -1 | tr -d ' ')" = agent ] || fail "cc-connect not running as agent"
[ "$(docker exec "$NAME" stat -c '%U %a' /home/agent/.cc-connect/config.toml)" = "agent 600" ] || fail "config perms"
ok "cc-connect runs as agent with a 0600 config"

logs="$(docker logs "$NAME" 2>&1)"
grep -q 'config loaded' <<<"$logs" || fail "cc-connect did not load its config"
if grep -q 'failed to create agent' <<<"$logs"; then fail "cc-connect could not create the $A agent"; fi
ok "cc-connect loaded the config and created the $A agent"

# persistence: the home volume survives a restart and provisioning is skipped the second time
docker exec -u agent "$NAME" sh -c 'echo keep > /home/agent/work/marker'
docker restart "$NAME" >/dev/null
sleep 5
wait_for "already provisioned" 120
[ "$(docker exec "$NAME" cat /home/agent/work/marker)" = keep ] || fail "home volume lost data"
ok "restart keeps the home volume (logins, work) and skips reprovisioning"
echo "guest smoke test passed for $A"
