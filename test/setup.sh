#!/usr/bin/env bash
# Tests `cage setup`, `cage doctor`'s token check and `cage autostart` against a mock Telegram Bot API
# (python3) and stub launchctl/systemctl/uname. No network, no real bots.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
MOCK_PID=""
cleanup() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }

# --- mock Telegram Bot API: tokens "<n>:GOOD<x>" are valid; one pending message from user 4242
cat > "$T/mock.py" <<'PY'
import http.server, json, re, sys
log = open(sys.argv[2], "a")
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        log.write(self.path + "\n"); log.flush()
        m = re.match(r"^/bot([^/]+)/(\w+)", self.path)
        token, method = m.group(1), m.group(2)
        if ":GOOD" not in token:
            return self.reply(401, {"ok": False, "error_code": 401, "description": "Unauthorized"})
        if method == "getMe":
            name = token.split(":GOOD")[1] or "x"
            return self.reply(200, {"ok": True, "result": {"id": 1, "is_bot": True, "first_name": "Dot", "username": "dot_" + name + "_bot"}})
        if method == "getUpdates":
            if "offset=" in self.path:
                return self.reply(200, {"ok": True, "result": []})
            return self.reply(200, {"ok": True, "result": [{"update_id": 500, "message": {"message_id": 7,
                "from": {"id": 4242, "is_bot": False, "first_name": "Zack", "username": "zack"},
                "chat": {"id": 4242, "type": "private"}, "date": 0, "text": "hi"}}]})
        self.reply(404, {"ok": False})
    def reply(self, code, body):
        data = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
PY
python3 "$T/mock.py" "$T/port" "$T/requests.log" &
MOCK_PID=$!
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
[ -s "$T/port" ] || fail "mock server did not start"
port="$(cat "$T/port")"
export CAGE_TELEGRAM_API="http://127.0.0.1:$port" CAGE_HOME="$T/home" HOME="$T/userhome"
unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy
mkdir -p "$HOME"
cage() { "$ROOT/cage" "$@"; }

# --- setup: rejects a malformed token and a revoked one, accepts good ones, learns the user id
printf '%s\n' 'not-a-token' '999:REVOKED' '100:GOODclaude' '200:GOODcodex' 'y' | cage setup claude codex 2>"$T/setup.err" || fail "setup failed: $(cat "$T/setup.err")"
env_file="$CAGE_HOME/cage.env"
grep -qx 'CAGE_TELEGRAM_TOKEN_claude="100:GOODclaude"' "$env_file" || fail "claude token not saved: $(cat "$env_file")"
grep -qx 'CAGE_TELEGRAM_TOKEN_codex="200:GOODcodex"' "$env_file" || fail "codex token not saved"
grep -qx 'CAGE_TELEGRAM_ALLOW="4242"' "$env_file" || fail "allowlist not learned"
[ "$(grep -c '^CAGE_TELEGRAM_ALLOW=' "$env_file")" = 1 ] || fail "duplicate CAGE_TELEGRAM_ALLOW lines"
[ "$(stat -c %a "$env_file" 2>/dev/null || stat -f %Lp "$env_file")" = 600 ] || fail "env file not 0600"
grep -q 'not a bot token' "$T/setup.err" || fail "malformed token not reported"
grep -q 'rejected' "$T/setup.err" || fail "revoked token not reported"
grep -q '@dot_claude_bot' "$T/setup.err" || fail "bot username not shown"
grep -q 'Zack' "$T/setup.err" || fail "sender name not shown for confirmation"
grep -q '/bot100:GOODclaude/getUpdates?offset=501' "$T/requests.log" || fail "the id-discovery message was not acknowledged"
grep -qx 'CAGE_AGENTS="claude codex"' "$env_file" || fail "CAGE_AGENTS not narrowed to the agents set up: $(grep CAGE_AGENTS "$env_file")"
ok "setup validates tokens with Telegram, learns the user id, acknowledges the message, narrows CAGE_AGENTS"

# --- re-running keeps working tokens and the allowlist without prompting
: > "$T/requests.log"
cage setup claude codex </dev/null 2>"$T/setup2.err" || fail "second setup failed: $(cat "$T/setup2.err")"
grep -q 'keeping bot @dot_claude_bot' "$T/setup2.err" || fail "did not keep existing bot"
grep -q 'allowlist already set: 4242' "$T/setup2.err" || fail "did not keep allowlist"
grep -q getUpdates "$T/requests.log" && fail "polled for a user id although the allowlist was set"
ok "re-running setup keeps valid settings"

