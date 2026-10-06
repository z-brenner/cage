#!/usr/bin/env bash
# End-to-end on REAL microVMs: the real ./cage driving the real microsandbox CLI (needs msb plus
# KVM or Apple Silicon). The bot token is fake, so this proves everything up to the Telegram API.
#   test/microvm-e2e.sh <claude|codex|cursor|antigravity>
# When it fails, what the VM was doing (its output, its processes, apt's own logs) is printed and saved in
# CAGE_TEST_ARTIFACTS, if set.
set -euo pipefail
A="${1:?usage: microvm-e2e.sh <agent>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VM="cage-$A"
B=""   # a second agent, for asking across agents with the mask on (below)
export CAGE_HOME
CAGE_HOME="$(mktemp -d)"
cage() { "$ROOT/cage" "$@"; }
gx() { msb exec --no-tty "$VM" -- "$@"; }               # as root in the guest
ax() { msb exec --no-tty -u agent "$VM" -- "$@"; }      # as the agent user
diagnose() { # what the VM was doing: its output, its processes, and apt's own logs (also saved, for CI)
  local d="${CAGE_TEST_ARTIFACTS:-$CAGE_HOME}/microvm-e2e-$A"
  mkdir -p "$d"
  msb logs "$VM" > "$d/vm.log" 2>&1 || true
  echo "--- last guest output (all of it: $d/vm.log) ---"
  tail -n 60 "$d/vm.log"
  if [ -n "$B" ]; then   # the second agent's too, while there is one (asking across agents, below)
    msb logs "cage-$B" > "$d/vm-$B.log" 2>&1 || true
    echo "--- $B's last guest output (all of it: $d/vm-$B.log) ---"
    tail -n 60 "$d/vm-$B.log"
  fi
  timeout 60 msb exec --no-tty "$VM" -- sh -c 'echo "--- processes"; ps -eo pid,etime,args --forest
    echo "--- the step provisioning is on"; cat /run/cage-step.* 2>/dev/null
    echo "--- apt: the end of term.log"; tail -n 40 /var/log/apt/term.log 2>/dev/null
    echo "--- apt: history.log"; grep -E "^(Start-Date|End-Date|Commandline)" /var/log/apt/history.log 2>/dev/null | tail -n 24' \
    2>&1 | tee "$d/inside.txt" || true
}
cleanup() {
  status=$?
  if [ $status -ne 0 ]; then diagnose; fi
  "$ROOT/cage" down "$A" >/dev/null 2>&1 || true
  pkill -f -- "$ROOT/cage _refresh" 2>/dev/null || true   # the background helper (/all and stand-ins start it)
  "$ROOT/cage" destroy "$A" --yes >/dev/null 2>&1 || true
  if [ -n "$B" ]; then "$ROOT/cage" destroy "$B" --yes >/dev/null 2>&1 || true; fi
  rm -rf "$CAGE_HOME" "$CAGE_HOME".backups* "$CAGE_HOME".before-restore-*
  exit $status
}
trap cleanup EXIT
fail() { echo "FAIL[$A]: $*" >&2; exit 1; }
ok() { echo "ok - [$A] $*"; }
retry() { # retry <seconds> <cmd...>
  local deadline=$(( $(date +%s) + $1 )); shift
  until "$@" >/dev/null 2>&1; do [ "$(date +%s)" -lt "$deadline" ] || return 1; sleep 5; done
}

cage init 2>/dev/null
cat >> "$CAGE_HOME/cage.env" <<EOF
CAGE_TELEGRAM_ALLOW="111"
CAGE_TELEGRAM_TOKEN_$A="123456:FAKE-token-for-e2e"
EOF

TZ=Asia/Kolkata cage up "$A"   # the VM takes this computer's time zone (no daylight saving there: always +0530)
msb inspect "$VM" >/dev/null || fail "VM not created"
ok "cage up created $VM"

retry 1200 gx test -e "/opt/cage/provisioned-$A" || fail "not provisioned within 20 minutes"
ok "first boot provisioned $A + cc-connect inside the microVM"

