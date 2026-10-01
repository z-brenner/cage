#!/usr/bin/env bash
# Tests cage's web app (host/ui/server.py and host/ui/static) against a stub msb: who may use it (the token, this
# computer only, which commands), and, in a real headless browser, the page itself (test/ui.test.mjs).
# Needs node and the playwright package (PLAYWRIGHT_MODULE=/path/to/node_modules/playwright if it isn't global).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
SERVER=""
VM=""
trap '[ -z "$SERVER" ] || kill "$SERVER" 2>/dev/null; [ -z "$VM" ] || kill "$VM" 2>/dev/null; rm -rf "$T"' EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }

mkdir -p "$T/bin" "$T/home"
cat > "$T/bin/msb" <<'STUB'
#!/usr/bin/env bash
cmd="$1"; shift
case "$cmd" in
  inspect) exit 0 ;;
  ps) echo cage-claude ;;
  exec) case "$*" in *cage:ready*) echo cage:ready ;; *strict-mcp-config*) echo 'Paris, says **the stub**' ;; esac ;;
  logs) for i in 1 2 3; do echo "cc-connect: line $i"; done ;;
esac
exit 0
STUB
chmod +x "$T/bin/msb"
export CAGE_HOME="$T/home" CAGE_MSB="$T/bin/msb" CAGE_NO_SELF_UPDATE=1
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
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$B/api/state")" = 401 ] || fail "state without the token"
[ "$(code -H "X-Cage-Token: nope" "$B/api/state")" = 401 ] || fail "state with a wrong token"
[ "$(code -H "X-Cage-Token: $TOK" -H "Host: evil.example:$PORT" "$B/api/state")" = 403 ] || fail "another host name (DNS rebinding)"
[ "$(code -X POST -H "X-Cage-Token: $TOK" -H "Origin: https://evil.example" -d '{"args":["version"]}' "$B/api/jobs")" = 403 ] || fail "another site's request"
[ "$(code -X POST -H "X-Cage-Token: $TOK" -d '{"args":["_state"]}' "$B/api/jobs")" = 403 ] || fail "an internal command"
[ "$(code -X POST -H "X-Cage-Token: $TOK" -d '{"args":["init"]}' "$B/api/jobs")" = 403 ] || fail "a command the app doesn't use"
[ "$(code "$B/../../cage.env")" = 404 ] && [ "$(code "$B/%2e%2e/%2e%2e/cage")" = 404 ] || fail "files outside the page"
curl -sI "$B/" | grep -qi "content-security-policy: default-src 'self'" || fail "no content security policy"
curl -s -H "X-Cage-Token: $TOK" "$B/api/state" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["configured"] and d["agents"][0]["state"] == "ready", d' \
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
curl -sI "${H[@]}" "$B/api/chat/claude/file?p=files/1-ab-page.html" | grep -qi '^content-disposition: attachment' || fail "an agent's page shown in the app"
curl -sI "${H[@]}" "$B/api/chat/claude/file?p=files/1-ab-pic.png" | grep -qi '^content-type: image/png' || fail "pictures are shown"
[ "$(code "${H[@]}" -X POST -d '{"text":"hi"}' "$B/api/chat/cursor/send")" != 200 ] && [ -z "$(ls -A "$T/elsewhere")" ] || fail "wrote through a link"
[ "$(code "${H[@]}" "$B/api/chat/evil/log")" = 400 ] || fail "not an agent"
rm -f "$A/claude/files/1-ab-evil.png" "$A/cursor/in"
ok "chat folders: no links followed, no way out, an agent's pages download instead of opening"

mkdir -p "$T/work/reports" && printf 'Q3: up 12%%\n' > "$T/work/reports/q3.txt" && printf '# Notes\n' > "$T/work/notes.md"
node "$ROOT/test/fake-vm.mjs" "$A/claude" "$T/work" & VM=$!

if command -v node >/dev/null 2>&1; then
  PLAYWRIGHT_MODULE="${PLAYWRIGHT_MODULE:-$(npm root -g 2>/dev/null)/playwright}" node "$ROOT/test/ui.test.mjs" "$B" "$TOK" "$CAGE_HOME" "$T/work" \
    || fail "the web app in a browser (above)"
  ok "the web app in a real browser"
fi
echo "all $pass web app test groups passed"
