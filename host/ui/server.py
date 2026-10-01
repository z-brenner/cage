#!/usr/bin/env python3
"""cage's web app: the page in ./static, and a small API that runs cage itself, so nothing needs a terminal.

  python3 server.py <path to cage>          (started by `cage ui`; listens on 127.0.0.1:$CAGE_UI_PORT, 7771)

Everything the page does is a cage command, run as a "job" in a pseudo-terminal with CAGE_PROTO=1: cage's messages,
links, QR codes and questions arrive as JSON lines (starting with \\x1e) and are passed on as events; anything else
(a vendor's sign-in screen, logs) is passed on as raw terminal output for the page's terminal view. Answers and
keystrokes go back into the job. Only this computer can connect (127.0.0.1, Host and Origin checked), and every
API call needs the token in ~/.cage/ui.token, which `cage ui` puts in the address it opens. Standard library only.

  GET  /api/state                       `cage _state`
  POST /api/jobs {"args": [...]}        start `cage <args>`                  -> {"id"}
  GET  /api/jobs/<id>/events?from=N     server-sent events: {"n","t":"event"|"raw"|"exit",…}
  POST /api/jobs/<id>/input             {"text": "a line"} or {"raw": "<base64>"}
  POST /api/jobs/<id>/resize            {"cols", "rows"}
  POST /api/jobs/<id>/cancel
  GET|PUT /api/memory/about             what your agents know about you (about-me.md)
  GET  /api/update                      the latest release, and this one
"""
import base64, fcntl, hmac, http.server, json, os, pty, re, signal, struct, subprocess, sys, termios, threading, time
import urllib.parse, urllib.request

