#!/usr/bin/env bash
# Guest-side smoke test. A Docker container stands in for the microsandbox VM: the same image, volumes, folders,
# environment and entry command that `cage up` passes to `msb run`. Needs Docker and internet.
#   test/guest-smoke.sh <claude|codex|cursor|antigravity>
# Extra docker flags (proxy, CA, network, an apt mirror) via CAGE_TEST_DOCKER_ARGS. When it fails, what the container
# was doing (its output, its processes, apt's own logs) is printed and saved in CAGE_TEST_ARTIFACTS, if set.
set -euo pipefail
A="${1:?usage: guest-smoke.sh <agent>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
NAME="cage-smoke-$A"
VOLS=""   # the docker volumes standing in for the VM's named volumes (its home, its cache)
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  for v in $VOLS; do docker volume rm "$v" >/dev/null 2>&1 || true; done
  rm -rf "$T"
}
trap cleanup EXIT
diagnose() { # what the container was doing: its output, its processes, and apt's own logs (also saved, for CI)
  local d="${CAGE_TEST_ARTIFACTS:-$T}/guest-smoke-$A"
  mkdir -p "$d"
  docker logs "$NAME" > "$d/container.log" 2>&1 || true
  echo "--- the container's last output (all of it: $d/container.log) ---"
  docker logs --tail 80 "$NAME" 2>&1 || true
  # ps comes with the base packages, so before those it's /proc
  docker exec "$NAME" sh -c 'echo "--- processes"
    ps -eo pid,etime,args --forest 2>/dev/null ||
      for p in /proc/[0-9]*; do printf "%s %s\n" "${p#/proc/}" "$(tr "\0" " " < "$p/cmdline" 2>/dev/null)"; done
    echo "--- the step provisioning is on"; cat /run/cage-step.* 2>/dev/null
    echo "--- apt: the end of term.log"; tail -n 40 /var/log/apt/term.log 2>/dev/null
    echo "--- apt: history.log"; grep -E "^(Start-Date|End-Date|Commandline)" /var/log/apt/history.log 2>/dev/null | tail -n 24' \
    2>&1 | tee "$d/inside.txt" || true
}
fail() { echo "FAIL[$A]: $*" >&2; diagnose >&2; exit 1; }
ok() { echo "ok - [$A] $*"; }

# Render the real config through ./cage. The stub msb: nothing exists yet, every call succeeds, and `msb run`'s
# arguments are kept (NUL-separated), so the container below gets exactly what the VM would.
mkdir -p "$T/bin"
printf '#!/bin/sh\n[ "$1" = inspect ] && exit 1\n[ "$1" != run ] || printf "%%s\\0" "$@" > "%s"\nexit 0\n' "$T/msb-run" > "$T/bin/msb"
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
# The browser (codex only, to keep CI quick): Playwright MCP and Chromium install, and it loads a real page.
if [ "$A" = codex ]; then PATH="$T/bin:$PATH" "$ROOT/cage" connect add browser codex </dev/null 2>/dev/null; fi
PATH="$T/bin:$PATH" "$ROOT/cage" up "$A" 2>/dev/null
sed -i 's/^- Name:.*/- Name: Smoke Tester/' "$CAGE_HOME/brain/memory/about-me.md"

# `msb run`'s arguments as docker's: named volumes (as docker volumes of this test's own), folders, environment, and
# the image and command. A secret becomes its placeholder, as microsandbox would hand the VM.
args=() cmd=() prev="" image="" after=0
while IFS= read -r -d '' x; do
  if [ "$after" = 1 ]; then cmd+=("$x"); continue; fi
  case "$prev" in
    --mount-named) v="cage-smoke-${x#cage-}"; VOLS="$VOLS ${v%%:*}"; args+=(-v "$v") ;;
    --mount-dir) args+=(-v "$x") ;;
    -e) args+=(-e "$x") ;;
    --conf) for s in $(awk '/^secrets:/ { on = 1; next } /^[a-z]/ { on = 0 } on && /^  [A-Z][A-Z0-9_]*:$/ { sub(/:$/, ""); print $1 }' "$x"); do
        args+=(-e "$s=\$MSB_$s"); done ;;
  esac
  if [ "$x" = -- ]; then after=1; image="$prev"; fi
  prev="$x"