retry 120 sh -c "msb exec --no-tty $VM -- ps -o user= -C cc-connect | grep -qx agent" || fail "cc-connect is not running as agent"
[ "$(gx stat -c '%U %a' /home/agent/.cc-connect/config.toml)" = "agent 600" ] || fail "config ownership"
ok "cc-connect runs as the unprivileged agent user with a 0600 config"
# without TZ, as cc-connect runs (env -i): the system clock's zone itself
[ "$(gx env -u TZ date +%z)" = "+0530" ] || fail "the VM is not in the host's time zone: $(gx env -u TZ date) / $(gx readlink /etc/localtime)"
ok "the VM runs in this computer's time zone (scheduled tasks run at your time)"

case "$A" in cursor) BIN=cursor-agent ;; antigravity) BIN=agy ;; *) BIN="$A" ;; esac
ax "$BIN" --version >/dev/null || fail "$BIN not runnable as agent"
ok "$BIN runs as agent"

# the app's chat: the relay in the VM (guest/app.mjs) reaches cc-connect's bridge; cc-connect answers /help itself
D="$CAGE_HOME/app/$A"
app_send() { printf '%s' "$2" > "$D/in/.$1.tmp" && mv "$D/in/.$1.tmp" "$D/in/$1.json"; }
app_log() { msb logs "$VM" 2>&1 | grep 'cage-app' | tail -5; tail -5 "$D/log.jsonl" 2>/dev/null; }
retry 300 grep -q '"t":"status","connected":true' "$D/log.jsonl" || fail "the app's relay never reached cc-connect's bridge: $(app_log)"
app_send e2e-1 '{"type":"message","id":"e2e-1","session":"you","text":"/help"}'
retry 120 grep -q '"ctx":"e2e-1"' "$D/log.jsonl" || fail "no answer to /help in the app: $(app_log)"
app_send e2e-2 '{"type":"ls","id":"e2e-2","path":""}'
retry 60 test -s "$D/out/e2e-2.json" || fail "no answer about the work folder: $(app_log)"
grep -q '"AGENTS.md"' "$D/out/e2e-2.json" || fail "work folder listing: $(cat "$D/out/e2e-2.json")"
app_send e2e-3 '{"type":"api","id":"e2e-3","method":"GET","path":"/api/v1/cron"}'
retry 60 test -s "$D/out/e2e-3.json" || fail "no answer from the management API: $(app_log)"
grep -q '"ok":true' "$D/out/e2e-3.json" || fail "management API: $(cat "$D/out/e2e-3.json")"
ok "the app's chat: the relay reaches cc-connect (it answers /help), the work folder and scheduled tasks"

ax sh -c 'echo "# Remember this" > /memory-inbox/e2e.md' || fail "agent can't write its inbox"
[ -f "$CAGE_HOME/brain/inbox/$A/e2e.md" ] || fail "inbox note didn't reach the host"
if ax sh -c 'echo x > /memory/x.md' 2>/dev/null; then fail "/memory is writable"; fi
gx grep -q 'About your user' /home/agent/work/AGENTS.md || fail "AGENTS.md not wired"
ok "memory: AGENTS.md wired, inbox writable and visible on the host, /memory read-only"

out="$(cage status 2>&1)"
grep -qF "[o|o]  $(printf '%-12s' "$A") needs a login" <<<"$out" || fail "status should report not logged in: $out"
ok "cage status probes the login inside the VM (not logged in, as expected)"

# `cage login` reaches the vendor's sign-in inside the VM (through a real PTY). Antigravity's full-screen
# UI needs a real terminal to answer its capability queries, so it is exercised by hand only.
if [ "$A" != antigravity ]; then
  timeout 90 script -qfec "$ROOT/cage login $A" "$CAGE_HOME/login.txt" </dev/null >/dev/null 2>&1 || true
  grep -aqE 'https://(claude\.com|auth\.openai\.com|cursor\.com)/' "$CAGE_HOME/login.txt" \
    || fail "cage login did not reach the sign-in URL: $(tr -d '\033' < "$CAGE_HOME/login.txt" | tail -c 600)"
  ok "cage login reaches $A's sign-in URL inside the VM"
fi

