#!/usr/bin/env bash
# Tests cage's web app (host/ui/server.py and host/ui/static) against a stub msb: who may use it (this computer only,
# the token, which commands and in what shape), how `cage ui` opens it, what odd requests get, and, in a real headless
# browser, the page itself (test/ui.browser.mjs, with test/fixtures/fake-vm.mjs playing an agent's VM).
# Needs node and the playwright package (PLAYWRIGHT_MODULE=/path/to/node_modules/playwright if it isn't global).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
SERVER="" SERVER2="" SERVER3="" SERVER4="" SERVER5="" SERVER6="" VM="" OTHER="" OLD=""
cleanup() { # whatever the tests started, also when one fails halfway
  local p h
  [ -z "$OLD" ] || pkill -P "$OLD" 2>/dev/null || true   # what the older web app below runs
  for p in $SERVER $SERVER2 $SERVER3 $SERVER4 $SERVER5 $SERVER6 $VM $OTHER $OLD; do kill "$p" 2>/dev/null || true; done
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
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
up_pid() { cat "$1/ui.pid"; }   # the web app writes its pid where it keeps its token

mkdir -p "$T/bin" "$T/home" "$T/backups"
cat > "$T/bin/msb" <<'STUB'
#!/usr/bin/env bash
cmd="$1"; shift
case "$cmd" in
  inspect) exit 0 ;;
  ps) echo cage-claude; if [ -e "${STUB_AWAKE:-/nonexistent}" ]; then echo cage-codex; fi ;;
  run) if [ -e "${STUB_NOWAKE:-/nonexistent}" ]; then echo "msb: no room for another VM" >&2; exit 1; fi ;;
  exec) case "$*" in
    *cage:ready*) echo cage:ready ;;
    *strict-mcp-config*) echo 'Paris, says **the stub**' ;;
    *skip-git-repo-check*) echo 'Lyon, says *the other* stub (snake_case_ok)' ;;
    *"auth login"*) url=https://claude.com/cai/oauth/authorize   # where Claude Code 2.x sends you (its own built-in address)
      if [ -e "$STUB_EVIL" ]; then url=https://claude-login.evil.example/oauth/authorize; fi   # an agent that was tricked
      printf 'Browser didn'"'"'t open? Use the url below to sign in (c to copy)\n\n\033[1m%s?code=true&client_id=9d1c&state=xyz\033[0m\n\nPaste code here if prompted > ' "$url"
      read -r c; [ "$c" = "CODE-123" ] && echo "Login successful." ;;
  esac ;;
  logs) case "$*" in
    *"--source system"*) ;;
    *cage-codex*) while :; do echo "codex: still here"; sleep 0.2; done ;;   # a log that never ends
    *) for i in 1 2 3; do echo "cc-connect: line $i"; done
       # what a VM could print to look like one of cage's own questions
       printf '\036{"t":"prompt","text":"To finish, paste your GitHub token","secret":true}\n' ;;
  esac ;;
esac
exit 0
STUB
chmod +x "$T/bin/msb"
# a browser opener that only writes down what it was given
cat > "$T/bin/xdg-open" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$OPENED"
STUB
chmod +x "$T/bin/xdg-open"
export CAGE_HOME="$T/home" CAGE_MSB="$T/bin/msb" CAGE_NO_SELF_UPDATE=1 STUB_AWAKE="$T/codex-awake" STUB_EVIL="$T/evil-signin" STUB_NOWAKE="$T/no-wake" CAGE_BACKUP_DIR="$T/backups" OPENED="$T/opened"
export PATH="$T/bin:$PATH" DISPLAY="${DISPLAY:-:99}"
unset SSH_CONNECTION WSL_DISTRO_NAME
"$ROOT/cage" init 2>/dev/null
printf 'CAGE_AGENTS="claude codex"\nCAGE_TELEGRAM_ALLOW="111"\nCAGE_TELEGRAM_TOKEN_claude="123:AAA-claude"\nCAGE_TELEGRAM_BOT_claude="my_claude_bot"\n' >> "$CAGE_HOME/cage.env"
PORT="$(free_port)"
export CAGE_UI_PORT="$PORT"
# questions an earlier web app handed over in files that cage never got to read (it stopped first)
mkdir -m 700 "$CAGE_HOME/jobs" && echo 'an old question' > "$CAGE_HOME/jobs/0123456789abcdef.txt" && touch -d '1 hour ago' "$CAGE_HOME/jobs/0123456789abcdef.txt"
echo 'a question a job is about to read' > "$CAGE_HOME/jobs/fedcba9876543210.txt"
"$ROOT/cage" ui --no-open 2>"$T/ui.err" || fail "cage ui: $(cat "$T/ui.err")"
SERVER="$(up_pid "$CAGE_HOME")"
TOK="$(cat "$CAGE_HOME/ui.token")"
[ "$(stat -c %a "$CAGE_HOME/ui.token")" = 600 ] && [ "${#TOK}" = 48 ] || fail "token file"
grep -q "running at http://127.0.0.1:$PORT/" "$T/ui.err" && ! grep -q "$TOK" "$T/ui.err" && ! grep -qi "opening\|is open in" "$T/ui.err" \
  || fail "cage ui --no-open should give the address (without the token) and not claim it opened anything: $(cat "$T/ui.err")"