done < "$T/msb-run"
[ -n "$image" ] && [ ${#cmd[@]} -gt 0 ] || fail "cage up didn't run msb as expected: $(tr '\0' ' ' < "$T/msb-run")"
for want in /home/agent /var/cache/cage /cage /cage-config /memory /memory-inbox /cage-app; do
  [[ " ${args[*]} " == *":$want "* || " ${args[*]} " == *":$want:ro "* ]] || fail "cage up gives the VM no $want: ${args[*]}"
done
docker rm -f "$NAME" >/dev/null 2>&1 || true   # left over from a run that was cut short: start cold
for v in $VOLS; do docker volume rm "$v" >/dev/null 2>&1 || true; done
# shellcheck disable=SC2086
docker run -d --name "$NAME" "${args[@]}" ${CAGE_TEST_DOCKER_ARGS:-} "$image" "${cmd[@]}" >/dev/null

wait_for() { # wait_for <pattern> <seconds>
  local i=0
  # Capture first: `docker logs | grep -q` under pipefail fails when grep's early exit SIGPIPEs docker logs.
  until grep -q "$1" <<<"$(docker logs "$NAME" 2>&1)"; do
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "container exited"
    i=$((i + 5)); [ $i -gt "$2" ] && fail "timed out waiting for: $1"
    sleep 5
  done
}
wait_for "starting cc-connect as agent" 1200
ok "first boot provisioned and started cc-connect"

case "$A" in cursor) BIN=cursor-agent ;; antigravity) BIN=agy ;; *) BIN="$A" ;; esac
docker exec -u agent -e HOME=/home/agent "$NAME" "$BIN" --version >/dev/null || fail "$BIN not runnable as agent"
ok "$BIN runs as the unprivileged agent user"

# Node.js 22 from NodeSource (not Ubuntu's older one), installed while provisioning (where it's retried), not later by
# the app's chat on its own: every agent has the app
logs="$(docker logs "$NAME" 2>&1)"
node_at="$(grep -n "^provision\[$A\]: Node.js 22" <<<"$logs" | head -n 1 | cut -d: -f1)"
done_at="$(grep -n "^provision\[$A\]: done:" <<<"$logs" | head -n 1 | cut -d: -f1)"
[ -n "$node_at" ] && [ -n "$done_at" ] && [ "$node_at" -lt "$done_at" ] || fail "Node.js wasn't installed while provisioning"
[[ "$(docker exec "$NAME" node --version)" == v22.* ]] || fail "not Node.js 22: $(docker exec "$NAME" node --version)"
ok "Node.js 22 (NodeSource's) comes with provisioning"

for _ in $(seq 1 30); do
  [ "$(docker exec "$NAME" ps -o user= -C cc-connect | head -1 | tr -d ' ')" = agent ] && break
  sleep 1
done
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

# the app's chat: the relay in the VM (guest/app.mjs) reaches cc-connect's bridge, and cc-connect answers /help itself
D="$CAGE_HOME/app/$A"
in_log() { grep -q "$1" "$D/log.jsonl" 2>/dev/null; }
for _ in $(seq 1 60); do in_log '"t":"status","connected":true' && break; sleep 5; done
in_log '"t":"status","connected":true' || fail "the app's relay never reached cc-connect's bridge: $(tail -5 "$D/log.jsonl" 2>/dev/null)"
printf '%s' '{"type":"message","id":"smoke-1","session":"you","text":"/help"}' > "$D/in/.smoke-1.tmp"
mv "$D/in/.smoke-1.tmp" "$D/in/smoke-1.json"
for _ in $(seq 1 60); do in_log '"ctx":"smoke-1"' && break; sleep 2; done
in_log '"ctx":"smoke-1"' || fail "no answer to /help in the app: $(tail -5 "$D/log.jsonl" 2>/dev/null)"
ok "the app's chat: the relay reaches cc-connect, which answers /help"

if [ "$A" = codex ]; then
  # The browser gets ready in the background, after cc-connect starts (guest/browser.sh)
  wait_for 'cage-browser: ready' 900
  out="$(hx 'node /cage/mcp-try.mjs "[[\"browser_navigate\",{\"url\":\"https://example.com\"}]]" cage-browser' 2>&1 || true)"
  grep -q 'Example Domain' <<<"$out" || fail "the browser didn't load a page: $(tail -c 1200 <<<"$out")"
  grep -q 'browser  */usr/local/bin/cage-browser' <<<"$(hx 'codex mcp list' 2>&1)" || fail "codex doesn't have the browser"
  ok "browser: Playwright MCP and Chromium installed, codex has it, and it loads a real page"
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
