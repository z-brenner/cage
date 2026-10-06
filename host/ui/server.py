#!/usr/bin/env python3
"""cage's web app: the page in ./static, and a small API that runs cage itself, so nothing needs a terminal.

  python3 server.py <path to cage>          (started by `cage ui`; listens on 127.0.0.1:$CAGE_UI_PORT, 7771)

Everything the page does is a cage command, run as a "job" in a pseudo-terminal with CAGE_PROTO=<a random code for
that job>: cage's messages, links, QR codes and questions arrive as JSON lines (\\x1e, the code, then the JSON) and are
passed on as events; anything else (a vendor's sign-in screen, logs, whatever a VM prints) is passed on as raw
terminal output for the page's terminal view. A VM never learns the code, so it can't fake one of cage's questions.
Answers and keystrokes go back into the job. Only this computer can connect (127.0.0.1, Host, Origin and
Sec-Fetch-Site checked), and every API call needs the token in ~/.cage/ui.token. `cage ui` never puts that token in
an address: it opens the page with a one-time pairing code (~/.cage/ui.pair) that the page trades for it, once.
Standard library only.

  GET  /healthz?nonce=N                 proves this is cage: HMAC-SHA256(token, N), for `cage ui` (no token needed)
  POST /api/pair {"code"}               a pairing code from `cage ui` -> {"token"}; each code works once, for a minute,
                                        and (on Linux) only for a program of the user cage runs as
  GET  /api/state                       `cage _state` ("stale": true when cage took too long and this is older)
  GET  /api/check                       `cage _check`: this computer, for the setup screen
  GET  /api/jobs                        the jobs still running that the page showed (to reattach after a reload)
  POST /api/jobs {"args": [...]}        start `cage <args>`; optional "title", "cols" (a wide terminal keeps sign-in
                                        links whole) and "text" (a question for `ask` or `mask try`, handed to cage
                                        in a file instead of argv, where other users of this computer could see it)
  GET  /api/jobs/<id>/events?from=N     server-sent events: {"n","t":"event"|"raw"|"input"|"exit",…} ("input": an
                                        answer went in)
  POST /api/jobs/<id>/input             {"text": "a line"} or {"raw": "<base64>"}
  POST /api/jobs/<id>/resize            {"cols", "rows"}
  POST /api/jobs/<id>/cancel
  GET|PUT /api/memory/about             what your agents know about you (about-me.md)
  GET  /api/update                      the latest release, and this one

The chat with an agent goes through ~/.cage/app/<agent>, a folder its VM shares (guest/app.mjs relays it to
cc-connect). The VM writes there, so nothing in it is trusted: no links are followed, only regular files are read,
and only pictures are shown in the page (everything else downloads).
  GET  /api/chat/<a>/history?tail=N     the end of the chat (log.jsonl, after the end of log.1.jsonl when the VM has
                                        just started a new one): {"o": offset in log.jsonl, "entries", "more"}
  GET  /api/chat/stream?from=a:N:I,b:M  server-sent events for all your agents' chats at once (a browser allows only a
                                        few connections per site): {"a", "o", "start", "ino"} where each begins, then
                                        {"a", "o", "e"} per new line, {"a", "reset", "ino"} when the VM starts a new
                                        log. I (optional): the log N is in, as "ino" said, to go on from the log before
  GET  /api/activity?agents=a,b&since=T what each agent is doing, from the end of its chat (for Home): {"agents": {a:
                                        {"pending": {"text","at"}|null, "working", "last": {"t","text","at"}|null,
                                        "today": {"asked","answers","files"} (from T, ms, on)}}}
  POST /api/chat/<a>/send               {"text", "session"?, "files"?: [{"path","name","mime"}]}
  POST /api/chat/<a>/upload?name=…      the file's bytes                     -> {"path","name","size","mime"}
  POST /api/chat/<a>/action             {"action", "label"?, "pending"?}  (a button in the chat; from Home, with the
                                        approval it answers, as /api/activity gave it: 409 if it isn't that one now.
                                        409 too for a second answer to one, until the VM has taken the first)
  POST /api/chat/<a>/request            {"type": "api"|"ls"|"fetch"|"put", …}  -> the VM's answer
  POST /api/chat/<a>/usage {"fresh"?}  your plan's usage, as cc-connect's /usage answers it, plus "asked" (when, in
                                        seconds) and "stale" (an older answer: the last one wasn't good), or {"error"}.
                                        Asked at most every 10 minutes, or 30 seconds with "fresh"
  GET  /api/chat/<a>/file?p=files/…     a file from the chat (pictures shown, the rest downloaded)
"""
import base64, fcntl, hashlib, hmac, http.server, json, math, os, pty, re, secrets, signal, socket, stat, struct, subprocess, sys
import termios, threading, time, unicodedata, urllib.parse, urllib.request

