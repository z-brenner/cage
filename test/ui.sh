#!/usr/bin/env bash
# Tests cage's web app (host/ui/server.py and host/ui/static) against a stub msb: who may use it (the token, this
# computer only, which commands), and, in a real headless browser, the page itself (test/ui.browser.mjs, with
# test/fixtures/fake-vm.mjs playing an agent's VM).
# Needs node and the playwright package (PLAYWRIGHT_MODULE=/path/to/node_modules/playwright if it isn't global).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
SERVER="" SERVER2="" SERVER3="" VM=""
cleanup() { # whatever the tests started, also when one fails halfway
  local p h
  for p in $SERVER $SERVER2 $SERVER3 $VM; do kill "$p" 2>/dev/null || true; done
  pkill -f "$T/bin/msb" 2>/dev/null || true   # the stub msb, in a job a failed test left behind
  # the background helper some settings start: by its pid file, or by the CAGE_HOME it runs with (these tests' only)
  for h in "$T"/*/refresh.pid; do if [ -s "$h" ]; then kill "$(cat "$h")" 2>/dev/null || true; fi; done
  for p in $(pgrep -f "cage _refresh" 2>/dev/null || true); do
    # (no pipe into grep -q: under pipefail, its early exit can fail the test of a match it found)
    if grep -qz "^CAGE_HOME=$T/" "/proc/$p/environ" 2>/dev/null; then kill "$p" 2>/dev/null || true; fi
  done
  rm -rf "$T"
}
trap cleanup EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }

mkdir -p "$T/bin" "$T/home"
cat > "$T/bin/msb" <<'STUB'
#!/usr/bin/env bash
cmd="$1"; shift
case "$cmd" in
  inspect) exit 0 ;;
  ps) echo cage-claude; if [ -e "${STUB_AWAKE:-/nonexistent}" ]; then echo cage-codex; fi ;;
  exec) case "$*" in
    *cage:ready*) echo cage:ready ;;
    *strict-mcp-config*) echo 'Paris, says **the stub**' ;;
    *skip-git-repo-check*) echo 'Lyon, says *the other* stub (snake_case_ok)' ;;
    *"auth login"*) printf 'Browser didn'"'"'t open? Use the url below to sign in (c to copy)\n\n\033[1mhttps://claude.ai/oauth/authorize?code=true&client_id=9d1c&state=xyz\033[0m\n\nPaste code here if prompted > '
      read -r c; [ "$c" = "CODE-123" ] && echo "Login successful." ;;
  esac ;;
  logs) for i in 1 2 3; do echo "cc-connect: line $i"; done ;;
esac
exit 0
STUB
chmod +x "$T/bin/msb"
export CAGE_HOME="$T/home" CAGE_MSB="$T/bin/msb" CAGE_NO_SELF_UPDATE=1 STUB_AWAKE="$T/codex-awake"
"$ROOT/cage" init 2>/dev/null
printf 'CAGE_AGENTS="claude codex"\nCAGE_TELEGRAM_ALLOW="111"\nCAGE_TELEGRAM_TOKEN_claude="123:AAA-claude"\nCAGE_TELEGRAM_BOT_claude="my_claude_bot"\n' >> "$CAGE_HOME/cage.env"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
export CAGE_UI_PORT="$PORT"
"$ROOT/cage" ui --no-open 2>"$T/ui.err" || fail "cage ui: $(cat "$T/ui.err")"
SERVER="$(pgrep -f "host/ui/server.py" -n || true)"
TOK="$(cat "$CAGE_HOME/ui.token")"
[ "$(stat -c %a "$CAGE_HOME/ui.token")" = 600 ] && [ "${#TOK}" = 48 ] || fail "token file"
grep -q "http://127.0.0.1:$PORT/#$TOK" "$T/ui.err" || fail "cage ui didn't give the address: $(cat "$T/ui.err")"
B="http://127.0.0.1:$PORT"
code() { curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$B/api/state")" = 401 ] || fail "state without the token"
[ "$(code -H "X-Cage-Token: nope" "$B/api/state")" = 401 ] || fail "state with a wrong token"
[ "$(code -H "X-Cage-Token: $TOK" -H "Host: evil.example:$PORT" "$B/api/state")" = 403 ] || fail "another host name (DNS rebinding)"
[ "$(code -X POST -H "X-Cage-Token: $TOK" -H "Origin: https://evil.example" -d '{"args":["version"]}' "$B/api/jobs")" = 403 ] || fail "another site's request"
[ "$(code -X POST -H "X-Cage-Token: $TOK" -d '{"args":["_state"]}' "$B/api/jobs")" = 403 ] || fail "an internal command"
[ "$(code -X POST -H "X-Cage-Token: $TOK" -d '{"args":["init"]}' "$B/api/jobs")" = 403 ] || fail "a command the app doesn't use"
[ "$(code "$B/../../cage.env")" = 404 ] && [ "$(code "$B/%2e%2e/%2e%2e/cage")" = 404 ] || fail "files outside the page"
curl --noproxy '*' -sI "$B/" | grep -qi "content-security-policy: default-src 'self'" || fail "no content security policy"
curl --noproxy '*' -s -H "X-Cage-Token: $TOK" "$B/api/state" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["configured"] and d["agents"][0]["state"] == "ready", d' \
  || fail "state"
ok "only this computer, with the token, and only cage's own commands; a strict content security policy"

# The chat folders are written by the VMs: the app never follows a link out of them, never shows an agent's page
A="$CAGE_HOME/app"
mkdir -p "$A/claude/files" "$A/cursor" "$T/elsewhere" && chmod 700 "$A"
ln -s "$CAGE_HOME/cage.env" "$A/claude/files/1-ab-evil.png"
printf '<script>alert(1)</script>' > "$A/claude/files/1-ab-page.html"
printf 'PNG' > "$A/claude/files/1-ab-pic.png"
ln -s "$T/elsewhere" "$A/cursor/in"
H=(-H "X-Cage-Token: $TOK")
[ "$(code "${H[@]}" "$B/api/chat/claude/file?p=files/1-ab-evil.png")" = 404 ] || fail "followed a link out of the chat folder"
[ "$(code "${H[@]}" "$B/api/chat/claude/file?p=files/../../cage.env")" = 404 ] && [ "$(code "${H[@]}" "$B/api/chat/claude/file?p=../cage.env")" = 404 ] || fail "a path out of the chat folder"
curl --noproxy '*' -sI "${H[@]}" "$B/api/chat/claude/file?p=files/1-ab-page.html" | grep -qi '^content-disposition: attachment' || fail "an agent's page shown in the app"
curl --noproxy '*' -sI "${H[@]}" "$B/api/chat/claude/file?p=files/1-ab-pic.png" | grep -qi '^content-type: image/png' || fail "pictures are shown"
[ "$(code "${H[@]}" -X POST -d '{"text":"hi"}' "$B/api/chat/cursor/send")" != 200 ] && [ -z "$(ls -A "$T/elsewhere")" ] || fail "wrote through a link"
[ "$(code "${H[@]}" "$B/api/chat/evil/history")" = 400 ] || fail "not an agent"
rm -f "$A/claude/files/1-ab-evil.png" "$A/cursor/in"
ok "chat folders: no links followed, no way out, an agent's pages download instead of opening"
curl --noproxy '*' -sI "$B/manifest.webmanifest" | grep -qi '^content-type: application/manifest+json' && curl --noproxy '*' -s "$B/manifest.webmanifest" | python3 -c 'import json,sys; m=json.load(sys.stdin); assert m["name"] == "cage" and m["display"] == "standalone"' \
  && [ "$(code "$B/sw.js")" = 200 ] && [ "$(code "$B/icon-maskable.png")" = 200 ] || fail "installable as an app"
ok "installable as an app: a manifest, icons and a service worker"

mkdir -p "$T/work/reports" && printf 'Q3: up 12%%\n' > "$T/work/reports/q3.txt" && printf '# Notes\n' > "$T/work/notes.md"

# A second, fresh computer for the setup screen: Codex needs a sign-in (by device code) until it's done
mkdir -p "$T/bin2"
cat > "$T/bin2/msb" <<'STUB'
#!/usr/bin/env bash
cmd="$1"; shift
case "$cmd" in
  inspect) exit 0 ;;
  ps) echo cage-codex ;;
  exec) case "$*" in
    *cage:ready*) if [ -e "$STUB_SIGNED" ]; then echo cage:ready; else echo cage:login; fi ;;
    *"login --device-auth"*) printf 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \033[94mhttps://auth.openai.com/codex/device\033[0m\n\n2. Enter this one-time code \033[90m(expires in 15 minutes)\033[0m\n   \033[94mWXYZ-12345\033[0m\n'
      sleep 2; : > "$STUB_SIGNED" ;;
  esac ;;
esac
exit 0
STUB
chmod +x "$T/bin2/msb"
PORT2="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
CAGE_HOME="$T/fresh" CAGE_MSB="$T/bin2/msb" CAGE_UI_PORT="$PORT2" STUB_SIGNED="$T/signed" "$ROOT/cage" ui --no-open 2>/dev/null || fail "the second cage ui"
SERVER2="$(pgrep -f "host/ui/server.py" -n || true)"
B2="http://127.0.0.1:$PORT2"
TOK2="$(cat "$T/fresh/ui.token")"
node "$ROOT/test/fixtures/fake-vm.mjs" "$A/claude" "$T/work" & VM=$!

# An installed release (a VERSION file), for updating while the app is open: the server restarts itself with the new
# code once nothing is running, and the page reloads to get the new page
mkdir -p "$T/inst" && tar --exclude=.git --exclude=node_modules -C "$ROOT" -cf - . | tar -C "$T/inst" -xf - && echo v1.0.0 > "$T/inst/VERSION"
PORT3="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
CAGE_UI_PORT="$PORT3" "$T/inst/cage" ui --no-open 2>/dev/null || fail "the installed cage ui"
SERVER3="$(pgrep -f "$T/inst/host/ui/server.py" -n || true)"

if command -v node >/dev/null 2>&1; then
  PLAYWRIGHT_MODULE="${PLAYWRIGHT_MODULE:-$(npm root -g 2>/dev/null)/playwright}" STUB_AWAKE="$T/codex-awake" node "$ROOT/test/ui.browser.mjs" "$B" "$TOK" "$CAGE_HOME" "$T/work" "$B2" "$TOK2" "$T/fresh" "http://127.0.0.1:$PORT3" "$T/inst" \
    || fail "the web app in a browser (above)"
  ok "the web app in a real browser"
fi
echo "all $pass web app test groups passed"