# default microsandbox policy: internet yes; cloud metadata / private ranges no
ax curl -sS -o /dev/null -m 20 https://github.com || fail "no internet from the guest"
if ax curl -sS -o /dev/null -m 5 http://169.254.169.254/; then fail "cloud metadata endpoint reachable"; fi
if ax curl -sS -o /dev/null -m 5 http://10.0.0.1/; then fail "private range reachable"; fi
ok "egress: public internet allowed; metadata and private ranges blocked"

# read-only host mounts
if gx sh -c 'echo x > /cage/pwned' 2>/dev/null; then fail "/cage is writable"; fi
ok "host mounts are read-only"

# persistence: down + up (what you do after a reboot) re-creates the VM and keeps the home volume.
# The VM comes back with a secret, so this also boots and provisions with TLS interception on.
SECRET_VALUE="cage-e2e-$RANDOM$RANDOM$RANDOM"
printf '%s\n' "$SECRET_VALUE" | cage secret add E2E_KEY postman-echo.com "$A" 2>/dev/null || fail "secret add"
PW="p&ss w0rd-$RANDOM"   # characters that forms encode, so the pre-encoded twin is exercised too
printf 'e2e-user\n%s\n' "$PW" | cage password add postman-echo.com "$A" 2>/dev/null || fail "password add"
CONN_VALUE="cage-conn-$RANDOM$RANDOM$RANDOM"
printf '%s\n' "$CONN_VALUE" | cage connect add deepwiki https://mcp.deepwiki.com/mcp --header X-Cage-Key "$A" 2>/dev/null \
  || fail "connect add"
ax sh -c 'echo keep > /home/agent/work/marker'
cage down "$A"
woke=$SECONDS
cage up "$A"
retry 1500 gx test -e "/opt/cage/provisioned-$A" || fail "not re-provisioned after up"
msb logs "$VM" 2>&1 | grep -q 'base packages (cached)' || fail "the second boot didn't install from the cache: $(msb logs "$VM" 2>&1 | grep 'provision\[' | tail -8)"
if msb logs "$VM" 2>&1 | grep -q "provision\[$A\]: \(Claude Code\|OpenAI Codex\|Cursor CLI\|Antigravity CLI\) "; then
  fail "the second boot downloaded the agent's CLI again"
fi
echo "    (woke from the cache in $((SECONDS - woke))s)"
[ "$(gx cat /home/agent/work/marker)" = keep ] || fail "home volume lost across down/up"
retry 180 sh -c "msb exec --no-tty $VM -- ps -o user= -C cc-connect | grep -qx agent" || fail "cc-connect not back after down/up"
ok "down + up keeps the home volume (logins, work) and brings cc-connect back"

# secrets: the agent only ever sees a placeholder; the allowed host gets the real value; nowhere else does
withenv() { ax bash -lc "set -a; . /etc/cage/runtime.env; set +a; $1"; }
v="$(withenv 'printf %s "$E2E_KEY"')"
[ -n "$v" ] && [ "$v" != "$SECRET_VALUE" ] || fail "the agent sees the real secret, or nothing: '$v'"
gx grep -q 'E2E_KEY' /home/agent/work/AGENTS.md || fail "the agent wasn't told about its key"
resp="$(withenv 'curl -sS -m 30 https://postman-echo.com/headers -H "x-cage-key: $E2E_KEY"' || true)"
grep -q "$SECRET_VALUE" <<<"$resp" || fail "the allowed host didn't receive the real value: $resp"
resp="$(withenv 'curl -sS -m 30 https://httpbin.org/anything -H "x-cage-key: $E2E_KEY"' 2>&1 || true)"
if grep -q "$SECRET_VALUE" <<<"$resp"; then fail "the real value reached a host it isn't allowed for"; fi
# ...because microsandbox stopped it (not because httpbin.org was down): it's in cage security
retry 90 sh -c "'$ROOT/cage' security 2>&1 | grep -q 'tried to send E2E_KEY to httpbin.org'" \
  || fail "the key sent to httpbin.org wasn't blocked and reported: $(cage security 2>&1 | tail -5)"
withenv 'curl -sS -m 30 -o /dev/null https://github.com' || fail "HTTPS through the interception CA fails"
ax curl -sS -m 30 -o /dev/null https://api.telegram.org || fail "Telegram (exempt from interception) unreachable"
if gx sh -c 'command -v node >/dev/null'; then
  withenv 'node -e "fetch(\"https://github.com\").then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"' \
    || fail "Node doesn't trust the interception CA"
