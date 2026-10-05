#!/usr/bin/env bash
# Tests host/mcp_oauth.py (browser sign-in to remote MCP servers) against a mock MCP server and authorization
# server (python3): discovery, dynamic client registration, PKCE, the localhost callback, refresh and rotation.
# A stand-in "browser" follows the sign-in link with curl. No network.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
MOCK_PID=""
trap '{ [ -n "$MOCK_PID" ] && kill "$MOCK_PID"; pkill -f -- "$ROOT/cage _refresh"; } 2>/dev/null || true; rm -rf "$T"' EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }
unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy

cat > "$T/mock.py" <<'PY'
import base64, hashlib, http.server, json, sys, urllib.parse
port = None; codes = {}; refresh = {"rt-1": 1}; clients = {}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def j(self, code, body, headers=()):
        data = json.dumps(body).encode(); self.send_response(code)
        for k, v in headers: self.send_header(k, v)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)
    def body(self): return self.rfile.read(int(self.headers.get("Content-Length", 0)))
    def do_GET(self):
        u = urllib.parse.urlsplit(self.path); q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        base = f"https://127.0.0.1:{port}"
        if u.path == "/.well-known/oauth-protected-resource/mcp":
            return self.j(200, {"resource": f"{base}/mcp", "authorization_servers": [base]})
        # hostile sign-in servers, each behind its own MCP address /<name>/mcp
        if u.path.startswith("/.well-known/oauth-protected-resource/") and u.path.endswith("/mcp"):
            name = u.path.split("/")[3]
            issuer = f"http://127.0.0.1:{port}" if name == "http-issuer" else f"{base}/{name}"
            return self.j(200, {"resource": f"{base}/{name}/mcp", "authorization_servers": [issuer]})
        if u.path.startswith("/.well-known/oauth-authorization-server/"):
            name = u.path.split("/")[3]
            auth = {"http": f"http://127.0.0.1:{port}/authorize", "quote": f"{base}/authorize\u2019; calc; \u2018",
                    "deny": f"{base}/authorize-deny"}[name]
            return self.j(200, {"issuer": f"{base}/{name}", "authorization_endpoint": auth, "token_endpoint": f"{base}/token",
                                "registration_endpoint": f"{base}/register"})
        if u.path == "/authorize-deny":   # the server says no, with HTML and terminal codes (OSC 52: your clipboard) in its words
            self.send_response(302); self.send_header("Location", q["redirect_uri"] + "?" + urllib.parse.urlencode(
                {"error": "access_denied", "error_description": "<img src=x onerror=alert(1)>no\x1b]52;c;cHduZWQ=\x07\x1b[2J", "state": q["state"]}))
            self.send_header("Content-Length", "0"); self.end_headers(); return
        if u.path == "/.well-known/oauth-authorization-server":
            return self.j(200, {"issuer": base, "authorization_endpoint": f"{base}/authorize", "token_endpoint": f"{base}/token",
                                "registration_endpoint": f"{base}/register", "scopes_supported": ["read", "offline_access"],
                                "code_challenge_methods_supported": ["S256"]})
        if u.path == "/authorize":
            assert q["client_id"] in clients and q["redirect_uri"] in clients[q["client_id"]], q
            assert q["code_challenge_method"] == "S256" and q["resource"] == f"{base}/mcp" and q["scope"] == "read offline_access", q
            codes["code-1"] = (q["code_challenge"], q["redirect_uri"])
            self.send_response(302); self.send_header("Location", f"{q['redirect_uri']}?code=code-1&state={q['state']}")
            self.send_header("Content-Length", "0"); self.end_headers(); return
        self.j(404, {})
    def do_POST(self):
        u = urllib.parse.urlsplit(self.path); b = self.body()
        if u.path == "/mcp":
            if self.headers.get("Authorization", "").startswith("Bearer at-"):
                return self.j(200, {"jsonrpc": "2.0", "id": 1, "result": {"serverInfo": {"name": "mock"}}})
            return self.j(401, {"error": "unauthorized"}, [("WWW-Authenticate", f'Bearer resource_metadata="https://127.0.0.1:{port}/.well-known/oauth-protected-resource/mcp"')])
        if u.path.endswith("/mcp") and u.path.count("/") == 2:   # /<name>/mcp: a hostile one (above)
            return self.j(401, {"error": "unauthorized"}, [("WWW-Authenticate", f'Bearer resource_metadata="https://127.0.0.1:{port}/.well-known/oauth-protected-resource{u.path}"')])
        if u.path == "/open":   # an MCP server that needs no sign-in
            return self.j(200, {"jsonrpc": "2.0", "id": 1, "result": {"serverInfo": {"name": "open"}}})
        if u.path == "/register":
            r = json.loads(b); assert r["token_endpoint_auth_method"] == "none" and r["redirect_uris"][0].startswith("http://localhost:")
            clients["cid-1"] = r["redirect_uris"]; return self.j(201, {"client_id": "cid-1"})
        if u.path == "/token":
            f = {k: v[0] for k, v in urllib.parse.parse_qs(b.decode()).items()}
            if f["grant_type"] == "authorization_code":
                challenge, redirect = codes.pop(f["code"])
                verified = base64.urlsafe_b64encode(hashlib.sha256(f["code_verifier"].encode()).digest()).rstrip(b"=").decode()
                if verified != challenge or f["redirect_uri"] != redirect: return self.j(400, {"error": "invalid_grant"})
                refresh.clear(); refresh["rt-1"] = 1   # a new sign-in starts a new chain
                return self.j(200, {"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600, "token_type": "bearer"})
            if f["grant_type"] == "refresh_token":
                n = refresh.pop(f["refresh_token"], None)   # rotation: each refresh token works once
                if n is None: return self.j(400, {"error": "invalid_grant", "error_description": "refresh token revoked"})
                refresh[f"rt-{n + 1}"] = n + 1
                return self.j(200, {"access_token": f"at-{n + 1}", "refresh_token": f"rt-{n + 1}", "expires_in": 3600})
        self.j(404, {})
import ssl
s = http.server.HTTPServer(("127.0.0.1", 0), H); port = s.server_port
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(sys.argv[2], sys.argv[3])
s.socket = ctx.wrap_socket(s.socket, server_side=True)
open(sys.argv[1], "w").write(str(port)); s.serve_forever()
PY
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/key.pem" -out "$T/cert.pem" -days 1 -subj /CN=127.0.0.1 \
  -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1 || fail "openssl"
export SSL_CERT_FILE="$T/cert.pem"
python3 "$T/mock.py" "$T/port" "$T/cert.pem" "$T/key.pem" &
MOCK_PID=$!
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
port="$(cat "$T/port")"
# the stand-in browser: follows the sign-in link and its redirect back to cage's localhost page
printf '#!/bin/sh\ncurl -sS -L --cacert "%s/cert.pem" -o "%s/page.html" "$1"\n' "$T" "$T" > "$T/browser"; chmod +x "$T/browser"

S="$T/state.json" K="$T/token"
CAGE_OPEN="$T/browser" python3 "$ROOT/host/mcp_oauth.py" login "$S" "https://127.0.0.1:$port/mcp" "$K" </dev/null 2>"$T/login.err" \
  || fail "login: $(cat "$T/login.err")"
[ "$(cat "$K")" = at-1 ] || fail "access token: $(cat "$K")"
[ "$(stat -c %a "$S")" = 600 ] && [ "$(stat -c %a "$K")" = 600 ] || fail "sign-in files aren't 0600"
python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); assert s["refresh_token"]=="rt-1" and s["client"]["client_id"]=="cid-1" and s["resource"].endswith("/mcp"), s' "$S" || fail "state: $(cat "$S")"
grep -q 'Signed in' "$T/page.html" || fail "the browser didn't land on cage's page: $(cat "$T/page.html")"
ok "login: discovery from the 401, dynamic registration, PKCE, localhost callback; tokens kept 0600"

rc=0; python3 "$ROOT/host/mcp_oauth.py" refresh "$S" "$K" 900 2>/dev/null || rc=$?
[ $rc = 3 ] && [ "$(cat "$K")" = at-1 ] || fail "a fresh token was refreshed (rc $rc)"
python3 "$ROOT/host/mcp_oauth.py" refresh "$S" "$K" 999999 2>/dev/null || fail "refresh"
[ "$(cat "$K")" = at-2 ] || fail "refreshed token: $(cat "$K")"
python3 "$ROOT/host/mcp_oauth.py" refresh "$S" "$K" 999999 2>/dev/null || fail "second refresh (rotated refresh token not kept?)"
[ "$(cat "$K")" = at-3 ] || fail "second refresh: $(cat "$K")"
ok "refresh: only when about to expire, and the rotated refresh token is kept"

python3 - "$S" <<'PY'
import json, sys; s = json.load(open(sys.argv[1])); s["refresh_token"] = "rt-revoked"; s["expires_at"] = 0; json.dump(s, open(sys.argv[1], "w"))
PY
if python3 "$ROOT/host/mcp_oauth.py" refresh "$S" "$K" 2>"$T/r.err"; then fail "a revoked sign-in refreshed"; fi
grep -q 'refresh token revoked' "$T/r.err" || fail "unclear error: $(cat "$T/r.err")"
ok "a revoked sign-in fails clearly"
# hostile sign-in servers: anything but a plain https address is never opened or sent anything, and the server's
# words on cage's own page are text, not HTML
printf '#!/bin/sh\ntouch "%s/opened"\n' "$T" > "$T/no-browser"; chmod +x "$T/no-browser"
for name in http quote http-issuer; do
  rm -f "$T/opened"
  if CAGE_OPEN="$T/no-browser" python3 "$ROOT/host/mcp_oauth.py" login "$T/evil.json" "https://127.0.0.1:$port/$name/mcp" "$T/evil.token" \
       </dev/null 2>"$T/evil.err"; then fail "signed in through a hostile server ($name)"; fi
  [ ! -e "$T/opened" ] || fail "opened a sign-in link that isn't plain https ($name): $(cat "$T/evil.err")"
  grep -q "https address" "$T/evil.err" || fail "unclear refusal ($name): $(cat "$T/evil.err")"
  if LC_ALL=C grep -q $'\xe2\x80' "$T/evil.err"; then fail "the server's odd characters reached the terminal: $(cat "$T/evil.err")"; fi
done
rm -f "$T/page.html"
if CAGE_OPEN="$T/browser" python3 "$ROOT/host/mcp_oauth.py" login "$T/evil.json" "https://127.0.0.1:$port/deny/mcp" "$T/evil.token" \
     </dev/null 2>"$T/evil.err"; then fail "a refused sign-in counted as signed in"; fi
grep -q 'sign-in refused: <img src=x onerror=alert(1)>no]52;c;cHduZWQ=\[2J$' "$T/evil.err" || fail "refusal: $(cat -v "$T/evil.err")"
if LC_ALL=C grep -q $'\e' "$T/evil.err"; then fail "the server's terminal codes reached the terminal: $(cat -v "$T/evil.err")"; fi
grep -qF '&lt;img src=x onerror=alert(1)&gt;no' "$T/page.html" && ! grep -q '<img' "$T/page.html" || fail "the error page ran the server's HTML: $(cat "$T/page.html")"
ok "hostile sign-in servers: only plain https addresses are opened or contacted; their words are shown as text, without codes"

# --- through cage: `cage connect add NAME URL` notices the sign-in, keeps the token as a secret, renews it on `up`
# and swaps the renewed token into running VMs (msb modify), without a restart
mkdir -p "$T/bin"
cat > "$T/bin/msb" <<'SH'
#!/usr/bin/env bash
cmd="$1"; { printf '%s' "$1"; shift; for a in "$@"; do printf ' | %s' "$a"; done; echo; } >> "$MSB_LOG"
env | grep -E '^MOCK_MCP_TOKEN=' >> "$MSB_LOG" || true
if [ "$cmd" = ps ] && [ "${MSB_PS:-}" = 1 ]; then printf 'cage-claude\n'; fi
exit 0
SH
chmod +x "$T/bin/msb"
export PATH="$T/bin:$PATH" CAGE_HOME="$T/home" MSB_LOG="$T/msb.log" CAGE_OPEN="$T/browser"
: > "$MSB_LOG"
"$ROOT/cage" init 2>/dev/null
printf 'CAGE_AGENTS="claude"\nCAGE_TELEGRAM_ALLOW="1"\nCAGE_TELEGRAM_TOKEN_claude="1:AAA"\n' >> "$CAGE_HOME/cage.env"
printf '\n' | "$ROOT/cage" connect add mock "https://127.0.0.1:$port/mcp" 2>"$T/c.err" || fail "connect add with sign-in: $(cat "$T/c.err")"
grep -q 'your sign-in stays on this computer' "$T/c.err" || fail "no sign-in: $(cat "$T/c.err")"
[ "$(cat "$CAGE_HOME/secrets/MOCK_MCP_TOKEN")" = at-1 ] && grep -qx 'oauth=mock' "$CAGE_HOME/secrets/MOCK_MCP_TOKEN.conf" \
  || fail "token not kept as the connector's secret"
[ "$(stat -c %a "$CAGE_HOME/oauth/mock.json")" = 600 ] || fail "sign-in state not 0600"
printf '\n' | "$ROOT/cage" connect add plain "https://127.0.0.1:$port/open" 2>/dev/null || fail "connect add without sign-in"
grep -qx 'secret=' "$CAGE_HOME/connectors/plain.conf" || fail "a server without sign-in got a secret"
ok "cage connect add: signs in when the server asks for it, keeps the token as a secret, and skips it when not"

python3 -c 'import json,sys; p=sys.argv[1]; s=json.load(open(p)); s["expires_at"]=0; json.dump(s, open(p, "w"))' "$CAGE_HOME/oauth/mock.json"
MSB_PS=1 "$ROOT/cage" up claude 2>/dev/null || fail "up"
pkill -f -- "$ROOT/cage _refresh" 2>/dev/null || true
[ "$(cat "$CAGE_HOME/secrets/MOCK_MCP_TOKEN")" = at-2 ] || fail "up didn't renew an expiring sign-in"
grep -q "^modify | cage-claude | --secret | MOCK_MCP_TOKEN@127.0.0.1$" "$MSB_LOG" || fail "renewed token not swapped into the running VM: $(cat "$MSB_LOG")"
grep -qx 'MOCK_MCP_TOKEN=at-2' "$MSB_LOG" || fail "msb modify didn't get the new token in its environment"
if grep -q 'rt-' "$CAGE_HOME/agents/claude/"* "$CAGE_HOME/msb/claude.yaml"; then fail "the refresh token reached something the VM sees"; fi
grep -A1 -x '  MOCK_MCP_TOKEN:' "$CAGE_HOME/msb/claude.yaml" | grep -qxF '    value: "${MOCK_MCP_TOKEN}"' || fail "token not passed to the VM as a secret"
"$ROOT/cage" connect rm mock 2>/dev/null
[ ! -e "$CAGE_HOME/oauth/mock.json" ] && [ ! -e "$CAGE_HOME/secrets/MOCK_MCP_TOKEN" ] || fail "rm left the sign-in behind"
ok "cage up renews sign-ins that are about to expire and swaps them into running VMs; rm forgets them"
echo "all $pass oauth tests passed"
