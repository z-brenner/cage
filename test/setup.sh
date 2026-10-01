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
OWNER = {"id": 4242, "is_bot": False, "first_name": "Zack"}
MANAGED = [{"update_id": 900 + i, "managed_bot": {"user": OWNER, "bot": {"id": bid, "is_bot": True, "first_name": n, "username": u}}}
           for i, (bid, n, u) in enumerate([(1001, "Claude", "dot_claude_bot"), (1002, "Codex", "dot_codex_bot")])]
DISCORD_APP = {"id": "777", "name": "Codex", "flags": 0, "owner": {"id": "4242", "username": "zack"}, "bot_public": True}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def auth(self): return self.headers.get("Authorization", "")
    def slack(self, body):  # Slack Web API: xoxb-GOOD… / xapp-GOOD… work; two people have emails
        method = self.path.split("/")[2].split("?")[0]
        log.write("slack " + method + " " + self.auth() + "\n"); log.flush()
        if method == "auth.test":
            ok = self.auth().startswith("Bearer xoxb-GOOD")
            return self.reply(200, {"ok": True, "team": "Acme", "user_id": "UBOT"} if ok else {"ok": False, "error": "invalid_auth"})
        if method == "apps.connections.open":
            ok = self.auth().startswith("Bearer xapp-GOOD")
            return self.reply(200, {"ok": True, "url": "wss://x"} if ok else {"ok": False, "error": "invalid_auth"})
        if method == "users.lookupByEmail":
            uid = {"zack%40acme.com": "U0ZACK", "amy%40acme.com": "U0AMY"}.get(self.path.split("email=")[-1])
            return self.reply(200, {"ok": True, "user": {"id": uid, "name": "x"}} if uid else {"ok": False, "error": "users_not_found"})
        self.reply(404, {"ok": False})
    def discord(self, body):  # Discord REST: tokens with GOOD in them work; replies spaced like Discord's
        path = self.path[len("/discord"):]
        log.write("discord " + self.command + " " + path + " " + body.decode()[:40] + "\n"); log.flush()
        if "GOOD" not in self.auth():
            return self.reply(401, {"message": "401: Unauthorized", "code": 0}, spaced=True)
        if path == "/applications/@me" and self.command == "PATCH":
            DISCORD_APP["flags"] = json.loads(body)["flags"]
        if path == "/applications/@me":
            return self.reply(200, DISCORD_APP, spaced=True)
        if path == "/users/@me/guilds":
            return self.reply(200, [{"id": "55", "name": "Zack's server"}], spaced=True)
        if path == "/users/@me":
            return self.reply(200, {"id": "777", "username": "Codex"}, spaced=True)
        self.reply(404, {"message": "404"}, spaced=True)
    def do_PATCH(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/discord/users/@me":
            log.write("discord avatar " + ("ok" if b'"data:image/jpeg;base64,/9j/' in body else "bad") + "\n"); log.flush()
            return self.reply(200, {"id": "777"}, spaced=True)
        return self.discord(body)
    def do_POST(self):  # setMyProfilePhoto: multipart upload
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path.startswith("/slack/"): return self.slack(body)
        ok = b'attach://avatar' in body and b'name="avatar"' in body and b'\xff\xd8' in body
        log.write(self.path + (" photo-ok\n" if ok else " photo-bad\n")); log.flush()
        self.reply(200 if ok else 400, {"ok": ok})
    def do_GET(self):
        if self.path.startswith("/slack/"): return self.slack(b"")
        if self.path.startswith("/discord/"): return self.discord(b"")
        log.write(self.path + "\n"); log.flush()
        m = re.match(r"^/bot([^/]+)/(\w+)", self.path)
        token, method = m.group(1), m.group(2)
        if ":GOOD" not in token:
            return self.reply(401, {"ok": False, "error_code": 401, "description": "Unauthorized"})
        if method == "getMe":
            name = token.split(":GOOD")[1] or "x"
            return self.reply(200, {"ok": True, "result": {"id": 1, "is_bot": True, "first_name": "Dot", "username": "dot_" + name + "_bot",
                                                           "can_manage_bots": name == "mgr"}})
        if method == "getUpdates" and "allowed_updates" in self.path:  # the manager bot: one managed_bot update per tap
            offset = int((re.search(r"offset=(\d+)", self.path) or [0, 0])[1])
            pending = [u for u in MANAGED if u["update_id"] >= offset]
            return self.reply(200, {"ok": True, "result": pending[:1]})
        if method == "getManagedBotToken":
            uid = re.search(r"user_id=(\d+)", self.path).group(1)
            return self.reply(200, {"ok": True, "result": {"1001": "1001:GOODclaude", "1002": "1002:GOODcodex"}[uid]})
        if method == "setManagedBotAccessSettings":
            return self.reply(200, {"ok": True, "result": True})
        if method in ("setMyDescription", "setMyShortDescription"):
            return self.reply(200, {"ok": True, "result": True})
        if method == "getUpdates":
            if "offset=" in self.path:
                return self.reply(200, {"ok": True, "result": []})
            return self.reply(200, {"ok": True, "result": [{"update_id": 500, "message": {"message_id": 7,
                "from": {"id": 4242, "is_bot": False, "first_name": "Zack", "username": "zack"},
                "chat": {"id": 4242, "type": "private"}, "date": 0, "text": "hi"}}]})
        self.reply(404, {"ok": False})
    def reply(self, code, body, spaced=False):
        data = json.dumps(body, separators=(", ", ": ") if spaced else (",", ":")).encode()
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
export CAGE_SLACK_API="http://127.0.0.1:$port/slack" CAGE_DISCORD_API="http://127.0.0.1:$port/discord"
unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy
unset WSL_DISTRO_NAME WSL_INTEROP   # never touch a real Windows host when the tests run inside WSL
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
grep -qx 'CAGE_TELEGRAM_BOT_claude="dot_claude_bot"' "$env_file" || fail "bot username not remembered"
ok "setup validates tokens with Telegram, learns the user id, acknowledges the message, narrows CAGE_AGENTS"
grep -q '^/bot100:GOODclaude/setMyProfilePhoto photo-ok$' "$T/requests.log" || fail "claude bot got no avatar: $(cat "$T/requests.log")"
grep -q '^/bot200:GOODcodex/setMyProfilePhoto photo-ok$' "$T/requests.log" || fail "codex bot got no avatar"
grep -qE '^/bot100:GOODclaude/setMyDescription[?]description=.*Claude(%20|[+])Code' "$T/requests.log" || fail "no description: $(cat "$T/requests.log")"
grep -q '^/bot100:GOODclaude/setMyShortDescription?short_description=' "$T/requests.log" || fail "no short description"
grep -q 'gave it a face and a hello' "$T/setup.err" || fail "setup did not say it dressed the bots"
ok "new bots get the agent's avatar, a description and a short description"

# --- re-running keeps working tokens and the allowlist without prompting
: > "$T/requests.log"
cage setup claude codex </dev/null 2>"$T/setup2.err" || fail "second setup failed: $(cat "$T/setup2.err")"
grep -q 'keeping bot @dot_claude_bot' "$T/setup2.err" || fail "did not keep existing bot"
grep -q 'allowlist already set: 4242' "$T/setup2.err" || fail "did not keep allowlist"
grep -q getUpdates "$T/requests.log" && fail "polled for a user id although the allowlist was set"
grep -q setMy "$T/requests.log" && fail "re-dressed bots that were already set up"
ok "re-running setup keeps valid settings and leaves existing bots alone"

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
for tool in launchctl systemctl reg.exe powershell.exe; do
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

# --- Windows (WSL 2): autostart is the per-user Run key (no admin); doctor explains WSL-specific KVM problems
: > "$T/os.log"
PATH="$T/bin:$PATH" FAKE_UNAME=Linux WSL_DISTRO_NAME=Ubuntu-24.04 cage autostart on 2>/dev/null
grep -qxF "reg.exe add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v cage /t REG_SZ /d wsl.exe -d Ubuntu-24.04 -u $(id -un) --exec $ROOT/cage _autostart /f" "$T/os.log" \
  || fail "Run key: $(cat "$T/os.log")"
[ ! -e "$HOME/.config/systemd/user/cage-up.service" ] || fail "wrote a systemd unit on WSL"
PATH="$T/bin:$PATH" FAKE_UNAME=Linux WSL_DISTRO_NAME=Ubuntu-24.04 cage autostart off 2>/dev/null
grep -qxF 'reg.exe delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v cage /f' "$T/os.log" || fail "Run key not removed: $(cat "$T/os.log")"
out="$(PATH="$T/bin:$PATH" FAKE_UNAME=Linux WSL_DISTRO_NAME=Ubuntu-24.04 cage doctor 2>&1 || true)"
grep -q '✓ WSL distro Ubuntu-24.04 with Windows interop' <<<"$out" || fail "doctor WSL line: $out"
grep -qE 'KVM is ready|no /dev/kvm in WSL: cage needs WSL 2 on Windows 11|wsl --terminate Ubuntu-24.04' <<<"$out" || fail "doctor WSL KVM hint: $out"
ok "on WSL, autostart uses the per-user Run key and doctor gives WSL-specific hints"

# --- managed bots: one manager bot, one tap per agent; the creator becomes the allowlist and each bot is locked
rm -f "$env_file"; : > "$T/requests.log"
printf '%s\n' '555:GOODmgr' | CAGE_BOTS=managed cage setup claude codex 2>"$T/m.err" || fail "managed setup failed: $(cat "$T/m.err")"
grep -qx 'CAGE_TELEGRAM_MANAGER_TOKEN="555:GOODmgr"' "$env_file" || fail "manager token not saved"
grep -qx 'CAGE_TELEGRAM_TOKEN_claude="1001:GOODclaude"' "$env_file" || fail "claude token not fetched: $(cat "$T/m.err")"
grep -qx 'CAGE_TELEGRAM_TOKEN_codex="1002:GOODcodex"' "$env_file" || fail "codex token not fetched"
grep -qx 'CAGE_TELEGRAM_ALLOW="4242"' "$env_file" || fail "the bots' creator did not become the allowlist"
grep -q 't.me/newbot/dot_mgr_bot/dot_mgr_claude_bot?name=Claude' "$T/m.err" || fail "no creation link: $(cat "$T/m.err")"
for id in 1001 1002; do
  grep -q "/bot555:GOODmgr/setManagedBotAccessSettings?user_id=$id&is_access_restricted=true" "$T/requests.log" || fail "bot $id not locked to its owner"
done
grep -q 'GOODclaude/getUpdates' "$T/requests.log" && fail "waited for a message although the creator is known"
grep -q '^/bot1001:GOODclaude/setMyProfilePhoto photo-ok$' "$T/requests.log" || fail "managed bot got no avatar"
grep -q 'locked to Zack' "$T/m.err" || fail "setup didn't say the bots are locked: $(cat "$T/m.err")"
ok "managed bots: one manager, one tap per agent, tokens fetched, creator allowlisted, bots locked to them"

# --- Slack and Discord: the same agent, reachable from more places; owner-only unless the user opens it up
printf '%s\n' 'not-a-token' 'xoxb-REVOKED-1234567890' 'xoxb-GOOD-1234567890' 'xapp-GOOD-1234567890' 'nobody@acme.com' 'zack@acme.com' \
  | cage chat add slack claude 2>"$T/slack.err" || fail "chat add slack failed: $(cat "$T/slack.err")"
grep -q 'api.slack.com/apps?new_app=1&manifest_json=%7B%22display_information' "$T/slack.err" || fail "no prefilled Slack app link: $(cat "$T/slack.err")"
grep -q 'socket_mode_enabled%22%3Atrue' "$T/slack.err" || fail "the Slack app doesn't use Socket Mode"
grep -q 'messages_tab_enabled%22%3Atrue' "$T/slack.err" || fail "people couldn't DM the Slack app"
for want in 'CAGE_SLACK_BOT_TOKEN_claude="xoxb-GOOD-1234567890"' 'CAGE_SLACK_APP_TOKEN_claude="xapp-GOOD-1234567890"' \
            'CAGE_SLACK_OWNER_claude="U0ZACK"' 'CAGE_SLACK_ALLOW_claude="U0ZACK"' 'CAGE_SLACK_TEAM_claude="Acme"'; do
  grep -qxF "$want" "$env_file" || fail "missing $want: $(grep SLACK "$env_file")"
done
grep -q "not a bot token" "$T/slack.err" && grep -q "invalid_auth" "$T/slack.err" && grep -q "no one in Acme" "$T/slack.err" \
  || fail "bad tokens or an unknown email weren't explained: $(cat "$T/slack.err")"
grep -q 'xoxb-GOOD' "$T/slack.err" && fail "a token was echoed"
printf '%s\n' 'nope' 'AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.REVOKEDxxxxxxxxxxxxxxxxxxxxxxx' 'MTAwMDAwMDAwMDAwMDAwMDAw.GOODxx.cccccccccccccccccccccccccccc' \
  | cage chat add discord codex 2>"$T/discord.err" || fail "chat add discord failed: $(cat "$T/discord.err")"
grep -q 'discord PATCH /applications/@me {"flags": 524288}' "$T/requests.log" || fail "Message Content intent not switched on: $(grep discord "$T/requests.log")"
grep -q 'discord avatar ok' "$T/requests.log" || fail "the Discord bot got no face"
grep -q 'discord.com/oauth2/authorize?client_id=777&scope=bot&permissions=' "$T/discord.err" || fail "no invite link: $(cat "$T/discord.err")"
grep -q "joined Zack's server" "$T/discord.err" || fail "didn't notice it joined a server"
grep -qxF 'CAGE_DISCORD_OWNER_codex="4242"' "$env_file" && grep -qxF 'CAGE_DISCORD_ALLOW_codex="4242"' "$env_file" || fail "discord owner/allowlist"
out="$(cage chat 2>&1)"
grep -q 'claude .*Telegram @dot_claude_bot · Slack (Acme)' <<<"$out" && grep -q 'codex .*Discord' <<<"$out" || fail "chat list: $out"
mkdir -p "$T/msbbin"; printf '#!/bin/sh\necho "$*" >> "%s/msb.log"\n[ "$1" = inspect ] && exit 1\nexit 0\n' "$T" > "$T/msbbin/msb"; chmod +x "$T/msbbin/msb"
printf 'k\n' | cage secret add MY_KEY api.example.com claude codex 2>/dev/null
PATH="$T/msbbin:$PATH" cage up claude codex 2>/dev/null
cl="$CAGE_HOME/agents/claude/cc-connect.toml" cx="$CAGE_HOME/agents/codex/cc-connect.toml"
grep -q '^type = "slack"$' "$cl" && grep -q '^type = "telegram"$' "$cl" || fail "claude config lacks a platform: $(cat "$cl")"
grep -qx 'allow_from = "U0ZACK"' "$cl" && grep -qx 'admin_from = "you,4242,U0ZACK"' "$cl" || fail "claude slack allowlist/admins: $(cat "$cl")"
grep -q '^type = "discord"$' "$cx" && grep -qx 'allow_from = "4242"' "$cx" || fail "codex discord: $(cat "$cx")"
grep -q 'type = "slack"' "$cx" && fail "codex got claude's Slack"
grep -q 'cage-claude .*--conf' "$T/msb.log" || fail "claude's secrets config isn't used: $(cat "$T/msb.log")"
grep -q '^    bypass: .*"\*.slack.com"' "$CAGE_HOME/msb/claude.yaml" || fail "Slack traffic would be intercepted: $(cat "$CAGE_HOME/msb/claude.yaml")"
grep -q '^    bypass: .*"\*.discord.gg"' "$CAGE_HOME/msb/codex.yaml" || fail "Discord traffic would be intercepted"
cage chat rm slack claude 2>/dev/null || fail "chat rm"
grep -q 'CAGE_SLACK_' "$env_file" && fail "Slack settings left behind: $(grep SLACK "$env_file")"
ok "chat: Slack (prefilled app, Socket Mode) and Discord (intent switched on, invite link) join a VM's bot, owner-only"

# --- WhatsApp: on top of another chat app; a spare number (only the owner's phone) or the owner's own number
if printf 'spare\n+15552223333\n' | cage chat add whatsapp cursor 2>/dev/null; then fail "WhatsApp was added to an agent nobody can reach otherwise"; fi
printf '%s\n' 'maybe' 'spare' '12' '+1 (555) 222-3333' | cage chat add whatsapp claude 2>"$T/wa.err" || fail "chat add whatsapp: $(cat "$T/wa.err")"
grep -qxF 'CAGE_WHATSAPP_MODE_claude="spare"' "$env_file" && grep -qxF 'CAGE_WHATSAPP_ALLOW_claude="15552223333"' "$env_file" \
  || fail "whatsapp settings: $(grep WHATSAPP "$env_file")"
grep -qE '^CAGE_WHATSAPP_TOKEN_claude="[a-f0-9]{32}"$' "$env_file" || fail "no bridge token"
grep -q 'banned numbers' "$T/wa.err" || fail "no warning about WhatsApp's rules"
grep -q 'cage chat link whatsapp claude' "$T/wa.err" || fail "no next step without a terminal"
printf '%s\n' 'mine' 'y' | cage chat add whatsapp codex 2>/dev/null || fail "own-number whatsapp"
PATH="$T/msbbin:$PATH" cage up claude codex 2>/dev/null
grep -qx '\[bridge\]' "$cl" && grep -qx 'enabled = true' "$cl" || fail "no bridge in claude's config: $(cat "$cl")"
grep -qx 'admin_from = "you,4242,15552223333"' "$cl" || fail "whatsapp owner isn't an admin: $(grep admin_from "$cl")"
w="$CAGE_HOME/agents/claude/whatsapp.env"
[ "$(stat -c %a "$w")" = 600 ] && grep -qx 'WA_MODE=spare' "$w" && grep -qx 'WA_ALLOW=15552223333' "$w" && grep -qx 'WA_NAME=Claude' "$w" || fail "whatsapp.env: $(cat "$w")"
grep -qx 'WA_MODE=own' "$CAGE_HOME/agents/codex/whatsapp.env" && grep -q 'admin_from = "you,4242,me"' "$cx" || fail "own-number mode: $(grep admin_from "$cx")"
grep -q '^    bypass: .*"\*.whatsapp.net"' "$CAGE_HOME/msb/claude.yaml" || fail "WhatsApp traffic would be intercepted"
out="$(cage chat 2>&1)"; grep -q 'codex .*WhatsApp (your own number)' <<<"$out" || fail "chat list: $out"
cage chat rm whatsapp codex 2>/dev/null && PATH="$T/msbbin:$PATH" cage up codex 2>/dev/null
[ ! -e "$CAGE_HOME/agents/codex/whatsapp.env" ] && grep -qx '\[bridge\]' "$cx" || fail "whatsapp not removed (or the app's bridge went with it)"
ok "whatsapp: spare or own number, owner-only, bridge and adapter settings for the VM, removable"

echo "all $pass setup tests passed"