CAGE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "cage")
HOME = os.environ.get("CAGE_HOME") or os.path.expanduser("~/.cage")
PORT = int(os.environ.get("CAGE_UI_PORT", "7771"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
TOKEN_FILE = os.path.join(HOME, "ui.token")
PAIR_FILE = os.path.join(HOME, "ui.pair")
JOBS_DIR = os.path.join(HOME, "jobs")
AGENTS = ("claude", "codex", "cursor", "antigravity")
# What the page may run, and the shape of each command's arguments: "A" is an agent, "S" any text that doesn't start
# with "-", "a|b" one of these words (or an agent, for "A|all"), and a final "*" any number of them. Nothing else
# runs, so a leaked token can't delete an agent, or slip in a flag that skips one of cage's questions. A question for
# `ask` and the text for `mask try` come in "text" (see start()), never as an argument.
COMMANDS = {
    "setup": ["A"], "add": ["--no-login A*", "A*"], "approve": ["A on|off"], "fix": [""], "up": ["A*"],
    "down": ["A*"], "login": ["A"], "update": [""], "logs": ["A"], "shell": ["A"], "doctor": [""],
    "chat": ["add slack|discord|whatsapp A", "rm slack|discord|whatsapp A", "link whatsapp A"],
    "connect": ["add S A*", "add S S A*", "rm S"], "password": ["add S A*", "rm S"], "secret": ["add S S A*", "rm S"],
    "memory": [""], "autostart": ["on|off"], "backup": [""], "restore": ["S"], "security": [""],
    "network": ["open|strict"], "allow": ["S A|all*", "rm S A|all*"], "ask": ["A*"], "ask-all": ["on|off"],
    "fallback": ["A A|off"], "voice": ["off", "on local|groq"], "mask": ["on|off A*", "add S", "rm S", "try"],
}
MAX_ARG, MAX_ARGS, MAX_TEXT = 131072, 512 << 10, 512 << 10   # one argument (Linux's own limit), all of them, a text
# A question for `ask`, in bytes: in the VM, each agent's CLI gets it as one argument, which Linux caps at 128 KiB. The
# rest is room for the privacy mask, whose placeholders can be longer than what they stand for. (app.js's MAX_ASK too)
MAX_ASK = 120 << 10
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
         ".webmanifest": "application/manifest+json"}
APPDIR = os.path.join(HOME, "app")
MAX_FILE = 25 << 20
PICTURES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
MIME = dict(PICTURES, **{".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
                         ".json": "application/json", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                         ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                         ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"})
CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
TOO_BIG = "A message was too long to show here"


def finite(s):
    """A number in JSON (that has a point or an exponent), or None for one too big for a float (1e400)."""
    f = float(s)
    return f if math.isfinite(f) else None


def token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


class Refused(Exception):
    """A request we answer with an error status and a sentence for the page."""
    def __init__(self, status, error):
        super().__init__(error)
        self.status, self.error = status, error


def fits(shape, args):
    """Do these arguments have this shape (see COMMANDS)?"""
    words = shape.split()
    for i, w in enumerate(words):
        if w.endswith("*"):
            return all(word_fits(w[:-1], a) for a in args[i:])
        if i >= len(args) or not word_fits(w, args[i]):
            return False
    return len(args) == len(words)


def word_fits(w, a):
    if w == "S":
        return bool(a) and not a.startswith("-")
    return any(a in AGENTS if alt == "A" else a == alt for alt in w.split("|"))


def check_args(args):
    """Refuses anything the page doesn't run (see COMMANDS); returns the command."""
    if not (isinstance(args, list) and args and all(isinstance(a, str) and "\0" not in a for a in args)):
        raise Refused(400, "args must be a list of strings")
    if any(len(a) > MAX_ARG for a in args) or sum(len(a.encode("utf-8", "replace")) for a in args) > MAX_ARGS:
        raise Refused(413, "That's too long to send.")
    cmd, rest = args[0], args[1:]
    if cmd not in COMMANDS:
        raise Refused(403, f"the web app can't run cage {cmd}")
    if not any(fits(s, rest) for s in COMMANDS[cmd]):
        raise Refused(403, f"the web app can't run cage {cmd} like that")
    return cmd


def events(buf, mark, eof=False):
    """Splits a job's output into cage's events and raw output: [("event", dict) | ("raw", bytes)], and what's left.
    An event is \\x1e, then `mark` (the job's code), then JSON, then a newline; any other \\x1e is just output."""
    out, want = [], b"\x1e" + mark + b"{"
    while buf:
        i = buf.find(b"\x1e")
        if i < 0:
            out.append(("raw", buf))
            return out, b""
        if i > 0:
            out.append(("raw", buf[:i]))
            buf = buf[i:]
        if len(buf) < len(want) and want.startswith(buf) and not eof:
            break   # it may still turn into an event
        if not buf.startswith(want):   # not cage's: whatever printed it doesn't know the code
            k = buf.find(b"\x1e", 1)
            out.append(("raw", buf[:k] if k > 0 else buf))
            buf = buf[k:] if k > 0 else b""
            continue
        j = buf.find(b"\n")
        if j < 0 and not eof and len(buf) < 4 << 20:
            break   # the rest of this event is still coming
        line, buf = (buf[:j], buf[j + 1:]) if j >= 0 else (buf, b"")
        try:
            ev = json.loads(line[len(want) - 1:].rstrip(b"\r").decode("utf-8", "replace"))
        except ValueError:
            ev = None
        if isinstance(ev, dict) and isinstance(ev.get("t"), str):
            out.append(("event", ev))
        else:
            out.append(("raw", line[len(want) - 1:] + b"\n"))
    return out, buf


def job_child():
    """In a job, before cage starts: the pseudo-terminal becomes its terminal, so /dev/tty works (sudo), and it ends
    with that terminal, as a command does when you close its window. (`cage ui` starts this server with nohup, which
    every job would inherit: a log left open would go on for ever once the server is gone.)"""
    signal.signal(signal.SIGHUP, signal.SIG_DFL)
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


class Job:
    """A cage command in a pseudo-terminal, with everything it printed kept as numbered events."""
    jobs, lock = {}, threading.Lock()
    MAX_BYTES = 8 << 20   # what a job printed, kept for the page; a long `cage logs` forgets its oldest output
    VIEWERS = ("logs", "shell")   # only there to be looked at: stopped once no page has watched for 2 minutes

    def __init__(self, args, cols=100, title="", text_file=None, shown=None):
        self.id = base64.urlsafe_b64encode(os.urandom(9)).decode()
        self.args, self.title, self.text_file = args, title, text_file
        self.shown = shown or args   # what the page asked for (without the file a question went in)
        self.events, self.sizes, self.size, self.first, self.done, self.code = [], [], 0, 0, False, None
        self.cond = threading.Condition()
        self.started, self.ended, self.cancelled = time.time(), 0.0, 0.0
        self.watchers, self.unwatched = 0, time.time()
        self.nonce = secrets.token_hex(8)   # in cage's events only: the VMs behind `login` or `logs` never see it
        master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~termios.ECHO   # answers aren't echoed back (cage shows them itself)
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, cols, 0, 0))
        env = dict(os.environ, CAGE_PROTO=self.nonce, TERM="xterm-256color", COLUMNS=str(cols), LINES="30")
        env.pop("NO_COLOR", None)
        self.proc = subprocess.Popen([CAGE] + args, stdin=slave, stdout=slave, stderr=slave, env=env,
                                     start_new_session=True, close_fds=True, cwd=os.path.expanduser("~"), preexec_fn=job_child)
        os.close(slave)
        self.master = master
        threading.Thread(target=self.read, daemon=True).start()
        with Job.lock:
            Job.jobs[self.id] = self

    def add(self, ev):
        with self.cond:
            ev["n"] = self.first + len(self.events)
            n = len(json.dumps(ev))
            self.events.append(ev)
            self.sizes.append(n)
            self.size += n
            if self.size > self.MAX_BYTES:   # forget the oldest output, a quarter at a time (not one line at a time)
                drop, freed = 0, 0
                while self.size - freed > self.MAX_BYTES * 3 // 4 and drop < len(self.events) - 1:
                    freed += self.sizes[drop]
                    drop += 1
                del self.events[:drop], self.sizes[:drop]
                self.size -= freed
                self.first += drop
            self.cond.notify_all()

    def read(self):
        buf, mark = b"", self.nonce.encode()
        while True:
            try:
                data = os.read(self.master, 65536)
            except OSError:
                data = b""
            buf += data
            items, buf = events(buf, mark, eof=not data)
            for kind, x in items:   # raw output: the page's terminal view decodes UTF-8 across chunks
                self.add({"t": "event", "event": x} if kind == "event" else {"t": "raw", "data": base64.b64encode(x).decode()})
            if not data:
                break
        code = self.proc.wait()
        try:
            os.close(self.master)
        except OSError:
            pass
        if self.text_file:   # cage removes it once read; not if it stopped before
            try:
                os.unlink(self.text_file)
            except OSError:
                pass
        self.done, self.code, self.ended = True, code, time.time()
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

    def cancel(self, sig=signal.SIGTERM):
        if not self.done:
            self.cancelled = self.cancelled or time.time()
            try:
                os.killpg(self.proc.pid, sig)
            except OSError:
                pass

    def watch(self, on):
        with self.cond:
            self.watchers += 1 if on else -1
            if not self.watchers:
                self.unwatched = time.time()

    @classmethod
    def sweep(cls):
        """Forgets jobs that ended more than 10 minutes ago, and stops logs and terminals nobody is looking at."""
        now = time.time()
        forget_questions(now)
        with cls.lock:
            for k in [k for k, j in cls.jobs.items() if j.done and now - j.ended > 600]:
                del cls.jobs[k]
            jobs = list(cls.jobs.values())
        for j in jobs:
            if j.done:
                continue
            if j.cancelled and now - j.cancelled > 10:
                j.cancel(signal.SIGKILL)   # it didn't stop when asked
            elif j.args[0] in cls.VIEWERS and not j.watchers and now - j.unwatched > 120:
                j.cancel()


def forget_questions(now):
    """Removes questions handed to cage in jobs/ that are still there 10 minutes on. cage reads (and removes) one as
    it starts, so these are from jobs that never got that far: the web app stopped first, say."""
    try:
        names = os.listdir(JOBS_DIR)
    except OSError:
        return
    for name in names:
        f = os.path.join(JOBS_DIR, name)
        try:
            if name.endswith(".txt") and now - os.lstat(f).st_mtime > 600:
                os.unlink(f)
        except OSError:
            pass


def safe_name(name):
    base = re.sub(r"[^\w.\- ()+,@]+", "_", os.path.basename(str(name or ""))).lstrip(". ")[-120:]
    return base or "file"


def shown_name(stored):
    """A chat file's own name: without the "<time>-<random>-" that keeps names apart in files/."""
    return re.sub(r"^\d{10,}-[0-9a-z]{2,8}-", "", stored, count=1) or stored


LATIN = str.maketrans({"ł": "l", "Ł": "L", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D", "ß": "ss", "æ": "ae", "Æ": "AE",
                       "œ": "oe", "Œ": "OE", "þ": "th", "Þ": "Th", "ı": "i"})   # letters without an accent to drop


def disposition(name):
    """Content-Disposition for a download. Browsers take the real name (filename*); headers can only carry
    Latin-1, so filename= gets a plain-ASCII stand-in ("Łódź 2024.pdf" -> "Lodz 2024.pdf", "报告.pdf" -> "file.pdf")."""
    stem, ext = os.path.splitext(name)
    plain = lambda s: unicodedata.normalize("NFKD", s.translate(LATIN)).encode("ascii", "ignore").decode()
    stem, ext = plain(stem).strip(" ._-"), re.sub(r"[^A-Za-z0-9.]", "", plain(ext))
    fallback = safe_name(stem + ext) if stem else "file" + ext
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{urllib.parse.quote(name, safe='')}"


class Chat:
    """An agent's chat folder (~/.cage/app/<agent>), opened without following links: its VM writes in there."""
    D = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

    def __init__(self, agent, create=True):
        """create=False: only one that's there already (FileNotFoundError if not)."""
        if agent not in AGENTS:
            raise KeyError("no such agent")
        self.agent = agent
        if create:
            os.makedirs(APPDIR, mode=0o700, exist_ok=True)
        top = os.open(APPDIR, self.D)
        try:
            try:
                self.fd = os.open(agent, self.D, dir_fd=top)
            except FileNotFoundError:
                if not create:
                    raise
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

    def waiting(self, rid):
        """Is that request still in in/, not yet taken by the VM (whose relay isn't running, say)?"""
        try:
            d = os.open("in", self.D, dir_fd=self.fd)
        except OSError:
            return False
        try:
            return stat.S_ISREG(os.stat(f"{rid}.json", dir_fd=d, follow_symlinks=False).st_mode)
        except OSError:
            return False
        finally:
            os.close(d)

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

    def size(self, name="log.jsonl"):
        try:
            st = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            return st.st_size if stat.S_ISREG(st.st_mode) else 0, st.st_ino
        except FileNotFoundError:
            return 0, 0

    def read_log(self, start, limit=4 << 20, name="log.jsonl", ino=None):
        """Whole lines of the log from byte `start`: [(offset after the line, entry)], and where to go on from. A line
        bigger than the whole window is skipped (with a note in its place), so one huge line can't stall the chat.
        With `ino`, only if the file is still that one."""
        try:
            fd = self.open_file(name)
        except FileNotFoundError:
            return [], start
        with os.fdopen(fd, "rb") as f:
            if ino is not None and os.fstat(f.fileno()).st_ino != ino:
                return [], start
            f.seek(start)
            data = f.read(limit)
            end = data.rfind(b"\n")
            if end < 0:
                if len(data) < limit:
                    return [], start   # the rest of the line is still being written
                pos = start + len(data)
                while True:
                    chunk = f.read(1 << 20)
                    if not chunk:
                        return [], start
                    i = chunk.find(b"\n")
                    if i >= 0:
                        pos += i + 1
                        return [(pos, {"t": "error", "text": TOO_BIG})], pos
                    pos += len(chunk)
        out, pos = [], start
        for line in data[:end + 1].split(b"\n")[:-1]:
            pos += len(line) + 1
            try:   # (NaN, Infinity and 1e400 are no number in JSON.parse, which would read none of the page's answer)
                e = json.loads(line, parse_constant=lambda c: None, parse_float=finite)
            except (ValueError, RecursionError):   # (nested deeper than Python reads: skipped, as a line that isn't JSON)
                continue
            if isinstance(e, dict):
                out.append((pos, e))
        return out, pos

    def line_start(self, start, name="log.jsonl"):
        """The start of the first whole line at or after byte `start`."""
        try:
            fd = self.open_file(name)
        except FileNotFoundError:
            return 0
        with os.fdopen(fd, "rb") as f:
            f.seek(start - 1)
            chunk = f.read(1 << 20)
        i = chunk.find(b"\n")
        return start + i if i >= 0 else start


TAIL = 512 << 10   # how much of the end of a chat log Home reads
WORKING = 15 * 60   # "working…" for longer than this without a word is stale (it was stopped, or its VM restarted)
# How cc-connect (v1.5.0 and 1.5.1-beta.3, core/engine.go) reads what you send while it waits for your OK: a message
# with any of these words in it is the answer (allow, deny or allow all, in English or Chinese), and so is a perm:
# button; anything else gets "Waiting for permission response", and the approval still waits. A command that ends the
# turn ends the wait too, and so does one that starts the agent's session afresh (cleanupInteractiveState): /switch,
# /model, /reasoning, /dir and /provider when they're told what to switch to (without, they only show what there is). So
# does a restart of cc-connect, which keeps what it waits for only in memory: the relay registering with it again (a
# "status" line).
ANSWER_WORDS = {"allow", "yes", "y", "ok", "approve", "deny", "no", "n", "reject", "cancel", "allowall", "允许", "同意",
                "可以", "好", "好的", "是", "确认", "拒绝", "不允许", "不行", "不", "否", "取消", "允许所有", "允许全部",
                "全部允许", "所有允许", "都允许", "全部同意"}
ANSWER_SPLIT = re.compile(r"[\s@＠,，.。!！?？:：;；()（）\[\]【】\"'“”‘’、·]+")
ENDS_TURN = ("/stop", "/new", "/cancel")
STARTS_AFRESH = ("/switch", "/model", "/reasoning", "/effort", "/dir", "/cd", "/chdir", "/workdir")


def answers(e):
    """Does this line of the chat log answer an approval cc-connect waits for (or end the turn it waits in)?"""
    t = e.get("t")
    said = e.get("text") if t == "you" else e.get("action") if t == "action" else None
    if not isinstance(said, str):
        return False
    if t == "action":
        if said.startswith("perm:"):
            return True
        said = re.sub(r"^(cmd|act):", "", said)   # a card's other buttons: a command ("act:/stop"), or something to show
        if not said.startswith("/"):
            return False
    said = said.strip().lower()
    files = e.get("files") if t == "you" and isinstance(e.get("files"), list) else []
    picture = any(isinstance(f, dict) and re.fullmatch(r"image/(png|jpeg|gif|webp)", str(f.get("mime"))) for f in files)
    if said.startswith("/") and not picture:   # (with a picture, cc-connect gives it to the agent, command or not)
        cmd = said.split()
        afresh = len(cmd) > 1 and (cmd[0] in STARTS_AFRESH or (cmd[0] == "/provider" and cmd[1] in ("switch", "clear", "reset", "none")))
        return cmd[0] in ENDS_TURN or afresh
    return any(w in ANSWER_WORDS for w in ANSWER_SPLIT.split(said))


def activity(c, since):
    """What an agent is doing, from the end of its chat log (read like the chat: no links followed): an approval
    waiting for you (cc-connect's "perm:" buttons, until something answers them, see answers()),
    since when it's been working (typing on, until it answers), what it said last, and how many questions, answers
    and files there were from `since` on (ms: the page's midnight). The log is the VM's, so every value is checked."""
    size, _ = c.size()
    start = c.line_start(size - TAIL) if size > TAIL else 0
    entries, _ = c.read_log(start, TAIL + (1 << 20))
    pending, typing, last, today = None, None, None, {"asked": 0, "answers": 0, "files": 0}
    for _, e in entries:
        if (e.get("session") or "you") != "you":
            continue
        t, at = e.get("t"), e.get("at")
        # (a time, in ms: not Infinity or NaN, which json reads but a browser doesn't, so one agent's log could keep Home
        # from showing any agent's approvals)
        at = at if isinstance(at, (int, float)) and not isinstance(at, bool) and 0 <= at < 1e15 else 0
        rows = e.get("buttons") if isinstance(e.get("buttons"), list) else []
        if t == "buttons" and any(isinstance(b, dict) and str(b.get("data", "")).startswith("perm:")
                                  for row in rows if isinstance(row, list) for b in row):
            pending = {"text": str(e.get("text") or "")[:4000], "at": at}   # (one this long, Home reads as cut)
        elif answers(e) or (t == "status" and e.get("connected") is True):
            pending = None
        if t == "typing":
            typing = at if e.get("on") is True else None
        elif t in ("reply", "error", "buttons"):   # as the chat shows it: an answer, an error or a question ends "working…"
            typing = None
        if t in ("reply", "file", "card"):
            card = e.get("card") if isinstance(e.get("card"), dict) else {}
            header = card.get("header") if isinstance(card.get("header"), dict) else {}
            text = e.get("text") if t == "reply" else e.get("name") if t == "file" else header.get("title")
            last = {"t": t, "text": str(text or "")[:160], "at": at}
        if at >= since:
            key = {"you": "asked", "reply": "answers", "file": "files"}.get(t)
            if key:
                today[key] += 1
    return {"pending": pending, "typing": typing, "last": last, "today": today}


class Answered:
    """The approval each agent was last sent an answer for, as its log showed it waiting then. cc-connect's buttons say
    allow or deny, not to what: an answer goes to whatever waits when it gets there. Until the VM has taken one (and
    its log says so), the approval still seems to wait, and a second answer to it (another window's, or a card's in
    the chat after Home's) would answer what the agent asks next, which nobody has seen. So that one is refused. An
    agent's answers go one at a time: two can't both find the approval still waiting."""
    lock, locks, last = threading.Lock(), {}, {}

    @classmethod
    def of(cls, agent):
        with cls.lock:
            return cls.locks.setdefault(agent, threading.Lock())

    @classmethod
    def sent(cls, agent, pending):
        if pending is not None:
            cls.last[agent] = pending


def ask_usage(c, timeout=25):
    """Asks an agent for its plan's usage (/usage, in a conversation of its own that the chat doesn't show), and waits
    a while for the answer: {"rid": the question's id, "pos": how far its log has been read for the answer, "entry": the
    card, reply or error cc-connect answered with, or None}."""
    pos, _ = c.size()
    q = {"rid": c.send({"type": "message", "session": "usage", "text": "/usage"}), "pos": pos, "entry": None}
    end = time.time() + timeout
    while not usage_answer(c, q) and time.time() < end:
        time.sleep(0.4)
    return q


def usage_answer(c, q):
    """The answer to that question, if it's in the log by now (read on from where the last look stopped), or None."""
    entries, q["pos"] = c.read_log(q["pos"])
    for _, e in entries:
        if e.get("session") == "usage" and e.get("ctx") == q["rid"] and e.get("t") in ("reply", "card", "error"):
            q["entry"] = e
            break
    return q["entry"]


class Usage:
    """Each agent's plan usage, as its /usage card says it ("5h limit\nRemaining: 58%\nResets: 2h 13m"). Home shows it,
    and pages look again every minute, but an agent is asked at most every 10 minutes ("Check again": 30 seconds).
    Asking costs no quota, but it's a request to the AI company each time. An answer that didn't come in time (the
    agent was still waking up, say) is looked for in the log at each look instead, which costs nothing; and while the
    agent hasn't even taken a question (its relay is down), no second one piles up behind it. The last good answer
    (a card) is kept with when it was asked, for when a later one is an error."""
    EVERY, SOONEST = 600, 30
    lock, asking, last, good = threading.Lock(), {}, {}, {}
    ask, look = staticmethod(ask_usage), staticmethod(usage_answer)

    @classmethod
    def get(cls, c, fresh=False):
        with cls.lock:
            one = cls.asking.setdefault(c.agent, threading.Lock())
        with one:   # one question at a time per agent: another page waits for its answer instead of asking again
            last = cls.last.get(c.agent)
            if last and not last["entry"]:
                cls.look(c, last)
            due = not last or time.time() - last["asked"] >= (cls.SOONEST if fresh else cls.EVERY)
            if due and not (last and not last["entry"] and c.waiting(last["rid"])):
                asked = time.time()
                last = cls.last[c.agent] = dict(cls.ask(c), asked=asked)
            if last["entry"] and last["entry"].get("t") == "card":
                cls.good[c.agent] = last
            good = cls.good.get(c.agent)
        if good and good is not last:   # this one didn't say (its service is down, say): the last good answer, marked
            return dict(good["entry"], asked=good["asked"], stale=True)
        return dict(last["entry"], asked=last["asked"]) if last["entry"] else None


class State:
    lock, at, body, ok = threading.Lock(), 0.0, b"{}", False
    TIMEOUT = 20   # seconds `cage _state` may take

    @classmethod
    def get(cls):
        """`cage _state`, at most every 2 seconds. While it runs, others get the last answer; if it hangs, they get
        that too, marked stale (and with no answer at all yet, an error)."""
        if not cls.lock.acquire(blocking=not cls.ok):
            return cls.body
        try:
            if time.time() - cls.at > 2:
                env = dict(os.environ)
                env.pop("CAGE_PROTO", None)
                try:
                    out = subprocess.run([CAGE, "_state"], capture_output=True, env=env, timeout=cls.TIMEOUT).stdout
                    d = json.loads(out)
                    if isinstance(d, dict):
                        cls.body, cls.ok = out, True
                except subprocess.TimeoutExpired:
                    if not cls.ok:
                        raise Refused(504, "cage is taking too long to answer")
                    cls.body = json.dumps(dict(json.loads(cls.body), stale=True)).encode()
                except ValueError:
                    pass
                cls.at = time.time()
            return cls.body
        finally:
            cls.lock.release()

    @classmethod
    def stale(cls):
        cls.at = 0.0

    @classmethod
    def backups(cls):
        """Where cage keeps backups (as `cage _state` says), the only place the app restores from."""
        try:
            return json.loads(cls.get())["backups"]["dir"]
        except (ValueError, KeyError, TypeError):
            return ""


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


PAIRING = threading.Lock()


def peer_uid(peer, here, table="/proc/net/tcp"):
    """The user on the other end of a connection from this computer, on Linux: who owns its socket. None when that
    can't be told (another system, or a connection handed in from outside, like Windows' browser on WSL)."""
    hexed = lambda a: "%08X:%04X" % (struct.unpack("=I", socket.inet_aton(a[0]))[0], a[1])   # as the kernel writes it
    want, back = hexed(peer), hexed(here)
    try:
        with open(table) as f:
            for line in f:
                p = line.split()
                if len(p) > 7 and p[1] == want and p[2] == back:
                    return int(p[7])
    except (OSError, ValueError):
        pass
    return None


def pair(code):
    """Trades a pairing code from `cage ui` (a line "<until> <code>" in ui.pair) for the token: once, and in time."""
    with PAIRING:
        return pair_locked(code)


def pair_locked(code):
    now, found, keep = time.time(), False, []
    try:
        with open(PAIR_FILE) as f:
            lines = f.read().split("\n")
    except OSError:
        lines = []
    for line in lines:
        until, _, c = line.partition(" ")
        if not until.isdigit() or int(until) < now:
            continue
        if not found and code and hmac.compare_digest(c.encode(), code.encode()):
            found = True
        else:
            keep.append(line)
    if lines:
        tmp = f"{PAIR_FILE}.{os.getpid()}"
        with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            f.write("".join(x + "\n" for x in keep))
        os.replace(tmp, PAIR_FILE)
    return token() if found else ""


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def head(self, status, headers):
        """The status line and headers, all checked first: one that can't be sent fails before anything is."""
        for k, v in headers:
            f"{k}: {v}".encode("latin-1")
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.sent = True

    def send(self, status, body=b"", ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        # An answer given without reading the request's body (no such job, say) ends the connection: what's left of
        # that body would otherwise be read as the next request
        unread = [("Connection", "close")] if self.headers.get("Content-Length", "0").strip() not in ("", "0") and not self.body_read else []
        self.head(status, [("Content-Type", ctype), ("Content-Length", str(len(body))), ("Cache-Control", "no-store"),
                           ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer")] + unread + list((extra or {}).items()))
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

    def length(self, limit, too_big="that's too big"):
        """The size of the request's body, which must be said up front (no chunks), and at most `limit`."""
        if self.headers.get("Transfer-Encoding"):
            raise Refused(411, "send the size of the request first (no chunked bodies)")
        n = self.headers.get("Content-Length")
        if n is None:
            raise Refused(411, "send the size of the request first")
        if not n.strip().isdigit():
            raise Refused(400, "bad Content-Length")
        if int(n) > limit:
            raise Refused(413, too_big)
        return int(n)

    def read_body(self, n):
        """n bytes of the request's body, from a client that has 30 seconds to send them."""
        self.body_read = True
        self.connection.settimeout(30)
        try:
            data = self.rfile.read(n) if n else b""
        except socket.timeout:
            raise Refused(408, "the request took too long to arrive")
        finally:
            self.connection.settimeout(None)
        if len(data) != n:
            raise Refused(400, "the request was cut short")
        return data

    def body(self, limit=1 << 20):
        data = self.read_body(self.length(limit))
        try:
            b = json.loads(data or b"{}")
        except ValueError:
            raise Refused(400, "that isn't JSON")
        if not isinstance(b, dict):
            raise Refused(400, "expected a JSON object")
        return b

    def do_GET(self):
        self.route("GET")

    def do_HEAD(self):
        self.route("HEAD")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def route(self, method):
        self.sent, self.body_read = False, False
        try:
            self.dispatch(method)
        except Refused as e:
            self.fail(e.status, e.error)
        except (ValueError, KeyError, TypeError) as e:
            self.fail(400, str(e))
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except OSError:   # missing, a link, not a folder: nothing the app will touch
            self.fail(404, "no such file")
        except Exception as e:   # a bug: the page gets an answer (not a dropped connection), the log the details
            print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {method} {self.path.split('?')[0]}: {e!r}", file=sys.stderr, flush=True)
            self.fail(500, "something went wrong in cage's web app")

    def fail(self, status, error):
        self.close_connection = True   # what's left of the request (an unread body) can't be the next one
        if not self.sent:   # once an answer has started, an error can only end it
            try:
                self.send(status, {"error": error})
            except OSError:
                pass

    def dispatch(self, method):
        url = urllib.parse.urlsplit(self.path)
        path, query = url.path, urllib.parse.parse_qs(url.query)
        # Another website gets nothing, not even a picture, so it can't tell that cage runs here. A link from one may
        # still open the page itself: the page can't be read from there, and it brings nothing but what you'd type.
        page = method == "GET" and (path == "/" or path.endswith(".html")) and self.headers.get("Sec-Fetch-Dest") == "document"
        if self.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site") and not page:
            return self.send(403, {"error": "only cage's own page can use cage's web app"})
        if not self.local():
            return self.send(403, {"error": "only this computer can use cage's web app"})
        if path == "/healthz" and method == "GET":
            nonce = query.get("nonce", [""])[0]
            if not nonce:
                return self.send(200, "ok", "text/plain")
            if not re.fullmatch(r"[A-Za-z0-9]{8,128}", nonce):
                raise Refused(400, "bad nonce")
            return self.send(200, hmac.new(token().encode(), nonce.encode(), hashlib.sha256).hexdigest(), "text/plain")
        if not path.startswith("/api/"):
            return self.static(path) if method in ("GET", "HEAD") else self.send(405, {"error": "method"})
        if method == "HEAD":
            return self.send(405, {"error": "method"})
        if path == "/api/pair" and method == "POST":
            # The code was in the address cage ui opened, which other users of this computer can see while the browser
            # starts: on Linux, only a program of yours (or the system's) gets the token for it.
            if peer_uid(self.client_address, self.connection.getsockname()) not in (None, 0, os.getuid()):
                raise Refused(403, "This cage belongs to another user of this computer.")
            t = pair(str(self.body(4096).get("code", ""))[:200])
            if not t:
                raise Refused(403, "That link has expired or was already used. Open cage again from its shortcut, or run cage ui.")
            return self.send(200, {"token": t})
        if not self.authed(query):
            return self.send(401, {"error": "open cage from `cage ui` (or the cage shortcut)"})
        return self.api(method, path, query)

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
        if parts == ["chat", "stream"] and method == "GET":
            return self.multi(query)
        if parts == ["activity"] and method == "GET":
            since = query.get("since", ["0"])[0]
            since, now, out = int(since) if since.isdigit() else 0, time.time() * 1000, {}
            for a in query.get("agents", [""])[0].split(","):
                if a not in AGENTS or a in out:
                    continue
                try:
                    with Chat(a, create=False) as c:   # no chat yet: nothing to say (and no folder made for it)
                        act = activity(c, since)
                except OSError:   # none, or not a folder (a link a VM left): nothing the app reads
                    continue
                typing = act.pop("typing")
                act["working"] = bool(typing) and not act["pending"] and now - typing < WORKING * 1000
                out[a] = act
            return self.send(200, {"agents": out})
        if len(parts) == 3 and parts[0] == "chat":
            return self.chat(method, parts[1], parts[2], query)
        if parts == ["check"] and method == "GET":
            env = dict(os.environ)
            env.pop("CAGE_PROTO", None)
            try:
                out = subprocess.run([CAGE, "_check"], capture_output=True, env=env, timeout=60).stdout
            except subprocess.TimeoutExpired:
                raise Refused(504, "Looking at this computer took too long. Try again.")
            return self.send(200, out or b'{"checks": []}')
        if parts == ["jobs"] and method == "GET":
            with Job.lock:
                running = [j for j in Job.jobs.values() if j.title and not j.done]
            return self.send(200, {"jobs": [{"id": j.id, "title": j.title, "args": j.shown, "started": j.started}
                                            for j in sorted(running, key=lambda j: j.started)]})
        if parts == ["jobs"] and method == "POST":
            return self.start(self.body(4 << 20))
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
                    else:   # an answer: a page that opens the job later sees its question was answered (not with what).
                        # That goes first, so it always comes before whatever cage says next (maybe its next question).
                        job.add({"t": "input"})
                        job.write((str(b.get("text", "")).replace("\n", " ") + "\n").encode())
                elif parts[2] == "resize":
                    job.resize(max(20, min(400, int(b["cols"]))), max(5, min(200, int(b["rows"]))))
                elif parts[2] == "cancel":
                    job.cancel()
                else:
                    return self.send(404, {"error": "no such action"})
                return self.send(200, {"ok": True})
        return self.send(404, {"error": "no such endpoint"})

    def start(self, b):
        """POST /api/jobs: a cage command the page runs, checked against what the page does (COMMANDS)."""
        args = b.get("args", [])
        cmd = check_args(args)
        shown, title = args, str(b.get("title") or "")[:120]
        cols = max(20, min(400, int(b.get("cols") or 100)))
        if cmd == "restore":   # a backup's settings run as code here: only cage's own backups folder
            where, f = os.path.realpath(State.backups() or "/nonexistent"), os.path.realpath(args[1])
            if not (f.startswith(where + os.sep) and f.endswith(".cagebackup") and os.path.isfile(f)):
                raise Refused(403, f"The app restores backups from {State.backups() or 'cage’s backups folder'} only. Put the file there first.")
            # cage gets the file that was checked, not the path as sent: that may go through a link a VM can change
            # (in its chat folder, say) while cage waits for the passphrase. No VM can write to the backups folder.
            args = [cmd, f]
        text, text_file = b.get("text"), None
        if text is None and (cmd == "ask" or args == ["mask", "try"]):
            raise Refused(400, "the question goes in \"text\"")
        if text is not None:   # cage reads it from a file: `ask --text-file <f> [agents]`, `mask try --text-file <f>`
            at = 1 if cmd == "ask" and fits("A*", args[1:]) else 2 if args == ["mask", "try"] else 0
            if not at or not isinstance(text, str) or "\0" in text:
                raise Refused(400, "only a question for ask, or text to try the privacy mask on, goes in \"text\"")
            data = text.encode("utf-8")
            if len(data) > (MAX_ASK if cmd == "ask" else MAX_TEXT):
                raise Refused(413, "That question is too long to send." if cmd == "ask" else "That’s too long to send.")
            os.makedirs(JOBS_DIR, mode=0o700, exist_ok=True)
            text_file = os.path.join(JOBS_DIR, secrets.token_hex(8) + ".txt")
            with open(os.open(text_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as fh:
                fh.write(data)
            args = args[:at] + ["--text-file", text_file] + args[at:]
        Job.sweep()
        State.stale()
        try:
            job = Job(args, cols, title, text_file, shown)
        except BaseException:   # cage never started, so nothing else will remove the question
            if text_file:
                try:
                    os.unlink(text_file)
                except OSError:
                    pass
            raise
        return self.send(200, {"id": job.id})

    def chat(self, method, agent, what, query):
        with Chat(agent) as c:
            if what == "history" and method == "GET":
                tail = query.get("tail", [""])[0]
                want = int(tail) if tail.isdigit() else 600000
                size, _ = c.size()
                start = max(0, size - want)
                if start:
                    start = c.line_start(start)
                entries, end = c.read_log(start, 8 << 20)
                older, more = [], start > 0
                if size < want:   # a new log: the end of the one before it too (the VM starts a new one at 8 MB)
                    osize, ino = c.size("log.1.jsonl")
                    ostart = max(0, osize - (want - size))
                    if ostart:
                        ostart = c.line_start(ostart, "log.1.jsonl")
                    older, _ = c.read_log(ostart, 8 << 20, "log.1.jsonl", ino) if osize else ([], 0)
                    more = ostart > 0
                return self.send(200, {"o": end, "entries": [e for _, e in older + entries], "more": more})
            if what == "file" and method == "GET":
                return self.file(c, query.get("p", [""])[0], query.get("dl", [""])[0] == "1")
            if method != "POST":
                return self.send(405, {"error": "method"})
            if what == "upload":
                data = self.read_body(self.length(MAX_FILE, "files can be 25 MB at most"))
                name = safe_name(query.get("name", ["file"])[0])
                rel = c.write_new("files", f"{int(time.time() * 1000)}-{os.urandom(2).hex()}-{name}", data)
                mime = MIME.get(os.path.splitext(name)[1].lower(), "application/octet-stream")
                return self.send(200, {"path": rel, "name": name, "size": len(data), "mime": mime})
            if self.headers.get_content_type() != "application/json":   # as the page sends it: a form elsewhere can't
                raise Refused(415, "send that as JSON")
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
                with Answered.of(c.agent):   # (an answer typed in the chat: see Answered)
                    if session == "you" and answers({"t": "you", "text": text, "files": files}):
                        Answered.sent(c.agent, activity(c, 0)["pending"])
                    rid = c.send({"type": "message", "session": session, "text": text, "files": files})
                return self.send(200, {"id": rid})
            if what == "action":
                action = str(b.get("action", ""))[:512]
                said = {"t": "action", "action": action}
                with Answered.of(c.agent):
                    now = activity(c, 0)["pending"] if session == "you" and ("pending" in b or answers(said)) else None
                    again = now is not None and Answered.last.get(c.agent) == now
                    # From Home, with the approval it showed: only while that's still the one the agent waits for (in the
                    # chat). Answered since (in another window, say), it may be asking something else, which an Allow
                    # from here would say yes to. And nowhere a second answer to one (see Answered).
                    if "pending" in b and (now is None or now != b["pending"]):
                        error = "It isn’t waiting for that any more. Open its chat to see what it’s doing."
                    elif again and ("pending" in b or action.startswith("perm:")):
                        error = "You answered that already."
                    else:
                        error = None
                        if answers(said):
                            Answered.sent(c.agent, now)
                        rid = c.send({"type": "action", "session": session, "action": action, "label": str(b.get("label", ""))[:200]})
                return self.send(409, {"error": error}) if error else self.send(200, {"id": rid})
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
                # (no answer is an answer too: Home asks every minute, and a page shows each failed request as an error)
                return self.send(200, Usage.get(c, b.get("fresh") is True) or {"error": "It didn’t answer. Is it awake?"})
        return self.send(404, {"error": "no such endpoint"})

    def events_head(self):
        self.head(200, [("Content-Type", "text/event-stream"), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
                        ("Referrer-Policy", "no-referrer"), ("X-Accel-Buffering", "no")])   # (as send() answers)
        self.close_connection = True

    def multi(self, query):
        """New lines in each agent's chat log, as they're written."""
        chats, pos, ino, seen = {}, {}, {}, {}
        try:
            for item in query.get("from", [""])[0].split(","):
                a, _, rest = item.partition(":")
                o, _, was = rest.partition(":")
                if a in AGENTS and a not in chats:
                    chats[a] = Chat(a)
                    size, ino[a] = chats[a].size()
                    pos[a] = int(o) if o.isdigit() and int(o) <= size else size
                    if o.isdigit() and was.isdigit() and int(was) != ino[a]:
                        # Read up to there in a log the VM has replaced since (the page was closed, say): the rest
                        # of that one, if it's still the one before (log.1.jsonl), then this one from its start, as
                        # when it's replaced while the page looks (below). Its offsets mean nothing in this one.
                        ino[a], pos[a] = int(was), int(o)
            self.events_head()
            self.wfile.write(b": hello\n\n")
            for a in chats:   # where each one starts (the end, unless the page asked for more): what it has seen so far
                self.wfile.write(b"data: " + json.dumps({"a": a, "o": pos[a], "start": True, "ino": str(ino[a])}).encode() + b"\n\n")
            self.wfile.flush()
            quiet = 0.0
            while True:
                sent = False
                for a, c in chats.items():
                    size, now = c.size()
                    if (size, now) == seen.get(a):
                        continue   # nothing new since the last look
                    out = []
                    if now != ino[a] or size < pos[a]:   # the VM started a new log: the rest of the old one first
                        if now != ino[a]:
                            old, _ = c.read_log(pos[a], name="log.1.jsonl", ino=ino[a])
                            out = [{"a": a, "o": o, "e": e} for o, e in old]
                        out.append({"a": a, "reset": True, "o": 0, "ino": str(now)})   # (as a string: it may not fit a JS number)
                        ino[a], pos[a] = now, 0
                    was = pos[a]
                    entries, pos[a] = c.read_log(pos[a])
                    # read again only once it changes, unless the window held only part of what's there
                    seen[a] = (size, now) if pos[a] in (was, size) else None
                    for msg in out + [{"a": a, "o": o, "e": e} for o, e in entries]:
                        self.wfile.write(b"data: " + json.dumps(msg).encode() + b"\n\n")
                        sent = True
                if sent:
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
        finally:
            for c in chats.values():
                c.close()

    def file(self, c, rel, download):
        if not re.fullmatch(r"files/[^/]+", rel):
            return self.send(404, {"error": "no such file"})
        try:
            fd = c.open_file(rel)
        except OSError:   # missing, a link, not a folder: nothing the app will touch
            return self.send(404, {"error": "no such file"})
        with os.fdopen(fd, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            if size > MAX_FILE:
                return self.send(413, {"error": "This file is bigger than 25 MB"})
            name = shown_name(rel.split("/", 1)[1])
            ext = os.path.splitext(name)[1].lower()
            if ext in PICTURES and not download:   # only pictures are shown here; anything else could be a page
                kind = [("Content-Type", PICTURES[ext])]
            else:
                kind = [("Content-Type", "application/octet-stream"), ("Content-Disposition", disposition(name))]
            self.head(200, kind + [("Content-Length", str(size)), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
                                   ("Referrer-Policy", "no-referrer"), ("Content-Security-Policy", "default-src 'none'")])
            left = size   # the VM may still be writing it: send what was promised, no more
            while left:
                chunk = f.read(min(left, 64 << 10))
                if not chunk:
                    self.close_connection = True   # it got shorter; the browser sees an unfinished download
                    return
                self.wfile.write(chunk)
                left -= len(chunk)

    def stream(self, job, n):
        last = self.headers.get("Last-Event-ID", "")
        if last.isdigit():   # the browser reconnecting (after a laptop's sleep, say): on from there, nothing twice
            n = int(last) + 1
        self.events_head()
        job.watch(True)
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
                    self.wfile.write(b"id: %d\ndata: " % ev["n"] + json.dumps(ev).encode() + b"\n\n")
                    n = ev["n"] + 1
                self.wfile.flush()
                if batch[-1]["t"] == "exit":
                    State.stale()
                    return
        except (BrokenPipeError, ConnectionResetError):
            return
        finally:
            job.watch(False)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def restart_when_updated():
    """`cage update` replaces this file: start the new one once nothing is running (the page reconnects). A release
    unpacks every file with the same date, so a new file is told apart by its inode and size too. Logs and terminals
    don't hold it up: they're stopped (the page can open them again)."""
    me = os.path.abspath(__file__)

    def mark():
        st = os.stat(me)
        return st.st_ino, st.st_mtime, st.st_size
    try:
        born = mark()
    except OSError:
        return
    while True:
        time.sleep(3)
        Job.sweep()
        try:
            changed = mark() != born
        except OSError:
            continue
        if not changed:
            continue
        with Job.lock:
            running = [j for j in Job.jobs.values() if not j.done]
        if any(j.args[0] not in Job.VIEWERS for j in running):
            continue
        for j in running:
            j.cancel()
        os.execv(sys.executable, [sys.executable, me] + sys.argv[1:])


def write_pid():
    """~/.cage/ui.pid: which process is cage's web app (for `cage ui` and the tests)."""
    tmp = os.path.join(HOME, f"ui.pid.{os.getpid()}")
    try:
        with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            f.write(f"{os.getpid()}\n")
        os.replace(tmp, os.path.join(HOME, "ui.pid"))
    except OSError:
        pass


if __name__ == "__main__":
    # A session (and process group) of its own, as `cage ui` gives it with setsid where there is one. A Mac has none,
    # and its start at login (launchd) stops what's left in the process group of the command it ran once that ends.
    try:
        os.setsid()
    except OSError:
        pass   # it has one already
    server = Server(("127.0.0.1", PORT), Handler)
    write_pid()
    forget_questions(time.time())
    threading.Thread(target=restart_when_updated, daemon=True).start()
    server.serve_forever()