CAGE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "cage")
HOME = os.environ.get("CAGE_HOME") or os.path.expanduser("~/.cage")
PORT = int(os.environ.get("CAGE_UI_PORT", "7771"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
TOKEN_FILE = os.path.join(HOME, "ui.token")
ALLOWED = {"", "onboard", "setup", "up", "down", "login", "update", "logs", "shell", "chat", "connect", "password",
           "secret", "memory", "autostart", "backup", "restore", "security", "network", "allow", "ask", "ask-all",
           "fallback", "voice", "mask", "destroy", "doctor", "status", "version"}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2"}
CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")


def token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


class Job:
    """A cage command in a pseudo-terminal, with everything it printed kept as numbered events."""
    jobs, lock = {}, threading.Lock()
    MAX_EVENTS = 20000

    def __init__(self, args):
        self.id = base64.urlsafe_b64encode(os.urandom(9)).decode()
        self.args, self.events, self.first, self.done = args, [], 0, False
        self.cond = threading.Condition()
        self.started = time.time()
        master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~termios.ECHO   # answers aren't echoed back (cage shows them itself)
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        env = dict(os.environ, CAGE_PROTO="1", TERM="xterm-256color", COLUMNS="100", LINES="30")
        env.pop("NO_COLOR", None)
        self.proc = subprocess.Popen([CAGE] + args, stdin=slave, stdout=slave, stderr=slave, env=env,
                                     start_new_session=True, close_fds=True, cwd=os.path.expanduser("~"),
                                     preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))   # /dev/tty works (sudo)
        os.close(slave)
        self.master = master
        threading.Thread(target=self.read, daemon=True).start()
        with Job.lock:
            Job.jobs[self.id] = self

    def add(self, ev):
        with self.cond:
            ev["n"] = self.first + len(self.events)
            self.events.append(ev)
            if len(self.events) > self.MAX_EVENTS:   # a long `cage logs`: forget the oldest output
                drop = len(self.events) - self.MAX_EVENTS
                self.events, self.first = self.events[drop:], self.first + drop
            self.cond.notify_all()

    def read(self):
        buf = b""
        while True:
            try:
                data = os.read(self.master, 65536)
            except OSError:
                data = b""
            if not data:
                break
            buf += data
            while buf:
                i = buf.find(b"\x1e")
                if i < 0:   # terminal output (the page's terminal view decodes UTF-8 across chunks)
                    self.add({"t": "raw", "data": base64.b64encode(buf).decode()})
                    buf = b""
                    break
                if i > 0:
                    self.add({"t": "raw", "data": base64.b64encode(buf[:i]).decode()})
                    buf = buf[i:]
                    continue
                j = buf.find(b"\n")
                if j < 0:
                    break   # the rest of this event is still coming
                line, buf = buf[1:j].rstrip(b"\r"), buf[j + 1:]
                try:
                    ev = json.loads(line.decode("utf-8", "replace"))
                    if isinstance(ev, dict) and isinstance(ev.get("t"), str):
                        self.add({"t": "event", "event": ev})
                except ValueError:
                    self.add({"t": "raw", "data": base64.b64encode(b"\x1e" + line + b"\n").decode()})
        code = self.proc.wait()
        try:
            os.close(self.master)
        except OSError:
            pass
        self.done = True
        self.add({"t": "exit", "code": code})

    def write(self, data):
        if not self.done:
            try:
                os.write(self.master, data)
            except OSError:
                pass

    def resize(self, cols, rows):
        if not self.done:
            try:
                fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                os.killpg(self.proc.pid, signal.SIGWINCH)
            except OSError:
                pass

    def cancel(self):
        if not self.done:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except OSError:
                pass

    @classmethod
    def sweep(cls):   # forget jobs that ended more than 10 minutes ago
        with cls.lock:
            for k in [k for k, j in cls.jobs.items() if j.done and time.time() - j.started > 600]:
                del cls.jobs[k]


class State:
    lock, at, body = threading.Lock(), 0.0, b"{}"

    @classmethod
    def get(cls):
        with cls.lock:
            if time.time() - cls.at > 2:
                env = dict(os.environ)
                env.pop("CAGE_PROTO", None)
                out = subprocess.run([CAGE, "_state"], capture_output=True, env=env, timeout=120).stdout
                try:
                    json.loads(out)
                    cls.body, cls.at = out, time.time()
                except ValueError:
                    pass
            return cls.body

    @classmethod
    def stale(cls):
        cls.at = 0.0


class Update:
    at, latest = 0.0, ""

    @classmethod
    def get(cls):
        if time.time() - cls.at > 3600:
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *a):
                    return None
            try:
                urllib.request.build_opener(NoRedirect).open(
                    urllib.request.Request("https://github.com/z-brenner/cage/releases/latest", method="HEAD"), timeout=10)
            except urllib.error.HTTPError as e:
                m = re.search(r"/tag/([^/\s]+)$", e.headers.get("Location", ""))
                if m:
                    cls.latest = m.group(1)
            except OSError:
                pass
            cls.at = time.time()
        return cls.latest


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, status, body=b"", ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def local(self):
        """Only pages served from here, to this computer: stops DNS rebinding and other sites' requests."""
        host = (self.headers.get("Host") or "").lower()
        if host not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}"):
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}")

    def authed(self, query):
        t = self.headers.get("X-Cage-Token") or query.get("token", [""])[0]
        want = token()
        return bool(want) and hmac.compare_digest(t.encode(), want.encode())

    def body(self, limit=1 << 20):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("too big")
        data = self.rfile.read(n) if n else b""
        return json.loads(data or b"{}")

    def do_GET(self):
        self.route("GET")

    def do_HEAD(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def route(self, method):
        url = urllib.parse.urlsplit(self.path)
        path, query = url.path, urllib.parse.parse_qs(url.query)
        if path == "/healthz":
            return self.send(200, "ok", "text/plain")
        if not self.local():
            return self.send(403, {"error": "only this computer can use cage's web app"})
        if not path.startswith("/api/"):
            return self.static(path) if method == "GET" else self.send(405, {"error": "method"})
        if not self.authed(query):
            return self.send(401, {"error": "open cage from `cage ui` (or the cage shortcut)"})
        try:
            return self.api(method, path, query)
        except (ValueError, KeyError, TypeError) as e:
            return self.send(400, {"error": str(e)})

    def static(self, path):
        if path == "/":
            path = "/index.html"
        full = os.path.realpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            return self.send(404, "not found", "text/plain")
        with open(full, "rb") as f:
            data = f.read()
        self.send(200, data, TYPES.get(os.path.splitext(full)[1], "application/octet-stream"),
                  {"Content-Security-Policy": CSP, "X-Frame-Options": "DENY"})

    def api(self, method, path, query):
        parts = path.strip("/").split("/")[1:]
        if parts == ["state"] and method == "GET":
            return self.send(200, State.get())
        if parts == ["update"] and method == "GET":
            return self.send(200, {"latest": Update.get()})
        if parts == ["memory", "about"]:
            f = os.path.join(HOME, "brain", "memory", "about-me.md")
            if method == "GET":
                try:
                    with open(f, encoding="utf-8") as fh:
                        return self.send(200, {"text": fh.read()})
                except OSError:
                    return self.send(200, {"text": ""})
            if method == "PUT":
                text = str(self.body(256 * 1024).get("text", ""))
                os.makedirs(os.path.dirname(f), mode=0o700, exist_ok=True)
                tmp = f + ".tmp"
                with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as fh:
                    fh.write(text)
                os.replace(tmp, f)
                return self.send(200, {"ok": True})
        if parts == ["jobs"] and method == "POST":
            args = self.body().get("args", [])
            if not (isinstance(args, list) and all(isinstance(a, str) and len(a) < 8192 and "\0" not in a for a in args)):
                raise ValueError("args must be a list of strings")
            if (args[0] if args else "") not in ALLOWED:
                return self.send(403, {"error": f"the web app can't run cage {args[0]}"})
            Job.sweep()
            State.stale()
            return self.send(200, {"id": Job(args).id})
        if len(parts) == 3 and parts[0] == "jobs":
            job = Job.jobs.get(parts[1])
            if not job:
                return self.send(404, {"error": "no such job"})
            if parts[2] == "events" and method == "GET":
                return self.stream(job, int(query.get("from", ["0"])[0]))
            if method == "POST":
                b = self.body()
                if parts[2] == "input":
                    if "raw" in b:
                        job.write(base64.b64decode(b["raw"]))
                    else:
                        job.write((str(b.get("text", "")).replace("\n", " ") + "\n").encode())
                elif parts[2] == "resize":
                    job.resize(max(20, min(400, int(b["cols"]))), max(5, min(200, int(b["rows"]))))
                elif parts[2] == "cancel":
                    job.cancel()
                else:
                    return self.send(404, {"error": "no such action"})
                return self.send(200, {"ok": True})
        return self.send(404, {"error": "no such endpoint"})

    def stream(self, job, n):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        try:
            while True:
                with job.cond:
                    if n >= job.first + len(job.events):
                        job.cond.wait(timeout=15)
                    batch = job.events[max(0, n - job.first):]
                if not batch:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                for ev in batch:
                    self.wfile.write(b"data: " + json.dumps(ev).encode() + b"\n\n")
                    n = ev["n"] + 1
                self.wfile.flush()
                if batch[-1]["t"] == "exit":
                    State.stale()
                    return
        except (BrokenPipeError, ConnectionResetError):
            return


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def restart_when_updated():
    """`cage update` replaces this file: start the new one once nothing is running (the page reconnects)."""
    me = os.path.abspath(__file__)
    try:
        born = os.stat(me).st_mtime
    except OSError:
        return
    while True:
        time.sleep(20)
        try:
            changed = os.stat(me).st_mtime != born
        except OSError:
            continue
        with Job.lock:
            busy = any(not j.done for j in Job.jobs.values())
        if changed and not busy:
            os.execv(sys.executable, [sys.executable, me] + sys.argv[1:])


if __name__ == "__main__":
    threading.Thread(target=restart_when_updated, daemon=True).start()
    Server(("127.0.0.1", PORT), Handler).serve_forever()