# --- adding one agent later keeps the earlier ones; doctor then checks exactly those
printf '%s\n' '300:GOODcursor' | cage setup cursor 2>/dev/null || fail "adding cursor failed"
grep -qx 'CAGE_AGENTS="claude codex cursor"' "$env_file" || fail "adding an agent dropped others: $(grep CAGE_AGENTS "$env_file")"
[ "$(grep -c '^CAGE_AGENTS=' "$env_file")" = 1 ] || fail "duplicate CAGE_AGENTS lines"
out="$(cage doctor 2>&1 || true)"
grep -q 'agents: claude codex cursor)' <<<"$out" || fail "doctor did not use the narrowed agent list: $out"
grep -q 'TOKEN_antigravity missing' <<<"$out" && fail "doctor checked an agent that was never set up: $out"
ok "setup <agent> adds to CAGE_AGENTS; doctor ignores agents without a bot"

# --- declining the sender aborts without saving
rm -f "$env_file"
if printf '%s\n' '100:GOODclaude' 'n' | cage setup claude 2>/dev/null; then fail "setup succeeded after the user declined"; fi
grep -q '^CAGE_TELEGRAM_ALLOW="4242"' "$env_file" && fail "saved an allowlist the user declined"
ok "declining the detected account saves nothing"

# --- doctor checks tokens live
printf 'CAGE_AGENTS="claude codex"\nCAGE_TELEGRAM_ALLOW="4242"\nCAGE_TELEGRAM_TOKEN_claude="100:GOODclaude"\nCAGE_TELEGRAM_TOKEN_codex="200:REVOKED"\n' >> "$env_file"
out="$(cage doctor 2>&1 || true)"
grep -q '✓ claude bot: @dot_claude_bot' <<<"$out" || fail "doctor: $out"
grep -q '✗ Telegram rejected .*CAGE_TELEGRAM_TOKEN_codex' <<<"$out" || fail "doctor did not flag the revoked token: $out"
ok "doctor verifies each bot token with Telegram"

# --- autostart (stubbed OS tools)
mkdir -p "$T/bin"
for tool in launchctl systemctl; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/os.log"\n' "$tool" "$T" > "$T/bin/$tool"
  chmod +x "$T/bin/$tool"
done
printf '#!/bin/sh\necho "$FAKE_UNAME"\n' > "$T/bin/uname"; chmod +x "$T/bin/uname"

PATH="$T/bin:$PATH" FAKE_UNAME=Darwin cage autostart on 2>/dev/null
plist="$HOME/Library/LaunchAgents/dev.cage.up.plist"
python3 - "$plist" "$ROOT/cage" "$CAGE_HOME" <<'PY' || fail "bad LaunchAgent plist"
import plistlib, sys
p = plistlib.load(open(sys.argv[1], "rb"))
assert p["Label"] == "dev.cage.up"
assert p["ProgramArguments"] == [sys.argv[2], "up"], p["ProgramArguments"]
assert p["RunAtLoad"] is True
assert p["EnvironmentVariables"]["CAGE_HOME"] == sys.argv[3]
assert "/opt/homebrew/bin" in p["EnvironmentVariables"]["PATH"]
PY
grep -q "launchctl bootstrap gui/$(id -u) $plist" "$T/os.log" || fail "LaunchAgent not bootstrapped: $(cat "$T/os.log")"
PATH="$T/bin:$PATH" FAKE_UNAME=Darwin cage autostart off 2>/dev/null
[ ! -e "$plist" ] || fail "plist not removed"
ok "autostart on/off installs and removes a valid macOS LaunchAgent"

PATH="$T/bin:$PATH" FAKE_UNAME=Linux cage autostart on 2>/dev/null
unit="$HOME/.config/systemd/user/cage-up.service"
grep -qx "ExecStart=\"$ROOT/cage\" up" "$unit" || fail "unit ExecStart: $(cat "$unit")"
grep -qx 'WantedBy=default.target' "$unit" || fail "unit WantedBy"
grep -q 'systemctl --user enable cage-up.service' "$T/os.log" || fail "unit not enabled"
PATH="$T/bin:$PATH" FAKE_UNAME=Linux cage autostart off 2>/dev/null
[ ! -e "$unit" ] || fail "unit not removed"
ok "autostart on/off installs and removes a systemd user unit"

echo "all $pass setup tests passed"
