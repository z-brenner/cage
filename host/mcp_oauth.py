#!/usr/bin/env python3
"""Signs in to a remote MCP server that only offers browser sign-in (OAuth 2.1), on the user's own computer.

The standard MCP way (what Claude, ChatGPT and Cursor do): discover the authorization server from the MCP
server (RFC 9728, RFC 8414), register cage as a client (RFC 7591), and sign in with PKCE through the browser,
back to a one-off page on localhost. The refresh token stays here, in a 0600 file under ~/.cage/oauth. Only the
short-lived access token is handed on, as a microsandbox secret, so the VMs see a placeholder for it.

  mcp_oauth.py login   <state.json> <mcp url> <token out>   sign in; write the state and the access token
                                                            (exit 4: no sign-in needed; 5: server unreachable)
  mcp_oauth.py refresh <state.json> <token out> [seconds]   new access token if it expires within [seconds]
                                                            (default 900): exit 0 refreshed, 3 still fresh
Standard library only. CAGE_OPEN is the command that opens a URL in the user's browser.
"""
import base64, hashlib, html, http.server, json, os, secrets, select, shlex, subprocess, sys, threading, time, unicodedata
import urllib.error, urllib.parse, urllib.request

UA = "cage (+https://github.com/z-brenner/cage)"


def say(msg):
    print(msg, file=sys.stderr, flush=True)


def plain(text, n=300):
    """The sign-in server's own words, for the terminal: text only, without control or format characters (an escape
    sequence there could set your clipboard or redraw the screen)."""
    return "".join(c for c in str(text or "") if unicodedata.category(c) not in ("Cc", "Cf"))[:n]


def url_ok(url):
    """A plain https address: visible ASCII, no quotes or backslashes. The sign-in server names its own addresses,
    and cage opens one of them in the browser (on Windows through PowerShell) and sends the sign-in to others."""
    if not isinstance(url, str) or not url or not all(33 <= ord(c) < 127 for c in url) or any(c in url for c in "'\"`\\"):
        return False
    try:
        u = urllib.parse.urlsplit(url)
        return u.scheme == "https" and bool(u.hostname) and (u.port is None or u.port > 0)
    except ValueError:
        return False


class HttpsRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to another plain https address."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not url_ok(newurl):
            raise urllib.error.HTTPError(newurl, code, f"redirect to {ascii(newurl)} refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(HttpsRedirects)


def fetch(url, data=None, headers=None, method=None):
    """Returns (status, headers, body) without raising on HTTP errors."""
    if not url_ok(url):
        raise SystemExit(f"cage won't contact {ascii(url)}: it isn't a plain https address")
    h = {"User-Agent": UA, "Accept": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with OPENER.open(req, timeout=30) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def get_json(url):
    if not url_ok(url):  # metadata at an address cage won't use counts as no metadata
        return None
    status, _, body = fetch(url)
    if status != 200:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


def write_secret(path, text):
    tmp = f"{path}.tmp{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def discover(mcp_url):
    """The MCP server's resource id and its authorization server's metadata."""
    u = urllib.parse.urlsplit(mcp_url)
    origin = f"{u.scheme}://{u.netloc}"
    # 1. Ask the server: a 401 names its protected-resource metadata (RFC 9728).
    meta_urls = []
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "cage", "version": "1"}}}).encode()
    status, headers, _ = fetch(mcp_url, data=body, method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    www = headers.get("WWW-Authenticate", "") if headers else ""
    if 'resource_metadata="' in www:
        meta_urls.append(www.split('resource_metadata="', 1)[1].split('"', 1)[0])
    path = u.path.rstrip("/")
    meta_urls += [f"{origin}/.well-known/oauth-protected-resource{path}", f"{origin}/.well-known/oauth-protected-resource"]
    resource = mcp_url
    servers = []
    for m in meta_urls:
        prm = get_json(m)
        if prm:
            resource = prm.get("resource") or resource
            servers = prm.get("authorization_servers") or []
            break
    if status == 200 and not servers:
        return None, None  # no sign-in needed
    servers = servers or [origin]
    if not any(url_ok(s) for s in servers):
        raise SystemExit(f"the sign-in server for {mcp_url} isn't at a plain https address ({ascii(servers[0])})")
    # 2. The authorization server's metadata (RFC 8414, then OpenID Connect discovery).
    for issuer in servers:
        if not url_ok(issuer):
            continue
        i = urllib.parse.urlsplit(issuer)
        ipath = i.path.rstrip("/")
        for m in (f"{i.scheme}://{i.netloc}/.well-known/oauth-authorization-server{ipath}",
                  f"{i.scheme}://{i.netloc}/.well-known/openid-configuration{ipath}",
                  f"{issuer.rstrip('/')}/.well-known/openid-configuration"):
            asm = get_json(m)
            if asm and asm.get("authorization_endpoint") and asm.get("token_endpoint"):
                # Where you sign in, where the tokens come from, where cage registers: all plain https, or nothing.
                for k in ("authorization_endpoint", "token_endpoint", "registration_endpoint"):
                    if k in asm and not url_ok(asm[k]):
                        raise SystemExit(f"the sign-in server gave an address cage won't use ({k}: {ascii(asm[k])}); "
                                         "only plain https addresses are opened or sent anything")
                return resource, asm
    raise SystemExit(f"couldn't find how to sign in to {mcp_url} (no OAuth metadata)")


class Callback(http.server.BaseHTTPRequestHandler):
    result = None

    def log_message(self, *a):
        pass

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        if "code" not in q and "error" not in q:
            self.send_response(404)
            self.end_headers()
            return
        Callback.result = {k: v[0] for k, v in q.items()}
        ok = "code" in q
        why = html.escape(q.get("error_description", q.get("error", [""]))[0])  # the sign-in server's words: text only
        page = ("<h2>[•|•] Signed in.</h2><p>You can close this tab and go back to cage.</p>" if ok else
                f"<h2>[x|x] Sign-in didn't work</h2><p>{why}</p>")
        data = f"<!doctype html><meta charset=utf-8><title>cage</title><body style='font:16px system-ui;margin:3em'>{page}".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def token_request(asm, params, client):
    data = dict(params, client_id=client["client_id"])
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if client.get("client_secret"):  # a confidential client, if the server insisted on one
        if "client_secret_basic" in (client.get("token_endpoint_auth_method") or ""):
            cred = f"{urllib.parse.quote(client['client_id'])}:{urllib.parse.quote(client['client_secret'])}"
            headers["Authorization"] = "Basic " + base64.b64encode(cred.encode()).decode()
        else:
            data["client_secret"] = client["client_secret"]
    status, _, body = fetch(asm["token_endpoint"], data=urllib.parse.urlencode(data).encode(), headers=headers, method="POST")
    try:
        tok = json.loads(body)
    except ValueError:
        tok = {}
    if status != 200 or "access_token" not in tok:
        raise SystemExit(f"the sign-in server refused ({status}): {tok.get('error_description') or tok.get('error') or body[:200]!r}")
    return tok


def save(state_path, token_out, state, tok):
    state["access_token"] = tok["access_token"]
    if tok.get("refresh_token"):  # most servers rotate it: keep the newest
        state["refresh_token"] = tok["refresh_token"]
    state["expires_at"] = int(time.time()) + int(tok.get("expires_in") or 3600)
    write_secret(state_path, json.dumps(state, indent=1))
    write_secret(token_out, tok["access_token"])


def login(state_path, mcp_url, token_out):
    try:
        resource, asm = discover(mcp_url)
    except urllib.error.URLError as e:
        say(f"couldn't reach {mcp_url} ({e.reason})")
        return 5
    if asm is None:
        say("this server doesn't need a sign-in")
        return 4
    srv = http.server.HTTPServer(("127.0.0.1", int(os.environ.get("CAGE_OAUTH_PORT", "0"))), Callback)
    redirect = f"http://localhost:{srv.server_address[1]}/callback"
    client = {"client_id": os.environ.get("CAGE_OAUTH_CLIENT_ID", "")}
    if not client["client_id"]:
        if not asm.get("registration_endpoint"):
            raise SystemExit("this server needs an app registered by hand (no dynamic registration); "
                             "set CAGE_OAUTH_CLIENT_ID and try again")
        reg = {"client_name": "cage", "client_uri": "https://github.com/z-brenner/cage", "redirect_uris": [redirect],
               "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
               "token_endpoint_auth_method": "none"}
        status, _, body = fetch(asm["registration_endpoint"], data=json.dumps(reg).encode(), method="POST",
                                headers={"Content-Type": "application/json"})
        try:
            client = json.loads(body)
        except ValueError:
            client = {}
        if status not in (200, 201) or "client_id" not in client:
            raise SystemExit(f"couldn't register cage with the sign-in server ({status}): {body[:200]!r}")
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state_tag = secrets.token_urlsafe(16)
    params = {"response_type": "code", "client_id": client["client_id"], "redirect_uri": redirect,
              "state": state_tag, "code_challenge": challenge, "code_challenge_method": "S256", "resource": resource}
    scopes = asm.get("scopes_supported")
    if scopes and os.environ.get("CAGE_OAUTH_SCOPE") is None:
        params["scope"] = " ".join(s for s in scopes if s not in ("offline", "offline_access")) + \
            (" offline_access" if "offline_access" in scopes else "")
    if os.environ.get("CAGE_OAUTH_SCOPE"):
        params["scope"] = os.environ["CAGE_OAUTH_SCOPE"]
    url = asm["authorization_endpoint"] + ("&" if "?" in asm["authorization_endpoint"] else "?") + urllib.parse.urlencode(params)
    say(f"  Sign in, in your browser (it opens by itself; if not, open this link):\n  {url}")
    say("  On another device? Approve there, then paste here the address of the page it ends on.")
    if os.environ.get("CAGE_OPEN"):
        subprocess.Popen(shlex.split(os.environ["CAGE_OPEN"]) + [url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    # Wait for the browser to come back, or for the address of the page it ended on to be pasted (a browser on
    # another device can't reach this computer's localhost; its address still carries the code).
    deadline = time.time() + int(os.environ.get("CAGE_OAUTH_TIMEOUT", "600"))
    pasted = None
    while Callback.result is None and time.time() < deadline:
        if sys.stdin.isatty() and select.select([sys.stdin], [], [], 0.5)[0]:
            line = sys.stdin.readline().strip()
            if "code=" in line:
                pasted = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(line).query).items()}
                break
        else:
            time.sleep(0.5)
    srv.shutdown()
    result = Callback.result or pasted
    if not result:
        raise SystemExit("timed out waiting for the sign-in")
    if result.get("state") != state_tag:
        raise SystemExit("the sign-in came back with the wrong state; try again")
    if "code" not in result:
        raise SystemExit(f"sign-in refused: {plain(result.get('error_description') or result.get('error'))}")
    tok = token_request(asm, {"grant_type": "authorization_code", "code": result["code"], "redirect_uri": redirect,
                              "code_verifier": verifier, "resource": resource}, client)
    state = {"mcp_url": mcp_url, "resource": resource, "token_endpoint": asm["token_endpoint"],
             "client": {k: client[k] for k in ("client_id", "client_secret", "token_endpoint_auth_method") if k in client}}
    save(state_path, token_out, state, tok)
    say("signed in")
    return 0


def refresh(state_path, token_out, within=900):
    with open(state_path) as f:
        state = json.load(f)
    if state.get("expires_at", 0) - time.time() > within:
        write_secret(token_out, state["access_token"])
        return 3
    if not state.get("refresh_token"):
        raise SystemExit("the sign-in expired and can't be renewed; sign in again")
    tok = token_request({"token_endpoint": state["token_endpoint"]},
                        {"grant_type": "refresh_token", "refresh_token": state["refresh_token"], "resource": state.get("resource")},
                        state["client"])
    save(state_path, token_out, state, tok)
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    try:
        if len(a) == 4 and a[0] == "login":
            sys.exit(login(a[1], a[2], a[3]))
        if len(a) in (3, 4) and a[0] == "refresh":
            sys.exit(refresh(a[1], a[2], int(a[3]) if len(a) == 4 else 900))
    except SystemExit as e:
        if isinstance(e.code, str):
            say(e.code)
            sys.exit(1)
        raise
    except (OSError, ValueError, KeyError) as e:
        say(f"sign-in failed: {e}")
        sys.exit(1)
    say(__doc__)
    sys.exit(2)