fi
ok "secrets: placeholder in the VM, real value only at the allowed host, HTTPS still works under interception"

# a new value for a secret reaches the running VM without a restart (msb modify): what renewed sign-ins rely on
NEW_VALUE="cage-e2e-new-$RANDOM$RANDOM"
printf '%s\n' "$NEW_VALUE" | cage secret add E2E_KEY postman-echo.com "$A" 2>"$CAGE_HOME/rotate.err" || fail "secret update"
grep -q 'running agents use the new value now' "$CAGE_HOME/rotate.err" || fail "no live update: $(cat "$CAGE_HOME/rotate.err")"
resp="$(withenv 'curl -sS -m 30 https://postman-echo.com/headers -H "x-cage-key: $E2E_KEY"' || true)"
grep -q "$NEW_VALUE" <<<"$resp" || fail "the running VM still sends the old value: $resp"
ok "secrets: a new value goes into the running VM without a restart"

# connectors: the agent's CLI has the app with only a placeholder in its config, and reaches the MCP server
# through TLS interception (the CLIs that can check a connection without a login do)
hx() { msb exec --no-tty -u agent -e HOME=/home/agent "$VM" -- bash -lc "set -a; . /etc/cage/runtime.env; set +a; $1"; }
gx grep -rqF "$CONN_VALUE" /home/agent /etc/cage && fail "the connector's key reached the VM"
ph="$(withenv 'printf %s "$DEEPWIKI_MCP_TOKEN"')"
if [[ "$ph" == '$MSB_'* ]]; then gx grep -q "^${ph#\$}=" /etc/cage/runtime.env || fail "placeholder $ph not set to itself"; fi
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cage-e2e","version":"1"}}}'
resp="$(withenv "curl -sS -m 30 https://mcp.deepwiki.com/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H \"X-Cage-Key: \$DEEPWIKI_MCP_TOKEN\" -d '$init'" || true)"
grep -q serverInfo <<<"$resp" || fail "the MCP server didn't answer through interception: $resp"
case "$A" in
  claude) mcp="claude mcp list" want='deepwiki.*Connected' ;; codex) mcp="codex mcp get deepwiki" want='streamable_http' ;;
  cursor) mcp="cursor-agent mcp list" want='deepwiki.*ready' ;; antigravity) mcp="agy mcp list" want='deepwiki +http' ;;
esac
retry 120 sh -c "msb exec --no-tty -u agent -e HOME=/home/agent $VM -- bash -lc 'set -a; . /etc/cage/runtime.env; set +a; $mcp' 2>&1 | grep -qE '$want'" \
  || fail "$mcp: $(hx "$mcp" 2>&1 | tail -5)"
ok "connectors: $mcp reaches the app through interception; only a placeholder in the VM"

# website passwords: the agent sees placeholders; the allowed site gets the real password in the request body,
# as JSON (first placeholder) or as an HTML form (its pre-encoded twin); nowhere else does. The agent's own
# browser (Chromium, trusting microsandbox's CA) signs in with it.
gx grep -rqF "$PW" /home/agent /etc/cage /cage-config && fail "the website password reached the VM"
ph="$(gx grep -o 'type `cagepw-[a-z0-9-]*`' /home/agent/work/AGENTS.md | head -n 1 | tr -d '`' | sed 's/^type //')"
alt="$(gx grep -o 'try `cagepwf-[a-z0-9-]*`' /home/agent/work/AGENTS.md | head -n 1 | tr -d '`' | sed 's/^try //')"
[ -n "$ph" ] && [ -n "$alt" ] || fail "the agent wasn't told its sign-in: $(gx grep -A3 'Website sign-ins' /home/agent/work/AGENTS.md)"
resp="$(ax curl -sS -m 30 https://postman-echo.com/post -H 'Content-Type: application/json' -d "{\"password\":\"$ph\"}" || true)"
grep -qF "\"password\":\"$PW\"" <<<"$resp" || fail "JSON sign-in didn't get the real password: $resp"
resp="$(ax curl -sS -m 30 https://postman-echo.com/post --data-urlencode "password=$alt" || true)"
grep -qF "\"password\":\"$PW\"" <<<"$resp" || fail "form sign-in didn't get the real password: $resp"
resp="$(ax curl -sS -m 30 https://httpbin.org/post --data-urlencode "password=$alt" 2>&1 || true)"
if grep -qF "$PW" <<<"$resp" || grep -qF 'p%26ss' <<<"$resp"; then fail "the password reached another site"; fi
retry 90 sh -c "'$ROOT/cage' security 2>&1 | grep -q 'tried to send CAGE_PW_[A-Z0-9_]* to httpbin.org'" \
  || fail "the password sent to httpbin.org wasn't blocked and reported: $(cage security 2>&1 | tail -5)"
