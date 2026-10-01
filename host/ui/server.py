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

The chat with an agent goes through ~/.cage/app/<agent>, a folder its VM shares (guest/app.mjs relays it to
cc-connect). The VM writes there, so nothing in it is trusted: no links are followed, only regular files are read,
and only pictures are shown in the page (everything else downloads).
  GET  /api/chat/<a>/log?from=N|tail=N   server-sent events: {"o": offset, "e": entry} per line of log.jsonl
  POST /api/chat/<a>/send               {"text", "session"?, "files"?: [{"path","name","mime"}]}
  POST /api/chat/<a>/upload?name=…      the file's bytes                     -> {"path","name","size","mime"}
  POST /api/chat/<a>/action             {"action", "label"?}  (a button in the chat)
  POST /api/chat/<a>/request            {"type": "api"|"ls"|"fetch"|"put", …}  -> the VM's answer
  POST /api/chat/<a>/usage              your plan's usage, as cc-connect's /usage answers it
  GET  /api/chat/<a>/file?p=files/…     a file from the chat (pictures shown, the rest downloaded)
"""
import base64, fcntl, hmac, http.server, json, os, pty, re, signal, stat, struct, subprocess, sys, termios, threading, time
import urllib.parse, urllib.request

CAGE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "cage")
HOME = os.environ.get("CAGE_HOME") or os.path.expanduser("~/.cage")
PORT = int(os.environ.get("CAGE_UI_PORT", "7771"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
TOKEN_FILE = os.path.join(HOME, "ui.token")
ALLOWED = {"", "onboard", "setup", "add", "approve", "up", "down", "login", "update", "logs", "shell", "chat", "connect", "password",
           "secret", "memory", "autostart", "backup", "restore", "security", "network", "allow", "ask", "ask-all",
           "fallback", "voice", "mask", "destroy", "doctor", "status", "version"}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2"}
APPDIR = os.path.join(HOME, "app")
AGENTS = ("claude", "codex", "cursor", "antigravity")
MAX_FILE = 25 << 20
PICTURES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
MIME = dict(PICTURES, **{".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
                         ".json": "application/json", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                         ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                         ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"})
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


def safe_name(name):
    base = re.sub(r"[^\w.\- ()+,@]+", "_", os.path.basename(str(name or ""))).lstrip(". ")[-120:]
    return base or "file"


class Chat:
    """An agent's chat folder (~/.cage/app/<agent>), opened without following links: its VM writes in there."""
    D = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

    def __init__(self, agent):
        if agent not in AGENTS:
            raise KeyError("no such agent")
        self.agent = agent
        os.makedirs(APPDIR, mode=0o700, exist_ok=True)
        top = os.open(APPDIR, self.D)
        try:
            try:
                self.fd = os.open(agent, self.D, dir_fd=top)
            except FileNotFoundError:
                os.mkdir(agent, 0o777, dir_fd=top)
                self.fd = os.open(agent, self.D, dir_fd=top)
                os.fchmod(self.fd, 0o777)
        finally:
            os.close(top)

    def close(self):
        os.close(self.fd)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def sub(self, name):
        try:
            return os.open(name, self.D, dir_fd=self.fd)
        except FileNotFoundError:
            if os.path.lexists(os.path.join(f"/proc/self/fd/{self.fd}", name)):
                raise   # a dangling link: not ours to replace
            os.mkdir(name, 0o777, dir_fd=self.fd)
            fd = os.open(name, self.D, dir_fd=self.fd)
            os.fchmod(fd, 0o777)
            return fd

    def open_file(self, rel):
        """A regular file in this folder (rel: "log.jsonl", "files/x", "out/x"), never through a link."""
        parts = rel.split("/")
        if not 1 <= len(parts) <= 2 or any(p in ("", ".", "..") for p in parts):
            raise FileNotFoundError(rel)
        d = self.sub(parts[0]) if len(parts) == 2 else self.fd
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=d)
        except OSError:   # a link (ELOOP), or anything else that isn't a plain file we can read
            raise FileNotFoundError(rel)
        finally:
            if d != self.fd:
                os.close(d)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise FileNotFoundError(rel)
        return fd

    def write_new(self, folder, name, data, mode=0o644):
        """A new file in in/ or files/ (written, then renamed into place, so the VM never sees half of it)."""
        d = self.sub(folder)
        tmp = "." + name + ".tmp"
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=d)
            try:
                os.fchmod(fd, mode)   # readable by the VM's own user, whatever this process's umask
                view = memoryview(data)
                while view:
                    view = view[os.write(fd, view):]
            finally:
                os.close(fd)
            os.rename(tmp, name, src_dir_fd=d, dst_dir_fd=d)
        finally:
            os.close(d)
        return f"{folder}/{name}"

    def send(self, req):
        req["id"] = req.get("id") or f"{int(time.time() * 1000):013d}-{os.urandom(3).hex()}"
        self.write_new("in", req["id"] + ".json", json.dumps(req).encode())
        return req["id"]

    def answer(self, rid, timeout=20):
        """The VM's answer to a request (out/<id>.json)."""
        end = time.time() + timeout
        while time.time() < end:
            try:
                fd = self.open_file(f"out/{rid}.json")
            except FileNotFoundError:
                time.sleep(0.25)
                continue
            with os.fdopen(fd, "rb") as f:
                data = f.read(4 << 20)
            d = self.sub("out")
            try:
                os.unlink(f"{rid}.json", dir_fd=d)
            except OSError:
                pass
            finally:
                os.close(d)
            return json.loads(data or b"{}")
        return None

    def size(self):
        try:
            st = os.stat("log.jsonl", dir_fd=self.fd, follow_symlinks=False)
            return st.st_size if stat.S_ISREG(st.st_mode) else 0, st.st_ino
        except FileNotFoundError:
            return 0, 0

    def read_log(self, start, limit=4 << 20):
        """Whole lines of log.jsonl from byte `start`: [(offset after the line, entry)]."""
        try:
            fd = self.open_file("log.jsonl")
        except FileNotFoundError:
            return [], start
        with os.fdopen(fd, "rb") as f:
            f.seek(start)
            data = f.read(limit)
        end = data.rfind(b"\n")
        if end < 0:
            return [], start
        out, pos = [], start
        for line in data[:end + 1].split(b"\n")[:-1]:
            pos += len(line) + 1
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if isinstance(e, dict):
                out.append((pos, e))
        return out, pos


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
        except OSError:   # missing, a link, not a folder: nothing the app will touch
            return self.send(404, {"error": "no such file"})

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
        if len(parts) == 3 and parts[0] == "chat":
            return self.chat(method, parts[1], parts[2], query)
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

    def chat(self, method, agent, what, query):
        with Chat(agent) as c:
            if what == "log" and method == "GET":
                return self.tail(c, query)
            if what == "file" and method == "GET":
                return self.file(c, query.get("p", [""])[0], query.get("dl", [""])[0] == "1")
            if method != "POST":
                return self.send(405, {"error": "method"})
            if what == "upload":
                n = int(self.headers.get("Content-Length") or 0)
                if n > MAX_FILE:
                    return self.send(413, {"error": "files can be 25 MB at most"})
                data = self.rfile.read(n) if n else b""
                name = safe_name(query.get("name", ["file"])[0])
                rel = c.write_new("files", f"{int(time.time() * 1000)}-{os.urandom(2).hex()}-{name}", data)
                mime = MIME.get(os.path.splitext(name)[1].lower(), "application/octet-stream")
                return self.send(200, {"path": rel, "name": name, "size": len(data), "mime": mime})
            b = self.body()
            session = str(b.get("session") or "you")
            if not re.fullmatch(r"[a-z0-9-]{1,32}", session):
                raise ValueError("bad session")
            if what == "send":
                text = str(b.get("text", ""))
                if len(text) > 200000:
                    raise ValueError("that message is too long")
                files = []
                for f in (b.get("files") or [])[:10]:
                    p = str(f.get("path", ""))
                    if not re.fullmatch(r"files/[^/]+", p):
                        raise ValueError("bad file")
                    os.close(c.open_file(p))
                    files.append({"path": p, "name": safe_name(f.get("name") or p.split("/")[-1]), "mime": str(f.get("mime") or "")[:100]})
                if not text.strip() and not files:
                    raise ValueError("nothing to send")
                return self.send(200, {"id": c.send({"type": "message", "session": session, "text": text, "files": files})})
            if what == "action":
                return self.send(200, {"id": c.send({"type": "action", "session": session, "action": str(b.get("action", ""))[:512],
                                                     "label": str(b.get("label", ""))[:200]})})
            if what == "request":
                kind = b.get("type")
                req = {"type": kind}
                if kind == "api":
                    req.update(method=str(b.get("method", "GET")).upper(), path=str(b.get("path", "")))
                    if "body" in b:
                        req["body"] = b["body"]
                elif kind in ("ls", "fetch"):
                    req["path"] = str(b.get("path", ""))[:1000]
                elif kind == "put":
                    req.update(dir=str(b.get("dir", ""))[:1000], name=safe_name(b.get("name")), **{"from": str(b.get("from", ""))})
                    os.close(c.open_file(req["from"]))
                else:
                    raise ValueError("bad request")
                ans = c.answer(c.send(req))
                return self.send(200, ans) if ans is not None else self.send(504, {"error": "the agent didn't answer; is it awake?"})
            if what == "usage":
                start, _ = c.size()
                rid = c.send({"type": "message", "session": "usage", "text": "/usage"})
                end = time.time() + 25
                while time.time() < end:
                    entries, _ = c.read_log(start)
                    for _, e in entries:
                        if e.get("session") == "usage" and e.get("ctx") == rid and e.get("t") in ("reply", "card", "error"):
                            return self.send(200, e)
                    time.sleep(0.4)
                return self.send(504, {"error": "the agent didn't answer; is it awake?"})
        return self.send(404, {"error": "no such endpoint"})

    def tail(self, c, query):
        size, ino = c.size()
        if "tail" in query:   # the last part of the chat, from a line's start
            start = max(0, size - int(query["tail"][0]))
            if start:
                start = self.line_start(c, start)
        else:
            start = int(query.get("from", ["0"])[0])
            if start > size:
                start = 0
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        pos, quiet = start, 0.0
        try:
            self.wfile.write(b"data: " + json.dumps({"o": pos, "start": True}).encode() + b"\n\n")
            self.wfile.flush()
            while True:
                size, now = c.size()
                if now != ino or size < pos:   # the VM started a new log: the page starts over
                    ino, pos = now, 0
                    self.wfile.write(b'data: {"reset": true, "o": 0}\n\n')
                entries, pos = c.read_log(pos)
                for o, e in entries:
                    self.wfile.write(b"data: " + json.dumps({"o": o, "e": e}).encode() + b"\n\n")
                if entries:
                    self.wfile.flush()
                    quiet = 0.0
                else:
                    quiet += 0.3
                    if quiet >= 15:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        quiet = 0.0
                    time.sleep(0.3)
        except (BrokenPipeError, ConnectionResetError):
            return

    @staticmethod
    def line_start(c, start):
        try:
            fd = c.open_file("log.jsonl")
        except FileNotFoundError:
            return 0
        with os.fdopen(fd, "rb") as f:
            f.seek(start - 1)
            chunk = f.read(1 << 20)
        i = chunk.find(b"\n")
        return start + i if i >= 0 else start

    def file(self, c, rel, download):
        if not re.fullmatch(r"files/[^/]+", rel):
            return self.send(404, {"error": "no such file"})
        try:
            fd = c.open_file(rel)
        except OSError:   # missing, a link, not a folder: nothing the app will touch
            return self.send(404, {"error": "no such file"})
        with os.fdopen(fd, "rb") as f:
            data = f.read(MAX_FILE + 1)
        name = rel.split("/", 1)[1]
        name = re.sub(r"^\d+-[0-9a-z]{1,8}-", "", name) or name
        ext = os.path.splitext(name)[1].lower()
        if ext in PICTURES and not download:   # only pictures are shown here; anything else could be a page
            return self.send(200, data, PICTURES[ext], {"Content-Security-Policy": "default-src 'none'"})
        quoted = urllib.parse.quote(name)
        return self.send(200, data, "application/octet-stream", {
            "Content-Disposition": f"attachment; filename=\"{safe_name(name)}\"; filename*=UTF-8''{quoted}",
            "Content-Security-Policy": "default-src 'none'"})

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