[ ! -e "$OPENED" ] || fail "cage ui --no-open opened a browser"
kill -0 "$SERVER" && grep -q "host/ui/server.py" "/proc/$SERVER/cmdline" || fail "ui.pid isn't the web app's"
[ "$(ls "$CAGE_HOME/jobs")" = fedcba9876543210.txt ] || fail "an old question left in the jobs folder, or a new one taken: $(ls "$CAGE_HOME/jobs")"
rm "$CAGE_HOME/jobs/fedcba9876543210.txt"
B="http://127.0.0.1:$PORT"
code() { curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "$@"; }
head_of() { curl --noproxy '*' -s -D - -o /dev/null "$@"; }   # a GET's headers (the app answers HEAD for the page only)
[ "$(code "$B/api/state")" = 401 ] || fail "state without the token"
[ "$(code -H "X-Cage-Token: nope" "$B/api/state")" = 401 ] || fail "state with a wrong token"
[ "$(code -H "X-Cage-Token: $TOK" -H "Host: evil.example:$PORT" "$B/api/state")" = 403 ] || fail "another host name (DNS rebinding)"
[ "$(code -X POST -H "X-Cage-Token: $TOK" -H "Origin: https://evil.example" -d '{"args":["up"]}' "$B/api/jobs")" = 403 ] || fail "another site's request"
[ "$(code -X POST -H "X-Cage-Token: $TOK" -d '{"args":["_state"]}' "$B/api/jobs")" = 403 ] || fail "an internal command"
[ "$(code -X POST -H "X-Cage-Token: $TOK" -d '{"args":["init"]}' "$B/api/jobs")" = 403 ] || fail "a command the app doesn't use"
[ "$(code "$B/../../cage.env")" = 404 ] && [ "$(code "$B/%2e%2e/%2e%2e/cage")" = 404 ] || fail "files outside the page"
curl --noproxy '*' -sI "$B/" | grep -qi "content-security-policy: default-src 'self'" || fail "no content security policy"
curl --noproxy '*' -s -H "X-Cage-Token: $TOK" "$B/api/state" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["configured"] and d["agents"][0]["state"] == "ready", d' \
  || fail "state"
ok "only this computer, with the token, and only cage's own commands; a strict content security policy"

# A leaked token can't do the worst things: delete an agent, skip a question with a flag, restore a planted backup.
# And other websites get nothing at all, not even a picture, so they can't tell that cage runs here.
H=(-H "X-Cage-Token: $TOK")
J=("${H[@]}" -H "Content-Type: application/json")   # and a body in JSON, as the page sends one to a chat
job() { curl --noproxy '*' -s -o "$T/job.out" -w '%{http_code}' "${H[@]}" -X POST --data-binary "$1" "$B/api/jobs"; }
jid() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$T/job.out"; }
for args in '["destroy","claude","--yes"]' '["status"]' '["version"]' '["onboard"]' '[""]' '["up","--refresh"]' '["up","nobody"]' \
  '["login","claude","codex"]' '["secret","add","--force","x.example"]' '["ask","what is this?","claude"]'; do
  [ "$(job "{\"args\":$args}")" = 403 ] || fail "the web app ran cage $args: $(cat "$T/job.out")"
done
echo 'not a backup' > "$T/evil.cagebackup" && echo 'nor this' > "$T/backups/notes.txt"
for f in "$T/evil.cagebackup" "$T/backups/../evil.cagebackup" "$T/backups/notes.txt"; do
  [ "$(job "{\"args\":[\"restore\",\"$f\"]}")" = 403 ] && grep -q "backups from $T/backups only" "$T/job.out" || fail "restore from $f: $(cat "$T/job.out")"
done
# A VM can't swap the file while cage waits for the passphrase: a link in its chat folder points into the backups
# folder for the check, then at a backup it planted (made with cage's own settings, and a passphrase it knows)
F="$CAGE_HOME/app/claude/files"
mkdir -p "$F/planted" "$T/stage/config"
echo 'a real backup' > "$T/backups/mine.cagebackup"
printf 'touch %q\n' "$T/planted-ran" > "$T/stage/config/cage.env"
printf '{"created": "2026-01-01", "agents": ""}\n' > "$T/stage/manifest.json"
tar -C "$T/stage" -c manifest.json config | gzip | openssl enc -aes-256-cbc -pbkdf2 -iter "$(sed -n 's/^BACKUP_ITER=//p' "$ROOT/cage")" \
  -pass pass:planted-pass -out "$F/planted/mine.cagebackup"
ln -s "$T/backups" "$F/link"
[ "$(job "{\"args\":[\"restore\",\"$F/link/mine.cagebackup\"]}")" = 200 ] || fail "restore through a link into the backups folder: $(cat "$T/job.out")"
python3 - "$B" "$TOK" "$(jid)" "$F" <<'PY' > "$T/restore.out" || fail "restore while the link changed: $(cat "$T/restore.out")"
import json, os, sys, urllib.request
base, tok, jid, F = sys.argv[1:]
def answer(text):
    req = urllib.request.Request(f"{base}/api/jobs/{jid}/input", json.dumps({"text": text}).encode(), {"X-Cage-Token": tok})
    urllib.request.urlopen(req, timeout=10).read()
for line in urllib.request.urlopen(f"{base}/api/jobs/{jid}/events?from=0&token={tok}", timeout=60):
    if not line.startswith(b"data: "):
        continue
    ev = json.loads(line[6:])
    if ev["t"] == "exit":
        break
    e = ev.get("event") or {}
    print(e.get("t"), e.get("text"))
    if e.get("t") == "prompt":   # waiting for the passphrase: the VM points its link at the planted backup
        os.remove(F + "/link")
        os.symlink(F + "/planted", F + "/link")
        answer("planted-pass")
    elif e.get("t") == "confirm":
        answer("y")
PY
grep -q "^bad couldn't open that backup" "$T/restore.out" && [ ! -e "$T/planted-ran" ] || fail "a backup a VM planted was restored: $(cat "$T/restore.out")"
rm -rf "$F" "$T/backups/mine.cagebackup" "$T/stage"
for site in cross-site same-site; do
  [ "$(code -H "Sec-Fetch-Site: $site" "$B/logo.svg")" = 403 ] && [ "$(code -H "Sec-Fetch-Site: $site" "${H[@]}" "$B/api/state")" = 403 ] \
    && [ "$(code -H "Sec-Fetch-Site: $site" "$B/healthz")" = 403 ] || fail "a $site request was answered"
done
[ "$(code -H "Sec-Fetch-Site: same-origin" "$B/logo.svg")" = 200 ] && [ "$(code -H "Sec-Fetch-Site: none" "$B/")" = 200 ] || fail "the page itself was refused"
fx=(-H "Sec-Fetch-Site: cross-site" -H "Sec-Fetch-Mode: navigate")   # a link on another website
[ "$(code "${fx[@]}" -H "Sec-Fetch-Dest: document" "$B/")" = 200 ] && [ "$(code "${fx[@]}" -H "Sec-Fetch-Dest: iframe" "$B/")" = 403 ] \
  && [ "$(code "${fx[@]}" -H "Sec-Fetch-Dest: document" "${H[@]}" "$B/api/state")" = 403 ] || fail "a link from another website"
ok "the app can't delete an agent, add flags, or restore from outside the backups folder (not even through a link a VM changes); other websites get nothing"

# Odd requests get a plain answer (and never a hang or a dropped connection)
raw() { python3 - "$PORT" "$1" <<'PY'
import socket, sys
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5)
s.sendall(sys.argv[2].encode().replace(b"\\r\\n", b"\r\n") + b"x" * 1000)
print(s.recv(4096).split(b"\r\n")[0].decode())
PY
}
[ "$(raw "POST /api/chat/claude/upload?name=a.txt HTTP/1.1\r\nHost: 127.0.0.1:$PORT\r\nX-Cage-Token: $TOK\r\nContent-Length: -1\r\n\r\n")" = "HTTP/1.1 400 Bad Request" ] \
  || fail "a negative Content-Length"
[ "$(raw "POST /api/jobs HTTP/1.1\r\nHost: 127.0.0.1:$PORT\r\nX-Cage-Token: $TOK\r\n\r\n")" = "HTTP/1.1 411 Length Required" ] || fail "no Content-Length"
[ "$(raw "POST /api/jobs HTTP/1.1\r\nHost: 127.0.0.1:$PORT\r\nX-Cage-Token: $TOK\r\nTransfer-Encoding: chunked\r\n\r\n")" = "HTTP/1.1 411 Length Required" ] \
  || fail "a chunked body"
[ ! -e "$CAGE_HOME/app/claude/files" ] || [ -z "$(ls -A "$CAGE_HOME/app/claude/files")" ] || fail "an upload without a size was kept"
[ "$(job '[]')" = 400 ] && [ "$(job '"up"')" = 400 ] && [ "$(job '{"args":')" = 400 ] || fail "a body that isn't a JSON object"
s=$SECONDS
[ "$(code -m 5 -I "${H[@]}" "$B/api/chat/stream?from=claude:0")" = 405 ] && [ $((SECONDS - s)) -le 2 ] || fail "HEAD on the chat stream"
curl --noproxy '*' -sI "$B/" | head -1 | grep -q 200 || fail "HEAD on the page"
[ "$(code -X PUT "${H[@]}" -d '[1]' "$B/api/memory/about")" = 400 ] || fail "PUT with a list"
python3 - "$PORT" "$TOK" <<'PY' || fail "the request after one whose body wasn't read (a resize for a job that's gone)"
import re, socket, sys
port, tok = sys.argv[1].encode(), sys.argv[2].encode()
s = socket.create_connection(("127.0.0.1", int(port)), timeout=5)
body = b'{"cols":80,"rows":24}'
s.sendall(b"POST /api/jobs/nosuchjob/resize HTTP/1.1\r\nHost: 127.0.0.1:%s\r\nX-Cage-Token: %s\r\nContent-Length: %d\r\n\r\n%s"
          % (port, tok, len(body), body) + b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:%s\r\n\r\n" % port)
data = b""
while True:
    chunk = s.recv(65536)
    if not chunk:
        break
    data += chunk
said = re.findall(rb"HTTP/1\.1 (\d{3}) ", data)   # (an answer can start right after the one before)
assert said[0] == b"404" and b"501" not in said, data
PY
if grep -q Traceback "$CAGE_HOME/ui.log" 2>/dev/null; then fail "the server crashed on a request: $(cat "$CAGE_HOME/ui.log")"; fi
ok "odd requests: a negative or missing size, chunks, not an object, HEAD on a stream, all answered at once; a body left unread never passes for the next request"

# A question for your agents goes to cage in a file (other users can read command lines), however long it is
events() { # events <job id>: everything the job printed, as {"n","t",…} lines, once it has ended
  curl --noproxy '*' -s -m 20 "$B/api/jobs/$1/events?from=0&token=$TOK" | sed -n 's/^data: //p'
}
python3 -c 'import json; print(json.dumps({"args": ["ask", "claude"], "text": "Follow-up question: " + "and then? " * 2000}))' > "$T/long.json"
[ "$(job "@$T/long.json")" = 200 ] || fail "a 20,000-character follow-up: $(cat "$T/job.out")"
events "$(jid)" > "$T/ev"
python3 - "$T/ev" <<'PY' || fail "the long question: $(head -c 600 "$T/ev")"
import json, sys
evs = [json.loads(line) for line in open(sys.argv[1])]
said = [e["event"] for e in evs if e["t"] == "event"]
assert [e for e in said if e["t"] == "asking" and e["text"] == "Follow-up question: " + "and then? " * 2000], said
assert [e for e in said if e["t"] == "answer" and e["text"].startswith("Paris")] and evs[-1] == dict(evs[-1], t="exit", code=0), evs[-3:]
PY
[ -z "$(ls -A "$CAGE_HOME/jobs")" ] || fail "the question was left in the jobs folder: $(ls "$CAGE_HOME/jobs")"
[ "$(stat -c %a "$CAGE_HOME/jobs")" = 700 ] || fail "the jobs folder isn't private"
# An agent's CLI gets the question as one argument, which Linux caps at 128 KiB: 130 KiB (in Cyrillic, 66,560
# characters) is refused in words, not left to fail in the VM. Trying the privacy mask on that much is fine (stdin).
python3 -c 'import json; print(json.dumps({"args": ["ask", "claude"], "text": "я" * 66560}))' > "$T/big.json"
[ "$(job "@$T/big.json")" = 413 ] && grep -q "That question is too long to send" "$T/job.out" || fail "a 130 KiB question: $(cat "$T/job.out")"
python3 -c 'import json; print(json.dumps({"args": ["mask", "try"], "text": "я" * 66560}))' > "$T/big.json"
[ "$(job "@$T/big.json")" = 200 ] && events "$(jid)" | tail -1 | grep -q '"code": 0' || fail "the privacy mask tried on 130 KiB: $(cat "$T/job.out")"
python3 -c 'import json; print(json.dumps({"args": ["mask", "try"], "text": "x" * 600000}))' > "$T/big.json"
[ "$(job "@$T/big.json")" = 413 ] && grep -q "too long to send" "$T/job.out" || fail "the privacy mask tried on 600 KB: $(cat "$T/job.out")"
[ "$(job '{"args":["up"],"text":"hi"}')" = 400 ] && [ "$(job '{"args":["ask","claude"]}')" = 400 ] || fail "text for a command that takes none, or none for ask"
[ "$(job '{"args":["ask","claude"],"text":"my private question","cols":"wide"}')" = 400 ] || fail "a job that can't start: $(cat "$T/job.out")"
[ -z "$(ls -A "$CAGE_HOME/jobs")" ] || fail "the question of a job that never started was left behind: $(cat "$CAGE_HOME"/jobs/*)"
ok "a 20,000-character follow-up goes to cage in a private file, which is gone afterwards, also when the job can't start; over 128 KiB is refused in words"

# Each job has a code only cage knows: what a VM prints that looks like one of cage's questions stays plain output
[ "$(job '{"args":["logs","claude"],"title":"logs"}')" = 200 ] || fail "logs: $(cat "$T/job.out")"
events "$(jid)" > "$T/ev"
python3 - "$T/ev" <<'PY' || fail "a faked question: $(cat "$T/ev")"
import base64, json, sys
evs = [json.loads(line) for line in open(sys.argv[1])]
raw = b"".join(base64.b64decode(e["data"]) for e in evs if e["t"] == "raw")
assert b"cc-connect: line 3" in raw and b"paste your GitHub token" in raw, raw
assert not [e for e in evs if e["t"] == "event"], evs
PY
ok "a VM can't fake one of cage's questions: without the job's code, it's shown as the VM's own output"

# A job keeps going when the page that started it goes away; the page finds it again in the list
[ "$(job '{"args":["secret","add","UI_WAIT","api.wait.example","claude"],"title":"Add UI_WAIT"}')" = 200 ] || fail "secret add: $(cat "$T/job.out")"
id="$(jid)"
curl --noproxy '*' -s -m 2 "$B/api/jobs/$id/events?from=0&token=$TOK" >/dev/null || true   # a page that watched it, then left
curl --noproxy '*' -s "${H[@]}" "$B/api/jobs" | python3 -c 'import json,sys; j=json.load(sys.stdin)["jobs"]; assert [x for x in j if x["title"] == "Add UI_WAIT" and x["args"][:2] == ["secret", "add"]], j' \
  || fail "the running job isn't listed"
[ "$(code -X POST "${H[@]}" -d '{}' "$B/api/jobs/$id/cancel")" = 200 ] || fail "cancel"
events "$id" | grep -q '"t": "exit"' || fail "cancel didn't stop it"
curl --noproxy '*' -s "${H[@]}" "$B/api/jobs" | python3 -c 'import json,sys; assert not json.load(sys.stdin)["jobs"]' || fail "a stopped job is still listed"
# an answer shows in its events (that it went in, not what it was); a browser that reconnects gets nothing twice
events_now() { { curl --noproxy '*' -s -m 1 "$B/api/jobs/$1/events?from=0&token=$TOK" || true; } | sed -n 's/^data: //p'; }   # so far
[ "$(job '{"args":["secret","add","UI_ANSWER","api.answer.example","claude"],"title":"Add UI_ANSWER"}')" = 200 ] || fail "secret add: $(cat "$T/job.out")"
id="$(jid)"
for _ in $(seq 20); do case "$(events_now "$id")" in *'"t": "prompt"'*) break ;; esac; done
[ "$(code -X POST "${H[@]}" -d '{"text":"answer-s3cret"}' "$B/api/jobs/$id/input")" = 200 ] || fail "an answer"
events "$id" > "$T/ev"
grep -q '"t": "input"' "$T/ev" && ! grep -q 'answer-s3cret' "$T/ev" && grep -q 'UI_ANSWER saved' "$T/ev" || fail "the answer in the job's events: $(cat "$T/ev")"
n="$(python3 -c 'import json,sys; print([e["n"] for e in map(json.loads, open(sys.argv[1])) if e["t"] == "input"][0])' "$T/ev")"
curl --noproxy '*' -s -m 5 -H "Last-Event-ID: $n" "$B/api/jobs/$id/events?from=0&token=$TOK" > "$T/ev2" || true
[ "$(sed -n 's/^id: //p' "$T/ev2" | head -1)" = $((n + 1)) ] && [ "$(grep -c '^data: ' "$T/ev2")" = $(($(wc -l < "$T/ev") - n - 1)) ] \
  || fail "reconnecting after event $n: $(cat "$T/ev2")"
ok "jobs: still running after the page left, listed for a page that comes back; Stop ends them; answers, reconnects"

# The chat folders are written by the VMs: the app never follows a link out of them, never shows an agent's page
A="$CAGE_HOME/app"
mkdir -p "$A/claude/files" "$A/cursor" "$T/elsewhere" && chmod 700 "$A"
ln -s "$CAGE_HOME/cage.env" "$A/claude/files/1-ab-evil.png"
printf '<script>alert(1)</script>' > "$A/claude/files/1-ab-page.html"
printf 'PNG' > "$A/claude/files/1-ab-pic.png"
ln -s "$T/elsewhere" "$A/cursor/in"
[ "$(code "${H[@]}" "$B/api/chat/claude/file?p=files/1-ab-evil.png")" = 404 ] || fail "followed a link out of the chat folder"
[ "$(code "${H[@]}" "$B/api/chat/claude/file?p=files/../../cage.env")" = 404 ] && [ "$(code "${H[@]}" "$B/api/chat/claude/file?p=../cage.env")" = 404 ] || fail "a path out of the chat folder"
head_of "${H[@]}" "$B/api/chat/claude/file?p=files/1-ab-page.html" | grep -qi '^content-disposition: attachment' || fail "an agent's page shown in the app"
head_of "${H[@]}" "$B/api/chat/claude/file?p=files/1-ab-pic.png" | grep -qi '^content-type: image/png' || fail "pictures are shown"
[ "$(code "${J[@]}" -X POST -d '{"text":"hi"}' "$B/api/chat/cursor/send")" != 200 ] && [ -z "$(ls -A "$T/elsewhere")" ] || fail "wrote through a link"
[ "$(code "${H[@]}" "$B/api/chat/evil/history")" = 400 ] || fail "not an agent"
rm -f "$A/claude/files/1-ab-evil.png" "$A/cursor/in"
ok "chat folders: no links followed, no way out, an agent's pages download instead of opening"

# Home reads the end of each agent's chat: an approval waiting for you, whether it's working, what it said last and
# today's counts. The VM writes those logs, so they're read as the chat is: a log that's a link isn't read at all.
python3 - "$A" > "$T/since" <<'PY'
import json, os, sys, time
A, now = sys.argv[1], int(time.time() * 1000)
perm = [[{"text": "Allow", "data": "perm:allow"}, {"text": "Deny", "data": "perm:deny"}]]
def log(agent, *entries):
    os.makedirs(os.path.join(A, agent), exist_ok=True)
    with open(os.path.join(A, agent, "log.jsonl"), "w") as f:
        f.write("".join(json.dumps(e) + "\n" for e in entries))
log("antigravity", {"t": "you", "text": "yesterday", "at": now - 86400000}, {"t": "reply", "text": "**Yesterday's** answer", "at": now - 86400000},
    {"t": "you", "text": "email bob", "at": now - 60000}, {"t": "typing", "on": True, "at": now - 59000},
    {"t": "buttons", "text": "May I send it?", "buttons": perm, "at": now - 50000},
    {"t": "buttons", "session": "usage", "text": "not in your chat", "buttons": perm, "at": now - 40000})
log("cursor", {"t": "you", "text": "a", "at": now - 9000}, {"t": "buttons", "text": "May I?", "buttons": perm, "at": now - 8000},
    {"t": "action", "action": "perm:allow", "at": now - 7000}, {"t": "reply", "text": "Done", "at": now - 6000},
    {"t": "file", "name": "notes.md", "at": now - 5000}, {"t": "you", "text": "b", "at": now - 4000}, {"t": "typing", "on": True, "at": now - 3000})
log("codex")
os.remove(os.path.join(A, "codex", "log.jsonl"))
os.symlink(os.path.join(A, "antigravity", "log.jsonl"), os.path.join(A, "codex", "log.jsonl"))   # what a VM could plant
print(now - 3600000)
PY
activity() { curl --noproxy '*' -s "${H[@]}" "$B/api/activity?agents=$1&since=$(cat "$T/since")"; }
activity antigravity,cursor,codex,evil > "$T/activity.json"
python3 - "$T/activity.json" <<'PY' || fail "what Home reads from the chats: $(cat "$T/activity.json")"
import json, sys
a = json.load(open(sys.argv[1]))["agents"]
assert sorted(a) == ["antigravity", "codex", "cursor"], a
g, c, x = a["antigravity"], a["cursor"], a["codex"]
assert g["pending"]["text"] == "May I send it?" and not g["working"], g   # waiting for you isn't working
assert g["last"]["text"] == "**Yesterday's** answer" and g["today"] == {"asked": 1, "answers": 0, "files": 0}, g
assert c["pending"] is None and c["working"] and c["last"]["t"] == "file" and c["today"] == {"asked": 2, "answers": 1, "files": 1}, c
assert x == {"pending": None, "last": None, "today": {"asked": 0, "answers": 0, "files": 0}, "working": False}, x   # the planted link
PY
# Allow on Home goes with the approval Home showed: one the agent isn't waiting for any more is refused, and nothing is sent
python3 - "$T/activity.json" "$T/allow" <<'PY'
import json, sys
pending = json.load(open(sys.argv[1]))["agents"]["antigravity"]["pending"]
for name, p in (("now", pending), ("old", dict(pending, at=pending["at"] - 1)), ("other", dict(pending, text="May I delete it?"))):
    with open(f"{sys.argv[2]}-{name}.json", "w") as f:
        json.dump({"action": "perm:allow", "label": "Allow", "pending": p}, f)
PY
allow() { curl --noproxy '*' -s -o "$T/allowed.json" -w '%{http_code}' "${J[@]}" -X POST --data-binary @"$T/allow-$1.json" "$B/api/chat/antigravity/action"; }
for was in old other; do
  [ "$(allow $was)" = 409 ] && grep -q "waiting for that any more" "$T/allowed.json" && [ -z "$(ls -A "$A/antigravity/in" 2>/dev/null)" ] \
    || fail "Home's Allow for an approval it isn't waiting for ($was): $(cat "$T/allowed.json")"
done
[ "$(allow now)" = 200 ] && grep -q '"action": "perm:allow"' "$A"/antigravity/in/*.json || fail "Home's Allow for the approval it waits for: $(cat "$T/allowed.json")"
rm -rf "$A/cursor" "$A/codex/log.jsonl"
ln -s "$A/antigravity" "$A/cursor"   # a chat folder that is itself a link: skipped, not followed
[ "$(activity cursor,antigravity | python3 -c 'import json,sys; print(sorted(json.load(sys.stdin)["agents"]))')" = "['antigravity']" ] \
  || fail "a chat folder that's a link was read"
rm -rf "$A/cursor" "$A/antigravity"
[ "$(activity cursor)" = '{"agents": {}}' ] && [ ! -e "$A/cursor" ] || fail "an agent with no chat yet: $(activity cursor)"
ok "Home reads the end of each chat: an approval waiting for you, working, the last answer, today's counts; no links followed"

# Any file name downloads, under its own name; a file too big to send whole isn't sent at all
curl --noproxy '*' -s "${H[@]}" -X POST --data-binary 'PDF bytes' "$B/api/chat/claude/upload?name=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("отчёт 報告.pdf"))')" > "$T/up.json"
p="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["path"])' "$T/up.json")" || fail "upload: $(cat "$T/up.json")"
curl --noproxy '*' -s -i "${H[@]}" "$B/api/chat/claude/file?p=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$p")&dl=1" > "$T/dl"
[ "$(grep -ac '^HTTP/' "$T/dl")" = 1 ] && head -1 "$T/dl" | grep -q ' 200 ' && [ "$(tail -c 9 "$T/dl")" = 'PDF bytes' ] || fail "a Cyrillic and Chinese name: $(cat -v "$T/dl")"
grep -qi "^content-disposition: attachment; filename=\"file.pdf\"; filename\*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20%E5%A0%B1%E5%91%8A.pdf" "$T/dl" \
  || fail "the download's name: $(grep -ai disposition "$T/dl")"
head -c $((30 << 20)) /dev/zero > "$A/claude/files/1791184190403-ab12-big.bin"
[ "$(curl --noproxy '*' -s -o "$T/big" -w '%{http_code}' "${H[@]}" "$B/api/chat/claude/file?p=files/1791184190403-ab12-big.bin")" = 413 ] \
  && grep -q "bigger than 25 MB" "$T/big" || fail "a 30 MB file: $(head -c 300 "$T/big")"
rm -f "$A/claude/files/1791184190403-ab12-big.bin"
ok "downloads: any file name (an ASCII stand-in plus the real one), and a file over 25 MB is refused, not cut short"
curl --noproxy '*' -sI "$B/manifest.webmanifest" | grep -qi '^content-type: application/manifest+json' && curl --noproxy '*' -s "$B/manifest.webmanifest" | python3 -c 'import json,sys; m=json.load(sys.stdin); assert m["name"] == "cage" and m["display"] == "standalone"' \
  && [ "$(code "$B/sw.js")" = 200 ] && [ "$(code "$B/icon-maskable.png")" = 200 ] && curl --noproxy '*' -s "$B/offline.html" | grep -q "cage isn’t running on this computer" \
  || fail "installable as an app"
ok "installable as an app: a manifest, icons, a service worker, and a page for when cage isn't running"

# `cage ui` checks that what answers on the port is cage's own web app, and opens it with a one-time code, never the token
n=0123456789abcdef
[ "$(curl --noproxy '*' -s "$B/healthz?nonce=$n")" = "$(python3 -c 'import hashlib,hmac,sys; print(hmac.new(sys.argv[1].encode(), sys.argv[2].encode(), hashlib.sha256).hexdigest())' "$TOK" "$n")" ] \
  || fail "healthz with a nonce"
[ "$(code "$B/healthz?nonce=a;b")" = 400 ] && [ "$(code -H "Host: evil.example:$PORT" "$B/healthz?nonce=$n")" = 403 ] || fail "healthz with a bad nonce, or for another site"
"$ROOT/cage" ui 2>"$T/ui.err" || fail "cage ui: $(cat "$T/ui.err")"
for _ in $(seq 50); do [ -s "$OPENED" ] && break; sleep 0.1; done   # the browser opens in the background
[ "$(wc -l < "$OPENED")" = 1 ] && grep -q "^http://127.0.0.1:$PORT/#pair=[0-9a-f]\{32\}$" "$OPENED" && ! grep -q "$TOK" "$OPENED" "$T/ui.err" \
  || fail "cage ui opened: $(cat "$OPENED"); said: $(cat "$T/ui.err")"
[ "$(stat -c %a "$CAGE_HOME/ui.pair")" = 600 ] || fail "ui.pair isn't private"
pc="$(sed 's/.*#pair=//' "$OPENED")"
pair() { curl --noproxy '*' -s -o "$T/pair.out" -w '%{http_code}' -X POST -d "{\"code\":\"$1\"}" "$B/api/pair"; }
[ "$(pair "$pc")" = 200 ] && grep -q "\"token\": \"$TOK\"" "$T/pair.out" || fail "pairing: $(cat "$T/pair.out")"
[ "$(pair "$pc")" = 403 ] && grep -q "expired or was already used" "$T/pair.out" || fail "a pairing code worked twice"
echo "$(($(date +%s) - 5)) 00112233445566778899aabbccddeeff" >> "$CAGE_HOME/ui.pair"
[ "$(pair 00112233445566778899aabbccddeeff)" = 403 ] && [ "$(pair "")" = 403 ] || fail "an expired or empty pairing code"
: > "$OPENED"
SSH_CONNECTION="10.0.0.2 50000 10.0.0.1 22" DISPLAY="" WAYLAND_DISPLAY="" "$ROOT/cage" ui 2>"$T/ui.err" || fail "cage ui over SSH: $(cat "$T/ui.err")"
sleep 0.3
grep -q "ssh -L $PORT:127.0.0.1:$PORT" "$T/ui.err" && grep -q "#pair=" "$T/ui.err" && [ ! -s "$OPENED" ] || fail "cage ui over SSH: $(cat "$T/ui.err")"
OPORT="$(free_port)"
echo 'hello' > "$T/other.says"   # another program on the port: it says what's in other.says to anything
python3 -c 'import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(open(sys.argv[2], "rb").read().strip())
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()' "$OPORT" "$T/other.says" & OTHER=$!
for _ in $(seq 50); do [ "$(code "http://127.0.0.1:$OPORT/healthz")" = 200 ] && break; sleep 0.1; done
: > "$OPENED"
if CAGE_UI_PORT="$OPORT" "$ROOT/cage" ui 2>"$T/ui.err"; then fail "cage ui trusted another program on its port"; fi
grep -q "something else is using port $OPORT" "$T/ui.err" && [ ! -s "$OPENED" ] || fail "another program on the port: $(cat "$T/ui.err")"
echo 'ok' > "$T/other.says"   # what an older cage web app says (and anything could say)
if CAGE_UI_PORT="$OPORT" "$ROOT/cage" ui 2>"$T/ui.err"; then fail "cage ui trusted what an older web app says"; fi
grep -q "an older version of cage's web app is still running" "$T/ui.err" && [ ! -s "$OPENED" ] || fail "an older web app on the port: $(cat "$T/ui.err")"
kill "$OTHER"; OTHER=""
# This cage's own web app from before an update (an older one, which says only "ok") that never restarted itself:
# cage ui stops it and starts the new one, unless it's busy with something real
U="$(mkdir -p "$T/old (v0.3)" && cd "$T/old (v0.3)" && pwd -P)"   # (a folder name that isn't a safe pattern)
tar --exclude=.git --exclude=node_modules -C "$ROOT" -cf - . | tar -C "$U" -xf -
cp "$U/host/ui/server.py" "$T/new-server.py"
cat > "$U/host/ui/server.py" <<'PY'
import http.server, os, subprocess, threading
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass
threading.Thread(target=subprocess.call, args=(["sleep", "300"],), daemon=True).start()   # a job that isn't a log
http.server.HTTPServer(("127.0.0.1", int(os.environ["CAGE_UI_PORT"])), H).serve_forever()
PY
OPORT="$(free_port)"
CAGE_HOME="$T/upd-home" CAGE_UI_PORT="$OPORT" python3 "$U/host/ui/server.py" "$U/cage" & OLD=$!
for _ in $(seq 50); do [ "$(code "http://127.0.0.1:$OPORT/healthz")" = 200 ] && break; sleep 0.1; done
cp "$T/new-server.py" "$U/host/ui/server.py"   # the update: new code on disk, the old still running
if CAGE_HOME="$T/upd-home" CAGE_UI_PORT="$OPORT" "$U/cage" ui --no-open 2>"$T/ui.err"; then fail "cage ui stopped an older web app that was busy"; fi
grep -q "an older version of cage's web app is still running" "$T/ui.err" && kill -0 "$OLD" || fail "a busy older web app: $(cat "$T/ui.err")"
pkill -P "$OLD" sleep
CAGE_HOME="$T/upd-home" CAGE_UI_PORT="$OPORT" "$U/cage" ui --no-open 2>"$T/ui.err" || fail "cage ui didn't replace its own older web app: $(cat "$T/ui.err")"
SERVER5="$(up_pid "$T/upd-home")"
for _ in $(seq 20); do kill -0 "$OLD" 2>/dev/null || break; sleep 0.1; done
! kill -0 "$OLD" 2>/dev/null && grep -q "$U/host/ui/server.py" "/proc/$SERVER5/cmdline" || fail "the older web app is still there, or the new one isn't"
kill "$SERVER5"; SERVER5="" OLD=""
ok "cage ui: checks it's cage on the port (an older one or another program isn't trusted, its own older one is replaced once it's idle), opens a one-time code (never the token), and over SSH says how to connect"

# Start at login also starts the web app, so the installed app opens after a restart
PORT4="$(free_port)"
mkdir -p "$T/auto"
CAGE_HOME="$T/auto" CAGE_UI_PORT="$PORT4" "$ROOT/cage" _autostart 2>/dev/null || true
SERVER4="$(up_pid "$T/auto" 2>/dev/null || true)"
[ -n "$SERVER4" ] && [ "$(code "http://127.0.0.1:$PORT4/")" = 200 ] && grep -q "running at http://127.0.0.1:$PORT4/" "$T/auto/autostart.log" \
  || fail "_autostart didn't start the web app: $(cat "$T/auto/autostart.log")"
# A Mac has no setsid, so cage ui starts the web app in its own process group: the web app leaves it by itself, or
# start at login (launchd) would stop it as soon as the command it ran ends
PORT6="$(free_port)"
mkdir -p "$T/group"
CAGE_HOME="$T/group" CAGE_UI_PORT="$PORT6" python3 "$ROOT/host/ui/server.py" "$ROOT/cage" & SERVER6=$!
for _ in $(seq 50); do [ "$(code "http://127.0.0.1:$PORT6/healthz")" = 200 ] && break; sleep 0.1; done
[ "$(ps -o pgid= -p "$SERVER6" | tr -d ' ')" = "$SERVER6" ] || fail "the web app stayed in the process group of the command that started it"
kill "$SERVER6"; SERVER6=""
ok "start at login: the web app starts too, in a process group of its own"

# A job ends with its terminal, as a command does when its window closes: once the web app is gone, a log someone left
# open stops too (cage ui starts the web app with nohup, which its jobs would otherwise inherit)
endless() { pgrep -f "$T/bin/msb logs (--tail [0-9]+ )?-f cage-codex" >/dev/null; }
curl --noproxy '*' -s -o /dev/null -H "X-Cage-Token: $(cat "$T/auto/ui.token")" -X POST -d '{"args":["logs","codex"]}' "http://127.0.0.1:$PORT4/api/jobs"
for _ in $(seq 50); do endless && break; sleep 0.1; done
endless || fail "the endless log didn't start"
kill "$SERVER4"; SERVER4=""
for _ in $(seq 50); do endless || break; sleep 0.1; done
if endless; then fail "a job outlived the web app"; fi
ok "a job ends when the web app is gone"

mkdir -p "$T/work/reports" && printf 'Q3: up 12%%\n' > "$T/work/reports/q3-results.txt" && printf '# Notes\n' > "$T/work/notes.md"

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
PORT2="$(free_port)"
CAGE_HOME="$T/fresh" CAGE_MSB="$T/bin2/msb" CAGE_UI_PORT="$PORT2" STUB_SIGNED="$T/signed" "$ROOT/cage" ui --no-open 2>/dev/null || fail "the second cage ui"
SERVER2="$(up_pid "$T/fresh")"
B2="http://127.0.0.1:$PORT2"
TOK2="$(cat "$T/fresh/ui.token")"
node "$ROOT/test/fixtures/fake-vm.mjs" "$A/claude" "$T/work" & VM=$!

# A work-folder file keeps its whole name when you download it (the VM hands it over as files/<time>-<random>-<name>)
for _ in $(seq 50); do [ -d "$A/claude/out" ] && break; sleep 0.1; done
curl --noproxy '*' -s "${J[@]}" -X POST -d '{"type":"fetch","path":"reports/q3-results.txt"}' "$B/api/chat/claude/request" > "$T/fetch.json"
p="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["path"])' "$T/fetch.json")" || fail "fetch: $(cat "$T/fetch.json")"
head_of "${H[@]}" "$B/api/chat/claude/file?p=$p&dl=1" | grep -qi "filename=\"q3-results.txt\"; filename\*=UTF-8''q3-results.txt" || fail "q3-results.txt lost part of its name"
ok "a work-folder file downloads under its own name"

# Plan usage on Home asks the agent (/usage) at most every 10 minutes, however often the page asks, also with "fresh"
for body in '{}' '{}' '{"fresh":true}'; do
  curl --noproxy '*' -s "${J[@]}" -X POST -d "$body" "$B/api/chat/claude/usage" > "$T/usage.json"
done
python3 -c 'import json,sys,time; u=json.load(open(sys.argv[1])); assert "Remaining: 58%" in u["card"]["elements"][0]["content"] and time.time() - u["asked"] < 60, u' "$T/usage.json" \
  && [ "$(grep -c '"t":"card","session":"usage"' "$A/claude/log.jsonl")" = 1 ] || fail "plan usage, asked three times: $(cat "$T/usage.json"); $(grep -c usage "$A/claude/log.jsonl")"
ok "plan usage: the agent is asked once, however often the page asks"

# An installed release (a VERSION file), for updating while the app is open: the server restarts itself with the new
# code once nothing is running, and the page reloads to get the new page
mkdir -p "$T/inst" && tar --exclude=.git --exclude=node_modules -C "$ROOT" -cf - . | tar -C "$T/inst" -xf - && echo v1.0.0 > "$T/inst/VERSION"
touch -d '2000-01-01 00:00Z' "$T/inst/host/ui/server.py"   # dated as a release dates its files (to the second)
PORT3="$(free_port)"
CAGE_UI_PORT="$PORT3" "$T/inst/cage" ui --no-open 2>/dev/null || fail "the installed cage ui"
SERVER3="$(up_pid "$CAGE_HOME")"
grep -q "$T/inst/host/ui/server.py" "/proc/$SERVER3/cmdline" || fail "the installed web app's pid"

if command -v node >/dev/null 2>&1; then
  PLAYWRIGHT_MODULE="${PLAYWRIGHT_MODULE:-$(npm root -g 2>/dev/null)/playwright}" node "$ROOT/test/ui.browser.mjs" "$B" "$TOK" "$CAGE_HOME" "$T/work" "$B2" "$TOK2" "$T/fresh" "http://127.0.0.1:$PORT3" "$T/inst" "$SERVER3" \
    || fail "the web app in a browser (above)"
  ok "the web app in a real browser"
fi
echo "all $pass web app test groups passed"