form="data:text/html,<form method=post action=https://postman-echo.com/post><input name=user value=e2e-user><input type=password name=password id=pw><button>Sign in</button></form>"
# The browser gets ready in the background after each boot (guest/browser.sh)
retry 900 gx test -e /opt/cage/browser-ready || fail "the browser didn't get ready: $(msb logs "$VM" 2>&1 | grep cage-browser | tail -5)"
calls="[[\"browser_navigate\",{\"url\":\"$form\"}],[\"browser_type\",{\"element\":\"password\",\"target\":\"e4\",\"text\":\"$alt\",\"submit\":true}],[\"browser_wait_for\",{\"time\":3}],[\"browser_snapshot\",{}]]"
out="$(msb exec --no-tty -u agent -e HOME=/home/agent "$VM" -- node /cage/mcp-try.mjs "$calls" cage-browser 2>&1 || true)"
grep -qF "\\\"password\\\":\\\"$PW\\\"" <<<"$out" || grep -qF "\"password\":\"$PW\"" <<<"$out" \
  || fail "the browser's sign-in didn't carry the real password: $(tail -c 1500 <<<"$out")"
ok "website passwords: JSON and form sign-ins get the real password at the allowed site only; the browser signs in with it"

# backup + restore on the real volume: the agent's files come back with their in-VM owner and mode
ax sh -c 'echo from-backup > /home/agent/work/bk && chmod 640 /home/agent/work/bk'
before="$(gx stat -c '%U:%G %a' /home/agent/work/bk)"
export CAGE_BACKUP_DIR="$CAGE_HOME.backups" CAGE_BACKUP_PASSPHRASE="e2e passphrase"
cage backup 2>"$CAGE_BACKUP_DIR.err" || fail "backup: $(cat "$CAGE_BACKUP_DIR.err")"
ax sh -c 'echo changed > /home/agent/work/bk; rm -f /home/agent/work/marker'
cage restore "$(ls "$CAGE_BACKUP_DIR"/*.cagebackup)" --yes 2>"$CAGE_BACKUP_DIR.err" || fail "restore: $(cat "$CAGE_BACKUP_DIR.err")"
retry 1500 gx test -e "/opt/cage/provisioned-$A" || fail "not re-provisioned after restore"
[ "$(gx cat /home/agent/work/bk)" = from-backup ] && [ "$(gx cat /home/agent/work/marker)" = keep ] || fail "files not restored"
[ "$(gx stat -c '%U:%G %a' /home/agent/work/bk)" = "$before" ] || fail "owner/mode changed: $before -> $(gx stat -c '%U:%G %a' /home/agent/work/bk)"
retry 180 sh -c "msb exec --no-tty $VM -- ps -o user= -C cc-connect | grep -qx agent" || fail "cc-connect not back after restore"
rm -rf "$CAGE_BACKUP_DIR" "$CAGE_BACKUP_DIR.err" "$CAGE_HOME".before-restore-*
ok "backup + restore bring back the agent's files with their owner and mode, and the agent wakes up"

# strict network: the agent still installs and starts with only its own hosts; anything else is turned away and
# shows up in `cage security`
cage network strict </dev/null 2>/dev/null
cage up "$A"
retry 1500 gx test -e "/opt/cage/provisioned-$A" || fail "not provisioned under strict network: $(msb logs "$VM" --source system --grep 'denied' 2>&1 | tail -20)"
retry 180 sh -c "msb exec --no-tty $VM -- ps -o user= -C cc-connect | grep -qx agent" || fail "cc-connect not running under strict network"
ax curl -fsS -m 20 -o /dev/null https://postman-echo.com/get || fail "a host its key is for is unreachable under strict network"
if ax curl -fsS -m 20 -o /dev/null https://example.com; then fail "example.com is reachable under strict network"; fi
retry 90 sh -c "'$ROOT/cage' security 2>&1 | grep -q 'reach example.com'" \
  || fail "the blocked host isn't in cage security: $(cage security 2>&1) / $(msb logs "$VM" --source system --grep 'denied' 2>&1 | tail -5)"
