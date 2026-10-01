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
# WhatsApp (claude only, to keep CI quick): the adapter installs, registers with cc-connect's bridge and gets a
# linking code from WhatsApp. Nobody scans it, so the test stops there.
if [ "$A" = claude ]; then
  printf 'CAGE_WHATSAPP_MODE_claude="spare"\nCAGE_WHATSAPP_ALLOW_claude="15552223333"\nCAGE_WHATSAPP_TOKEN_claude="0123456789abcdef0123"\n' >> "$CAGE_HOME/cage.env"
fi
# A connector with a key: microsandbox would hand the VM a placeholder for it, so the container gets one too.
printf 'smoke-key\n' | PATH="$T/bin:$PATH" "$ROOT/cage" connect add demo https://mcp.deepwiki.com/mcp --header X-Cage-Key 2>/dev/null
PATH="$T/bin:$PATH" "$ROOT/cage" up "$A" 2>/dev/null
sed -i 's/^- Name:.*/- Name: Smoke Tester/' "$CAGE_HOME/brain/memory/about-me.md"

# shellcheck disable=SC2086
docker run -d --name "$NAME" \
  -v "$ROOT/guest:/cage:ro" -v "$CAGE_HOME/agents/$A:/cage-config:ro" -v "$VOL:/home/agent" \
  -v "$CAGE_HOME/brain/memory:/memory:ro" -v "$CAGE_HOME/brain/inbox/$A:/memory-inbox" \
  -e CC_CONNECT_VERSION=v1.5.0 -e 'DEMO_MCP_TOKEN=$MSB_DEMO_MCP_TOKEN' ${CAGE_TEST_DOCKER_ARGS:-} \
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

docker exec "$NAME" grep -q 'Smoke Tester' /home/agent/work/AGENTS.md || fail "AGENTS.md lacks about-me.md"
docker exec "$NAME" grep -qx '@/home/agent/work/AGENTS.md' /home/agent/.claude/CLAUDE.md || fail "CLAUDE.md doesn't import AGENTS.md"
docker exec "$NAME" test -s /home/agent/.codex/AGENTS.md || fail "no ~/.codex/AGENTS.md"
docker exec -u agent "$NAME" sh -c 'echo "# Remember" > /memory-inbox/smoke.md' || fail "agent can't write its inbox"
[ -f "$CAGE_HOME/brain/inbox/$A/smoke.md" ] || fail "inbox note didn't reach the host"
if docker exec -u agent "$NAME" sh -c 'echo x > /memory/x.md' 2>/dev/null; then fail "/memory is writable"; fi
ok "memory: about-me.md wired into AGENTS.md (and CLAUDE.md), inbox writable, /memory read-only"

# connectors: the agent's own CLI has the app, with the placeholder (never the key) in the header
hx() { docker exec -u agent -e HOME=/home/agent "$NAME" bash -lc "set -a; . /etc/cage/runtime.env; set +a; $1"; }
docker exec "$NAME" grep -qx 'MSB_DEMO_MCP_TOKEN=\\$MSB_DEMO_MCP_TOKEN' /etc/cage/runtime.env || fail "placeholder not set to itself"
docker exec "$NAME" grep -rqF 'smoke-key' /home/agent /etc/cage && fail "the key reached the VM"
docker exec "$NAME" grep -q '^- demo: mcp.deepwiki.com' /home/agent/work/AGENTS.md || fail "AGENTS.md doesn't list the connector"
case "$A" in
  claude) mcp="claude mcp list" ;; codex) mcp="codex mcp get demo" ;;
  cursor) mcp="cursor-agent mcp list" ;; antigravity) mcp="agy mcp list" ;;
esac
for _ in 1 2 3 4 5 6; do out="$(hx "$mcp" 2>&1 || true)"; grep -qE 'demo.*(Connected|ready)|transport: streamable_http|demo +http' <<<"$out" && break; sleep 10; done
grep -qE 'demo.*(Connected|ready)|transport: streamable_http|demo +http' <<<"$out" || fail "$mcp doesn't show the demo connector: $out"
case "$A" in
  claude) grep -qF 'X-Cage-Key: $MSB_DEMO_MCP_TOKEN' <<<"$(hx 'claude mcp get demo' 2>&1)" || fail "claude's header isn't the placeholder" ;;
  codex) docker exec "$NAME" grep -qF '"X-Cage-Key" = "$MSB_DEMO_MCP_TOKEN"' /home/agent/.codex/config.toml || fail "codex header" ;;
  cursor) docker exec "$NAME" jq -e '.mcpServers.demo.headers["X-Cage-Key"] == "$MSB_DEMO_MCP_TOKEN"' /home/agent/.cursor/mcp.json >/dev/null || fail "cursor header" ;;
  antigravity) docker exec "$NAME" jq -e '.mcpServers.demo.serverUrl == "https://mcp.deepwiki.com/mcp"' /home/agent/.gemini/config/mcp_config.json >/dev/null || fail "agy config" ;;
esac
ok "connectors: $mcp sees the app; its config holds only the placeholder"

if [ "$A" = claude ]; then
  wait_for "cage-whatsapp: bridge connected" 300
  for _ in $(seq 1 30); do
    st="$(docker exec "$NAME" cat /home/agent/.cage/whatsapp/status.json 2>/dev/null || true)"
    [[ "$st" == *'"state":"qr"'* ]] && break
    sleep 2
  done
  [[ "$st" == *'"state":"qr"'* ]] || fail "WhatsApp gave no linking code: $st"
  grep -q 'bridge: adapter registered" platform=whatsapp' <<<"$(docker logs "$NAME" 2>&1)" || fail "cc-connect didn't register the adapter"
  ok "whatsapp: the adapter installed, registered with cc-connect's bridge and got a linking code from WhatsApp"
fi

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
