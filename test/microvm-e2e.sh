#!/usr/bin/env bash
# End-to-end on REAL microVMs: the real ./cage driving the real microsandbox CLI (needs msb plus
# KVM or Apple Silicon). The bot token is fake, so this proves everything up to the Telegram API.
#   test/microvm-e2e.sh <claude|codex|cursor|antigravity>
set -euo pipefail
A="${1:?usage: microvm-e2e.sh <agent>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VM="cage-$A"
export CAGE_HOME
CAGE_HOME="$(mktemp -d)"
cage() { "$ROOT/cage" "$@"; }
gx() { msb exec --no-tty "$VM" -- "$@"; }               # as root in the guest
ax() { msb exec --no-tty -u agent "$VM" -- "$@"; }      # as the agent user
cleanup() {
  status=$?
  if [ $status -ne 0 ]; then echo "--- last guest output ---"; msb logs "$VM" 2>&1 | tail -60 || true; fi
  "$ROOT/cage" destroy "$A" --yes >/dev/null 2>&1 || true
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

cage up "$A"
msb inspect "$VM" >/dev/null || fail "VM not created"
ok "cage up created $VM"

retry 1200 gx test -e "/opt/cage/provisioned-$A" || fail "not provisioned within 20 minutes"
ok "first boot provisioned $A + cc-connect inside the microVM"

retry 120 sh -c "msb exec --no-tty $VM -- ps -o user= -C cc-connect | grep -qx agent" || fail "cc-connect is not running as agent"
[ "$(gx stat -c '%U %a' /home/agent/.cc-connect/config.toml)" = "agent 600" ] || fail "config ownership"
ok "cc-connect runs as the unprivileged agent user with a 0600 config"

case "$A" in cursor) BIN=cursor-agent ;; antigravity) BIN=agy ;; *) BIN="$A" ;; esac
ax "$BIN" --version >/dev/null || fail "$BIN not runnable as agent"
ok "$BIN runs as agent"

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
cage up "$A"
retry 1200 gx test -e "/opt/cage/provisioned-$A" || fail "not re-provisioned after up"
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
form="data:text/html,<form method=post action=https://postman-echo.com/post><input name=user value=e2e-user><input type=password name=password id=pw><button>Sign in</button></form>"
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
retry 1200 gx test -e "/opt/cage/provisioned-$A" || fail "not re-provisioned after restore"
[ "$(gx cat /home/agent/work/bk)" = from-backup ] && [ "$(gx cat /home/agent/work/marker)" = keep ] || fail "files not restored"
[ "$(gx stat -c '%U:%G %a' /home/agent/work/bk)" = "$before" ] || fail "owner/mode changed: $before -> $(gx stat -c '%U:%G %a' /home/agent/work/bk)"
retry 180 sh -c "msb exec --no-tty $VM -- ps -o user= -C cc-connect | grep -qx agent" || fail "cc-connect not back after restore"
rm -rf "$CAGE_BACKUP_DIR" "$CAGE_BACKUP_DIR.err" "$CAGE_HOME".before-restore-*
ok "backup + restore bring back the agent's files with their owner and mode, and the agent wakes up"

cage destroy "$A" --yes
if msb inspect "$VM" >/dev/null 2>&1; then fail "VM still exists after destroy"; fi
ok "destroy removes the VM and its volume"
echo "microVM e2e passed for $A"