cage allow example.com "$A" </dev/null 2>/dev/null
cage up "$A"
retry 1500 gx test -e "/opt/cage/provisioned-$A" || fail "not re-provisioned after cage allow"
ax curl -fsS -m 20 -o /dev/null https://example.com || fail "cage allow example.com didn't let it through"
cage network open </dev/null 2>/dev/null
ok "strict network: installs and runs with only its own hosts; example.com blocked, reported, then allowed"

# the relay and voice notes, on the real VM
cage ask-all on </dev/null 2>/dev/null
if [ "$A" = claude ]; then cage voice on </dev/null 2>/dev/null; fi   # one agent is enough for a ~300 MB download
cage up "$A"
retry 1500 gx test -e "/opt/cage/provisioned-$A" || fail "not re-provisioned with /all on"
retry 60 ax env CC_HOOK_EVENT=message.received CC_HOOK_SESSION_KEY=telegram:111:111 CC_HOOK_CONTENT='/all ping' \
  bash /cage/hook.sh ask || fail "the hook failed in the VM"
[ -n "$(ls -A "$CAGE_HOME/outbox/$A")" ] || fail "the VM's hook couldn't leave a request for cage"
cage _outbox 2>/dev/null
[ -z "$(ls -A "$CAGE_HOME/outbox/$A")" ] || fail "cage didn't pick the request up"
ok "relay: the agent's cc-connect hook leaves requests in its outbox, and cage picks them up"
if [ "$A" = claude ]; then
  retry 900 gx curl -fsS http://127.0.0.1:8178/health || fail "speech-to-text didn't start: $(msb logs "$VM" 2>&1 | grep cage-voice | tail -5)"
  gx bash -c 'curl -fsSL -o /tmp/s.flac https://huggingface.co/datasets/Narsil/asr_dummy/resolve/main/1.flac &&
    ffmpeg -loglevel error -y -i /tmp/s.flac -c:a libopus -f ogg /tmp/s.ogg && ffmpeg -loglevel error -y -i /tmp/s.ogg -f mp3 /tmp/s.mp3' \
    || fail "ffmpeg (for cc-connect) isn't working"
  out="$(gx curl -sS -F file=@/tmp/s.mp3 -F response_format=text http://127.0.0.1:8178/v1/audio/transcriptions)"
  grep -qi "stew for dinner" <<<"$out" || fail "voice note transcript: $out / $(msb logs "$VM" 2>&1 | grep cage-stt | tail -20)"
  ok "voice notes: an ogg voice note, converted the way cc-connect does, becomes text on the VM"
fi
cage ask-all off </dev/null 2>/dev/null; cage voice off </dev/null 2>/dev/null

# the privacy mask: cc-connect runs the real CLI behind guest/mask.py. With /all on, a second agent (its own mask off)
# wakes up too, to answer from this one's chat (below).
B=cursor; [ "$A" != cursor ] || B=claude   # its CLI says at once that it isn't signed in
cage mask add "Acme Corp" </dev/null 2>/dev/null
cage mask on "$A" </dev/null 2>/dev/null
cage ask-all on </dev/null 2>/dev/null
cage up "$A" "$B"
retry 1500 gx test -e "/opt/cage/provisioned-$A" || fail "not re-provisioned with the mask on"
retry 180 sh -c "msb exec --no-tty $VM -- ps -o user= -C cc-connect | grep -qx agent" || fail "cc-connect not running behind the mask"
ax python3 /cage/mask.py "$BIN" --version >/dev/null || fail "$BIN doesn't run behind the mask"
[ "$(ax sh -c 'printf "ask acme corp at bob@example.com" | python3 /cage/mask.py --mask')" = "ask [TERM_1] at [EMAIL_1]" ] \
  || fail "the mask in the VM: $(ax sh -c 'printf "ask acme corp at bob@example.com" | python3 /cage/mask.py --mask')"
gx grep -q 'Masked values' /home/agent/work/AGENTS.md || fail "the agent wasn't told about masked values"
ok "privacy mask: the real CLI runs behind it, your terms and emails become tokens, the agent is told"

# Asking other agents keeps the mask: what you tell a masked agent reaches another one's CLI masked by that VM's own
# mask, with its own map (/all from the masked agent's chat), and cage ask runs a masked agent's CLI behind its mask.
# The question goes to each VM in a file (never on a command line), which is gone afterwards. Neither CLI is signed
# in here, so the proof is in each VM's map.
bx() { msb exec --no-tty "cage-$B" -- "$@"; }
# Ready, as $A is above: provisioned, then set up (your terms, its memory and apps), and cc-connect started last
retry 1500 bx test -e "/opt/cage/provisioned-$B" || fail "$B wasn't provisioned next to $A"
retry 180 sh -c "msb exec --no-tty cage-$B -- ps -o user= -C cc-connect | grep -qx agent" || fail "cc-connect isn't running in $B"
# The background helper `cage up` started takes requests too, every 3 s. Had it taken this one, `cage _outbox` would
# return while $B is still being asked, and the checks below would run too early. So `cage _outbox` is the only one.
pkill -f -- "$ROOT/cage _refresh" 2>/dev/null || true
retry 60 ax env CC_HOOK_EVENT=message.received CC_HOOK_SESSION_KEY=telegram:111:111 \
  CC_HOOK_CONTENT='/all is carol@example.org still at Acme Corp?' bash /cage/hook.sh ask || fail "the hook failed in the VM"
cage _outbox 2>/dev/null
bx grep -qF 'carol@example.org' /home/agent/.cage/mask/map.json \
  || fail "$B wasn't asked behind the mask: $(bx sh -c 'ls -l /home/agent/.cage/mask; cat /etc/cage/mask.terms' 2>&1)"
bx grep -qF 'Acme Corp' /home/agent/.cage/mask/map.json || fail "your terms didn't reach $B's mask"
cage ask "and is dave@example.net?" "$A" >/dev/null 2>"$CAGE_HOME/ask.err" || fail "cage ask: $(cat "$CAGE_HOME/ask.err")"
gx grep -qF 'dave@example.net' /home/agent/.cage/mask/map.json || fail "cage ask didn't run $A's CLI behind its mask"
left="$(find "$CAGE_HOME/agents/$A/replies" "$CAGE_HOME/agents/$B/replies" -name '*.q' 2>/dev/null || true)"
[ -z "$left" ] || fail "a question stayed on disk: $left"
cage destroy "$B" --yes >/dev/null 2>&1; B=""
cage ask-all off </dev/null 2>/dev/null; cage mask off </dev/null 2>/dev/null; cage mask rm "Acme Corp" </dev/null 2>/dev/null
ok "asking other agents keeps the mask: /all from a masked agent's chat, and cage ask, reach each CLI through its VM's mask"

# no chat app at all: cc-connect runs behind the placeholder platform, and the app still reaches it
sed -i "/^CAGE_TELEGRAM_TOKEN_$A=/d" "$CAGE_HOME/cage.env"
cage up "$A"
retry 1500 gx test -e "/opt/cage/provisioned-$A" || fail "not re-provisioned without a chat app"
retry 180 sh -c "msb exec --no-tty $VM -- ps -o user= -C cc-connect | grep -qx agent" || fail "cc-connect doesn't run without a chat app: $(msb logs "$VM" 2>&1 | tail -20)"
app_send e2e-4 '{"type":"message","id":"e2e-4","session":"you","text":"/help"}'
retry 180 grep -q '"ctx":"e2e-4"' "$D/log.jsonl" || fail "no answer in the app without a chat app: $(app_log)"
ok "no chat app needed: cc-connect runs behind the placeholder, and you talk to the agent in the app"

cage destroy "$A" --yes
if msb inspect "$VM" >/dev/null 2>&1; then fail "VM still exists after destroy"; fi
ok "destroy removes the VM and its volume"
echo "microVM e2e passed for $A"
