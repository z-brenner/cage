#!/usr/bin/env python3
"""Unit tests for the web app's server (host/ui/server.py): the parts that decide what a request or a file becomes,
without a browser or `cage ui`, and (Live) the routes Home uses, asked over HTTP of the real handler on a port of its
own. test/ui.sh tests the server `cage ui` starts.

  python3 test/server_test.py
"""
import atexit, contextlib, http.client, importlib.util, io, json, os, secrets, shutil, signal, socket, struct, sys, tempfile, threading, time
import unittest

HOME = tempfile.mkdtemp()
atexit.register(shutil.rmtree, HOME, True)
os.environ["CAGE_HOME"] = HOME
spec = importlib.util.spec_from_file_location("server", os.path.join(os.path.dirname(__file__), "..", "host", "ui", "server.py"))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
# msb, which the server asks which VMs are running (an answer to an approval goes only to an agent whose VM is): this
# one says the VMs in RUNNING are (every agent's, but where a test says otherwise), and fails when there's no such file
RUNNING, MSB = os.path.join(HOME, "running"), os.path.join(HOME, "msb")
EVERY_VM = "".join(f"cage-{a}\n" for a in server.AGENTS)
with open(MSB, "w") as f:
    f.write('#!/bin/sh\n[ "$*" = "ps -q --label app=cage" ] && exec cat "%s"\nexit 2\n' % RUNNING)
os.chmod(MSB, 0o755)
os.environ["CAGE_MSB"] = MSB
with open(RUNNING, "w") as f:
    f.write(EVERY_VM)


class Names(unittest.TestCase):
    def test_safe_name(self):
        self.assertEqual(server.safe_name("../../etc/passwd"), "passwd")
        self.assertEqual(server.safe_name(".bashrc"), "bashrc")
        self.assertEqual(server.safe_name(""), "file")
        self.assertEqual(server.safe_name(None), "file")
        self.assertEqual(server.safe_name("a;b|c.txt"), "a_b_c.txt")
        self.assertEqual(server.safe_name("отчёт 報告.pdf"), "отчёт 報告.pdf")
        self.assertEqual(len(server.safe_name("x" * 300 + ".txt")), 120)

    def test_shown_name(self):
        """A chat file's name without the "<time>-<random>-" that keeps names apart in files/, exactly once."""
        self.assertEqual(server.shown_name("1791184190403-ab12-q3-results.xlsx"), "q3-results.xlsx")
        self.assertEqual(server.shown_name("1791184190403-k3x9-2024-budget.xlsx"), "2024-budget.xlsx")
        self.assertEqual(server.shown_name("1791184190403-ab12-1791184190403-cd34-x.txt"), "1791184190403-cd34-x.txt")
        self.assertEqual(server.shown_name("my-notes.md"), "my-notes.md")
        self.assertEqual(server.shown_name("1791184190403-ab12-"), "1791184190403-ab12-")

    def test_disposition(self):
        """Headers can only carry Latin-1: filename= gets a plain-ASCII stand-in, filename* the real name."""
        for name in ("отчёт 報告.pdf", "报告.pdf", "Łódź.txt", "naïve café.md", "plain.txt", "‮txt.exe"):
            d = server.disposition(name)
            d.encode("latin-1")   # the header can be sent at all
            self.assertTrue(d.isascii(), d)
            self.assertTrue(d.startswith('attachment; filename="'), d)
            fallback = d.split('"')[1]
            self.assertTrue(fallback and '"' not in fallback and "/" not in fallback, d)
            self.assertIn("filename*=UTF-8''", d)
        self.assertIn('filename="file.pdf"', server.disposition("报告.pdf"))
        self.assertIn('filename="Lodz.txt"', server.disposition("Łódź.txt"))
        self.assertIn('filename="naive cafe.md"', server.disposition("naïve café.md"))
        self.assertIn("filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20%E5%A0%B1%E5%91%8A.pdf", server.disposition("отчёт 報告.pdf"))


class FakeHandler(server.Handler):
    """Just enough of a request for Handler.length(), Handler.body() and Handler.route(); what it would answer goes
    in .answers."""
    def __init__(self, headers, body=b""):
        self.headers, self.rfile, self.answers = headers, body if hasattr(body, "read") else io.BytesIO(body), []

        class Conn:
            def settimeout(self, t):
                pass
        self.connection = Conn()

    def send(self, status, body=b"", ctype="application/json", extra=None):
        self.answers.append((status, body))


class Requests(unittest.TestCase):
    def refused(self, status, headers, body=b"", limit=100):
        with self.assertRaises(server.Refused) as e:
            FakeHandler(headers, body).body(limit)
        self.assertEqual(e.exception.status, status)

    def test_length(self):
        self.assertEqual(FakeHandler({"Content-Length": "12"}).length(100), 12)
        self.assertEqual(FakeHandler({"Content-Length": "0"}).length(100), 0)
        for headers, status in (({}, 411), ({"Content-Length": "-1"}, 400), ({"Content-Length": "1e3"}, 400), ({"Content-Length": " "}, 400),
                                ({"Content-Length": "101"}, 413), ({"Transfer-Encoding": "chunked"}, 411)):
            with self.assertRaises(server.Refused) as e:
                FakeHandler(headers).length(100)
            self.assertEqual(e.exception.status, status, headers)

    def test_body(self):
        self.assertEqual(FakeHandler({"Content-Length": "8"}, b'{"a": 1}').body(), {"a": 1})
        self.refused(400, {"Content-Length": "2"}, b"[]")
        self.refused(400, {"Content-Length": "4"}, b'"hi"')
        self.refused(400, {"Content-Length": "3"}, b"{no")
        self.refused(400, {"Content-Length": "9"}, b"{}")   # cut short
        self.refused(413, {"Content-Length": "500"}, b"{}" * 250)

    def test_a_body_that_never_comes(self):
        """A client that says how big its body is, then stalls, gets 408 (after 30 seconds), not a thread for ever."""
        class Stalled:
            def read(self, n):
                raise socket.timeout("timed out")
        self.refused(408, {"Content-Length": "8"}, Stalled())

    def test_a_bug_still_gets_an_answer(self):
        """Something unexpected going wrong answers the page in JSON (500), not with a dropped connection."""
        h = FakeHandler({})
        h.path = "/api/state"

        def broken(method):
            raise RuntimeError("a bug")
        h.dispatch = broken
        with contextlib.redirect_stderr(io.StringIO()) as log:
            h.route("GET")
        self.assertEqual(h.answers, [(500, {"error": "something went wrong in cage's web app"})])
        self.assertIn("RuntimeError('a bug')", log.getvalue())   # the details go to the log (ui.log)


class Arguments(unittest.TestCase):
    def ok(self, *args):
        self.assertEqual(server.check_args(list(args)), args[0])

    def no(self, status, *args):
        with self.assertRaises(server.Refused) as e:
            server.check_args(list(args))
        self.assertEqual(e.exception.status, status, args)

    def test_what_the_page_runs(self):
        self.ok("up")
        self.ok("up", "claude", "codex")
        self.ok("add", "--no-login", "codex")
        self.ok("connect", "add", "crm", "https://crm.example/mcp", "claude")
        self.ok("allow", "*.example.com", "all")
        self.ok("allow", "rm", "api.example.com", "claude")
        self.ok("mask", "try")
        self.ok("ask", "claude", "codex")
        self.ok("restore", "/home/me/cage-backups/cage-1.cagebackup")
        self.ok("memory")

    def test_nothing_else(self):
        for cmd in ("destroy", "status", "version", "onboard", "", "_state", "init", "uninstall"):
            self.no(403, cmd)
        self.no(403, "destroy", "claude", "--yes")
        self.no(403, "up", "nobody")
        self.no(403, "up", "--refresh")
        self.no(403, "login", "claude", "codex")
        self.no(403, "add", "--yes", "claude")
        self.no(403, "secret", "add", "--force", "x.example")
        self.no(403, "ask", "what is this?", "claude")   # a question goes in "text", not on cage's command line
        self.no(400, "up", 1)
        self.no(400)
        self.no(400, "up\0")
        self.no(413, "mask", "add", "x" * (server.MAX_ARG + 1))


class Jobs(unittest.TestCase):
    """What the server keeps of a job, and when it lets go of one (without running cage)."""
    def bare(self, **kw):
        j = server.Job.__new__(server.Job)   # a job's bookkeeping, without a command behind it
        j.events, j.sizes, j.size, j.first, j.cond = [], [], 0, 0, threading.Condition()
        j.__dict__.update(kw)
        return j

    def test_output_is_capped_by_size(self):
        """A long `cage logs` keeps its newest 8 MB (here 1000 bytes), numbered on without a gap."""
        j = self.bare(MAX_BYTES=1000)
        for i in range(500):
            j.add({"t": "raw", "data": "x" * (i % 40)})
        self.assertLessEqual(j.size, 1000)
        self.assertEqual(j.size, sum(len(json.dumps(e)) for e in j.events))
        self.assertEqual([e["n"] for e in j.events], list(range(j.first, 500)))
        self.assertGreater(j.first, 0)
        j.add({"t": "raw", "data": "y" * 5000})   # one line bigger than all of it is still kept
        self.assertEqual(j.events[-1]["data"], "y" * 5000)

    def test_sweep(self):
        """Ended jobs are forgotten 10 minutes after they ended; a log or terminal nobody watched for 2 minutes stops."""
        now, stopped = time.time(), []

        def job(args, **kw):
            j = self.bare(args=args, done=False, ended=0.0, cancelled=0.0, watchers=0, unwatched=now)
            j.__dict__.update(kw)
            j.cancel = lambda sig=signal.SIGTERM: stopped.append((args[0], sig))
            return j
        jobs = {"old": job(["up"], done=True, ended=now - 700), "recent": job(["up"], done=True, ended=now - 60),
                "long": job(["update"], unwatched=now - 3600), "log": job(["logs", "claude"], unwatched=now - 130),
                "watched": job(["shell", "claude"], watchers=1, unwatched=now - 3600), "fresh": job(["logs", "codex"], unwatched=now - 30),
                "stuck": job(["up"], cancelled=now - 20)}
        saved, server.Job.jobs = server.Job.jobs, jobs
        try:
            server.Job.sweep()
        finally:
            server.Job.jobs = saved
        self.assertEqual(sorted(jobs), ["fresh", "log", "long", "recent", "stuck", "watched"])
        self.assertEqual(sorted(stopped), [("logs", signal.SIGTERM), ("up", signal.SIGKILL)])


class SlowState(unittest.TestCase):
    """`cage _state` can be slow (just after the computer wakes up): the page gets the last answer, marked stale, or,
    with none yet, a 504 in words, instead of waiting for ever."""
    def setUp(self):
        self.stub, self.slow = os.path.join(HOME, "cage-stub"), os.path.join(HOME, "slow")
        with open(self.stub, "w") as f:
            f.write('#!/bin/sh\nif [ -e "%s" ]; then sleep 5; fi\necho \'{"version": "v1"}\'\n' % self.slow)
        os.chmod(self.stub, 0o755)
        self.saved = server.CAGE, server.State.TIMEOUT
        server.CAGE, server.State.TIMEOUT = self.stub, 0.5
        server.State.at, server.State.body, server.State.ok = 0.0, b"{}", False

    def tearDown(self):
        server.CAGE, server.State.TIMEOUT = self.saved
        server.State.at, server.State.body, server.State.ok = 0.0, b"{}", False
        if os.path.exists(self.slow):
            os.unlink(self.slow)

    def test_slow(self):
        open(self.slow, "w").close()
        with self.assertRaises(server.Refused) as e:   # nothing to show yet
            server.State.get()
        self.assertEqual((e.exception.status, e.exception.error), (504, "cage is taking too long to answer"))
        os.unlink(self.slow)
        server.State.stale()
        self.assertEqual(json.loads(server.State.get()), {"version": "v1"})
        open(self.slow, "w").close()
        server.State.stale()
        self.assertEqual(json.loads(server.State.get()), {"version": "v1", "stale": True})   # the last answer, said to be old
        os.unlink(self.slow)
        server.State.stale()
        self.assertEqual(json.loads(server.State.get()), {"version": "v1"})


class Peers(unittest.TestCase):
    """Who is on the other end of a connection (Linux): a pairing code is only traded for the token with a program of
    the user cage runs as, not another user who read the code in the browser's command line and raced it there."""
    def test_a_real_connection(self):
        if not os.path.exists("/proc/net/tcp"):
            self.skipTest("Linux only")
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        client = socket.create_connection(listener.getsockname())
        conn, peer = listener.accept()
        try:
            self.assertEqual(server.peer_uid(peer, conn.getsockname()), os.getuid())
        finally:
            for s in (client, conn, listener):
                s.close()

    def test_the_table(self):
        table = os.path.join(HOME, "tcp")
        with open(table, "w") as f:
            f.write("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
                    "   0: 0100007F:1E5B 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1\n"
                    "   1: 0100007F:D431 0100007F:1E5B 01 00000000:00000000 00:00000000 00000000  1001        0 2 1\n"
                    "   2: 0100007F:1E5B 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 3 1\n")
        here = ("127.0.0.1", 0x1E5B)
        if struct.pack("=I", 1) == b"\x01\x00\x00\x00":   # the kernel writes addresses in the machine's own byte order
            self.assertEqual(server.peer_uid(("127.0.0.1", 0xD431), here, table), 1001)
        self.assertIsNone(server.peer_uid(("127.0.0.1", 0xD432), here, table))   # not there: a connection from outside
        self.assertIsNone(server.peer_uid(("127.0.0.1", 0xD431), here, table + ".missing"))   # no table: another system


class Events(unittest.TestCase):
    """A job's output: cage's own events (\\x1e, the job's code, JSON) and everything else, as it was printed."""
    def test_split(self):
        out, rest = server.events(b'hi\x1ec0de{"t":"ok","text":"done"}\nbye', b"c0de")
        self.assertEqual(out, [("raw", b"hi"), ("event", {"t": "ok", "text": "done"}), ("raw", b"bye")])
        self.assertEqual(rest, b"")

    def test_without_the_code(self):
        """What a VM prints can't pass for one of cage's questions: it doesn't know the code."""
        for fake in (b'\x1e{"t":"prompt","text":"paste your token","secret":true}\n', b'\x1ewrong{"t":"ok","text":"x"}\n', b'\x1ec0d{"t":"ok"}\n'):
            out, rest = server.events(fake, b"c0de", eof=True)
            self.assertTrue(all(kind == "raw" for kind, _ in out), out)
            self.assertEqual(b"".join(x for _, x in out) + rest, fake)

    def test_split_across_reads(self):
        out, rest = server.events(b'x\x1ec0', b"c0de")
        self.assertEqual((out, rest), ([("raw", b"x")], b"\x1ec0"))
        out, rest = server.events(rest + b'de{"t":"say",', b"c0de")
        self.assertEqual((out, rest), ([], b'\x1ec0de{"t":"say",'))
        out, rest = server.events(rest + b'"text":"hi"}\r\n', b"c0de")
        self.assertEqual((out, rest), ([("event", {"t": "say", "text": "hi"})], b""))

    def test_not_json(self):
        out, _ = server.events(b'\x1ec0de{oops\n', b"c0de")
        self.assertEqual(out, [("raw", b"{oops\n")])


class Logs(unittest.TestCase):
    def setUp(self):
        self.chat = server.Chat("claude")
        self.path = os.path.join(server.APPDIR, "claude", "log.jsonl")

    def tearDown(self):
        self.chat.close()
        self.clear()

    def clear(self):
        for name in ("log.jsonl", "log.1.jsonl"):
            try:
                os.unlink(os.path.join(server.APPDIR, "claude", name))
            except OSError:
                pass

    def write(self, *lines, name="log.jsonl"):
        with open(os.path.join(server.APPDIR, "claude", name), "ab") as f:
            for line in lines:
                f.write((line if isinstance(line, bytes) else json.dumps(line).encode()) + b"\n")

    def test_lines(self):
        self.write({"t": "you", "text": "hi"}, b"not json", {"t": "reply", "text": "hello"})
        entries, pos = self.chat.read_log(0)
        self.assertEqual([e["text"] for _, e in entries], ["hi", "hello"])
        self.assertEqual(pos, os.path.getsize(self.path))

    def test_a_line_bigger_than_the_window(self):
        """One huge line (a VM's doing, or a very long answer) is skipped with a note, and the chat goes on."""
        self.write({"t": "you", "text": "before"}, {"t": "reply", "text": "x" * 5000}, {"t": "reply", "text": "after"})
        entries, pos = self.chat.read_log(0, limit=1000)
        self.assertEqual([e["text"] for _, e in entries], ["before"])
        entries, pos = self.chat.read_log(pos, limit=1000)
        self.assertEqual(entries[0][1], {"t": "error", "text": server.TOO_BIG})
        entries, pos = self.chat.read_log(pos, limit=1000)
        self.assertEqual([e["text"] for _, e in entries], ["after"])
        self.assertEqual(pos, os.path.getsize(self.path))

    def test_a_line_still_being_written(self):
        self.write({"t": "you", "text": "whole"})
        with open(self.path, "ab") as f:
            f.write(b'{"t": "reply", "te')
        entries, pos = self.chat.read_log(0)
        self.assertEqual([e["text"] for _, e in entries], ["whole"])
        self.assertEqual(self.chat.read_log(pos), ([], pos))
        with open(self.path, "ab") as f:
            f.write(b"x" * 3000)
        self.assertEqual(self.chat.read_log(pos, limit=1000), ([], pos))   # too big, but not finished: wait for it

    def test_the_log_before(self):
        """The VM starts a new log at 8 MB; the end of the one before is still there (log.1.jsonl)."""
        self.write({"t": "you", "text": "old"}, name="log.1.jsonl")
        size, ino = self.chat.size("log.1.jsonl")
        self.assertEqual(self.chat.read_log(0, name="log.1.jsonl", ino=ino)[0][0][1]["text"], "old")
        self.assertEqual(self.chat.read_log(0, name="log.1.jsonl", ino=ino + 1), ([], 0))   # another file by now


class Activity(unittest.TestCase):
    """What Home shows of each agent, from the end of its chat log."""
    setUp, tearDown, clear, write = Logs.setUp, Logs.tearDown, Logs.clear, Logs.write
    PERM = [[{"text": "Allow", "data": "perm:allow"}, {"text": "Deny", "data": "perm:deny"}]]

    def test_waiting_for_you(self):
        self.write({"t": "you", "text": "email bob", "at": 5}, {"t": "typing", "on": True, "at": 6},
                   {"t": "buttons", "text": "May I?", "buttons": self.PERM, "at": 7},
                   {"t": "buttons", "session": "usage", "text": "not here", "buttons": self.PERM, "at": 8},
                   {"t": "buttons", "text": "Which one?", "buttons": [[{"text": "A", "data": "a"}]], "at": 9})
        a = server.activity(self.chat, 0)
        self.assertEqual(a["pending"], {"text": "May I?", "at": 7})   # a question that isn't asking first doesn't count
        self.assertIsNone(a["typing"])   # it asked: it isn't working on anything while it waits
        self.assertEqual(a["today"], {"asked": 1, "answers": 0, "files": 0})

    def test_answered(self):
        """As cc-connect reads it: a perm: button, a message with "yes", "no" or "allow all" in it (or their Chinese),
        a command that ends the turn or starts its session afresh, or cc-connect restarted (it forgets what it waited
        for, and the relay registers with it again, unless it says it's the same one); anything else, and the approval
        still waits."""
        for after in ({"t": "action", "action": "perm:deny"}, {"t": "you", "text": "no, wait"}, {"t": "you", "text": "OK, send it."},
                      {"t": "you", "text": "@bot allow all"}, {"t": "you", "text": "好的"}, {"t": "you", "text": "/stop"},
                      {"t": "you", "text": "/new client call"}, {"t": "action", "action": "act:/stop"},
                      {"t": "status", "connected": True}, {"t": "status", "connected": True, "same": "yes"},
                      {"t": "you", "text": "/model opus"}, {"t": "you", "text": "/cd ~/other"},
                      {"t": "you", "text": "/provider switch work"}, {"t": "action", "action": "cmd:/reasoning high"}):
            self.write({"t": "buttons", "text": "May I?", "buttons": self.PERM, "at": 7}, dict(after, at=8))
            self.assertIsNone(server.activity(self.chat, 0)["pending"], after)
        for after in ({"t": "you", "text": "What's in the email?"}, {"t": "you", "text": "know what? not now", "files": [{"name": "a.pdf"}]},
                      {"t": "you", "text": "/help"}, {"t": "you", "text": "/reset"}, {"t": "action", "action": "nav:/help"},
                      {"t": "you", "text": ["no"]}, {"t": "you"}, {"t": "reply", "text": "⚠️ Waiting for permission response."},
                      {"t": "status", "connected": False}, {"t": "status", "connected": "yes"}, {"t": "you", "text": "/model"},
                      {"t": "status", "connected": True, "same": True},   # (the same cc-connect: only the relay restarted)
                      {"t": "you", "text": "/provider list"},
                      {"t": "you", "text": "/stop", "files": [{"name": "a.png", "mime": "image/png"}]}):   # (with a picture: no command)
            self.write({"t": "buttons", "text": "May I?", "buttons": self.PERM, "at": 7}, dict(after, at=8))
            self.assertEqual(server.activity(self.chat, 0)["pending"], {"text": "May I?", "at": 7}, after)

    def test_commands_as_cc_connect_reads_them(self):
        """cc-connect runs a command by the start of its name when just one of its commands has a name that starts so
        ("/sto" is /stop, "/rea" /reasoning, "/ch" /dir as chdir), and a "/" message that names none of its commands
        is a message to it, an answer when it has an answer word in it ("/x yes"). /mode told a mode, and a card's
        act: button that switches something, start the agent's session afresh: those end the wait (as cc-connect
        v1.5.1-beta.3 does, each one tried against it: then a "yes" answers nothing). Those that leave it waiting
        don't: a command that only shows something, or is told nothing, or names more than one ("/c")."""
        for after in ("/sto", "/ne", "/ca", "/canc", "/rea high", "/eff low", "/ch /tmp", "/x yes", "/ yes", "/foo ok", "/c yes",
                      "/x 'yes'", "/mode plan", "/mode default", "/STOP", "/stop please", "/new now", '/"stop"', "/d\u0130r /tmp",
                      "/provider work", "/provider sw work", "/upgrade confirm", "/restart", "act:/mode default", "act:/mode plan",
                      "act:/new", "act:/stop", "act:/model switch 2", "act:/reasoning 2", "act:/provider clear", "act:/switch 3",
                      "act:/dir select 2", "cmd:/sto", "cmd:/mode plan", "cmd:yes", "askq:yes"):
            line = {"t": "action", "action": after} if after.split(":")[0] in ("act", "cmd", "askq") else {"t": "you", "text": after}
            self.write({"t": "buttons", "text": "May I?", "buttons": self.PERM, "at": 7}, dict(line, at=8))
            self.assertIsNone(server.activity(self.chat, 0)["pending"], after)
            self.assertTrue(server.ends(line), after)
        for after in ("What does it do?", "/help", "/compact", "/c", "/sw", "/model", "/mode", "/provider list", "/provider l",
                      "/provider switch", "/upgrade", "/upgrade check", "/dir help", "/ps yes", "/all yes", "/stop\nplease", "/yes",
                      "act:/mode", "act:/lang en", "act:/heartbeat pause", "act:/STOP", "nav:/mode", "nav:/new", "cmd:/help",
                      "askq:0:1"):
            line = {"t": "action", "action": after} if after.split(":")[0] in ("act", "cmd", "askq", "nav") else {"t": "you", "text": after}
            self.write({"t": "buttons", "text": "May I?", "buttons": self.PERM, "at": 7}, dict(line, at=8))
            self.assertEqual(server.activity(self.chat, 0)["pending"], {"text": "May I?", "at": 7}, after)
            self.assertFalse(server.ends(line), after)

    # the agent's question (AskUserQuestion) as cc-connect v1.5.1-beta.3 sends it to the app
    QUESTION = {"t": "card", "card": {"header": {"color": "blue", "title": "Agent Question"}, "elements": [
        {"type": "markdown", "content": "**Which branch should I push to?**"},
        {"type": "list_item", "text": "main — production", "btn_text": "main", "btn_type": "default", "btn_value": "askq:0:1"},
        {"type": "list_item", "text": "dev — staging", "btn_text": "dev", "btn_type": "default", "btn_value": "askq:0:2"},
        {"type": "note", "text": "If buttons are unresponsive, reply with the option number (e.g. 1) or type your answer"}]}}

    def test_a_question_ends_the_wait(self):
        """cc-connect asks one thing at a time: once the agent asks a question, the approval asked before it isn't
        waited for any more (and an Allow would be that question's answer, "allow"). A question you may pick several
        answers to has no buttons, only cc-connect's title for it, in any of its languages; another card (/help's) is
        no question."""
        multi = {"t": "card", "card": {"header": {"title": "Agent 提问 (1/2)"}, "elements": [{"type": "markdown", "content": "**Which?**"}]}}
        buttons = {"t": "buttons", "text": "Which?", "buttons": [[{"text": "main", "data": "askq:0:1"}]]}
        for question in (self.QUESTION, multi, buttons):
            self.write({"t": "buttons", "text": "May I?", "buttons": self.PERM, "at": 7}, dict(question, at=8))
            self.assertIsNone(server.activity(self.chat, 0)["pending"], question)
            self.assertTrue(server.ends(question), question)
        for card in ({"t": "card", "card": {"header": {"title": "Help"}, "elements": [{"type": "actions", "buttons": [{"text": "Stop", "value": "act:/stop"}]}]}},
                     {"t": "card", "card": {"header": {"title": "Agent Question (1/2) about it"}}}, {"t": "card", "card": {"elements": "askq:0:1"}},
                     {"t": "reply", "text": "askq:0:1"}):
            self.write({"t": "buttons", "text": "May I?", "buttons": self.PERM, "at": 7}, dict(card, at=8))
            self.assertEqual(server.activity(self.chat, 0)["pending"], {"text": "May I?", "at": 7}, card)
            self.assertFalse(server.ends(card), card)

    def test_working_and_last(self):
        self.write({"t": "you", "text": "hi", "at": 1}, {"t": "reply", "text": "hello", "at": 2},
                   {"t": "card", "card": {"header": {"title": "Usage"}}, "at": 3}, {"t": "file", "name": "a.md", "at": 4},
                   {"t": "you", "text": "more", "at": 5}, {"t": "typing", "on": True, "at": 6})
        a = server.activity(self.chat, 3)
        self.assertEqual((a["typing"], a["last"]), (6, {"t": "file", "text": "a.md", "at": 4}))
        self.assertEqual(a["today"], {"asked": 1, "answers": 0, "files": 1})   # from 3 on
        self.write({"t": "reply", "text": "**Done**", "at": 7})
        a = server.activity(self.chat, 0)
        self.assertEqual((a["typing"], a["last"]["text"]), (None, "**Done**"))

    def test_what_a_vm_could_write(self):
        """The VM writes the log: odd values are read as nothing, never as an error."""
        self.write({"t": "buttons", "text": None, "buttons": "perm:allow", "at": "soon"}, {"t": "buttons", "buttons": [None, ["x"], [{"data": 1}]]},
                   {"t": "reply", "text": ["a"], "at": True}, {"t": "card", "card": "x"}, {"t": "typing", "on": "yes", "at": 1}, [1, 2])
        a = server.activity(self.chat, 0)
        self.assertEqual((a["pending"], a["typing"], a["last"]), (None, None, {"t": "card", "text": "", "at": 0}))
        self.assertEqual(a["today"], {"asked": 0, "answers": 1, "files": 0})
        # times a browser can't read (json writes Infinity and NaN, which aren't JSON) or that make no sense: none
        self.write({"t": "buttons", "text": "May I?", "buttons": Activity.PERM, "at": float("inf")}, {"t": "typing", "on": True, "at": float("nan")},
                   {"t": "reply", "text": "hi", "at": float("-inf")}, b'{"t": "file", "name": "a.md", "at": 1e400}', {"t": "card", "at": 10 ** 400})
        a = server.activity(self.chat, 0)
        self.assertEqual((a["pending"]["at"], a["typing"], a["last"]["at"]), (0, None, 0))
        json.dumps(a, allow_nan=False)   # (no Infinity or NaN left in what goes to the page)

    def test_only_the_end(self):
        """Only the end of a long log is read, from the start of a whole line."""
        self.write({"t": "buttons", "text": "long ago", "buttons": self.PERM, "at": 1}, *[{"t": "reply", "text": "x" * 1000, "at": 2}] * 600)
        a = server.activity(self.chat, 0)
        self.assertIsNone(a["pending"])
        self.assertLess(a["today"]["answers"], 600)

    def test_after_a_new_log(self):
        """The VM starts a new log at 8 MB, while an approval may wait: what's said after it in the new one (or nothing
        yet) leaves it waiting, as the chat shows it, and an answer there ends the wait. Only while the new log is
        shorter than what Home reads of the end."""
        for after, waits in (([], True), ([{"t": "you", "text": "What does it delete?", "at": 9}], True), ([{"t": "you", "text": "yes", "at": 9}], False)):
            self.write(*[{"t": "reply", "text": "x" * 1000, "at": 2}] * 100, {"t": "buttons", "text": "May I?", "buttons": self.PERM, "at": 7}, name="log.1.jsonl")
            self.write(*after)
            a = server.activity(self.chat, 0)
            self.assertEqual(a["pending"], {"text": "May I?", "at": 7} if waits else None, after)
            self.clear()
        self.write({"t": "buttons", "text": "May I?", "buttons": self.PERM, "at": 7}, {"t": "you", "text": "no", "at": 8}, name="log.1.jsonl")
        self.assertIsNone(server.activity(self.chat, 0)["pending"])   # (answered before the new log)
        self.clear()
        self.write({"t": "buttons", "text": "long ago", "buttons": self.PERM, "at": 1}, name="log.1.jsonl")
        self.write(*[{"t": "reply", "text": "x" * 1000, "at": 2}] * 600)
        self.assertIsNone(server.activity(self.chat, 0)["pending"])   # (the new log is long enough: the one before isn't read)

    def test_a_link_is_not_read(self):
        other = os.path.join(HOME, "elsewhere.jsonl")
        with open(other, "w") as f:
            f.write(json.dumps({"t": "buttons", "text": "May I?", "buttons": self.PERM}) + "\n")
        os.symlink(other, self.path)
        self.assertIsNone(server.activity(self.chat, 0)["pending"])
        with self.assertRaises(FileNotFoundError):   # and no chat folder is made for an agent that has none
            server.Chat("antigravity", create=False)
        self.assertFalse(os.path.exists(os.path.join(server.APPDIR, "antigravity")))


class Usages(unittest.TestCase):
    """Plan usage on Home costs a question to the AI company: asked at most every 10 minutes (30 seconds when you ask
    again), never sooner after no answer (a late one is looked for instead), and the last good answer is kept for when
    a later one isn't."""
    CARD = {"t": "card", "card": {"elements": [{"type": "markdown", "content": "5h limit\nRemaining: 58%\nResets: 2h 13m"}]}}

    def setUp(self):
        server.Usage.last.clear()
        server.Usage.good.clear()
        self.asked, self.answers, self.late, self.untaken = 0, [], {}, False
        server.Usage.ask, server.Usage.look = staticmethod(self.answer), staticmethod(self.look)
        test = self

        class Chat:
            agent = "claude"

            def waiting(self, rid):
                return test.untaken and rid == f"q{test.asked}"
        self.chat = Chat()

    def tearDown(self):
        server.Usage.ask, server.Usage.look = staticmethod(server.ask_usage), staticmethod(server.usage_answer)

    def answer(self, c):
        self.asked += 1
        return {"rid": f"q{self.asked}", "pos": 0, "entry": self.answers.pop(0)}

    def look(self, c, q):   # an answer that came after all
        q["entry"] = self.late.get(q["rid"])
        return q["entry"]

    def older(self, seconds):   # as if the last question was asked that long ago
        server.Usage.last["claude"]["asked"] -= seconds

    def test_asked_seldom(self):
        self.answers = [self.CARD, {"t": "reply", "text": "Failed to fetch usage: 503"}, None]
        first = server.Usage.get(self.chat)
        self.assertEqual((self.asked, first["card"], first.get("stale")), (1, self.CARD["card"], None))
        server.Usage.get(self.chat)
        server.Usage.get(self.chat, fresh=True)
        self.assertEqual(self.asked, 1)   # within 30 seconds, not even when you ask again
        self.older(31)
        e = server.Usage.get(self.chat, fresh=True)   # asked again: an error, so the last good answer, marked
        self.assertEqual((self.asked, e["card"], e["stale"], e["asked"]), (2, self.CARD["card"], True, first["asked"] - 31))
        self.older(599)
        server.Usage.get(self.chat)
        self.assertEqual(self.asked, 2)   # an error is an answer too: not asked again for 10 minutes
        self.older(1)
        self.assertTrue(server.Usage.get(self.chat)["stale"])   # no answer at all
        self.assertEqual(self.asked, 3)
        self.older(599)
        server.Usage.get(self.chat)
        self.assertEqual(self.asked, 3)   # nor after no answer at all: it's looked for instead
        self.late["q3"] = self.CARD
        e = server.Usage.get(self.chat)
        self.assertEqual((self.asked, e["card"], e.get("stale")), (3, self.CARD["card"], None))   # it came late

    def test_not_taken(self):
        """While the agent hasn't taken the last question (its relay is down), no second one piles up behind it."""
        self.answers, self.untaken = [None, self.CARD], True
        server.Usage.get(self.chat)
        self.older(3600)
        self.assertIsNone(server.Usage.get(self.chat))
        self.assertEqual(self.asked, 1)
        self.untaken = False   # it took it, and lost it (its VM restarted, say): asked again
        self.assertEqual((server.Usage.get(self.chat)["card"], self.asked), (self.CARD["card"], 2))

    def test_never_a_good_answer(self):
        self.answers = [None, {"t": "reply", "text": "Current agent does not support `/usage`."}]
        self.assertIsNone(server.Usage.get(self.chat))
        self.older(600)
        self.assertEqual(server.Usage.get(self.chat)["text"], "Current agent does not support `/usage`.")


class UsageAnswers(unittest.TestCase):
    """The answer to a /usage question, in the agent's chat log: only to that question, and found later too."""
    setUp, tearDown, clear, write = Logs.setUp, Logs.tearDown, Logs.clear, Logs.write

    def test_late_answer(self):
        self.write({"t": "reply", "text": "before", "at": 1})
        q = server.ask_usage(self.chat, timeout=0)
        self.assertIsNone(q["entry"])
        self.assertTrue(self.chat.waiting(q["rid"]))   # still in in/, for the VM to take
        self.write({"t": "card", "session": "usage", "ctx": "another question", "card": {}},
                   {"t": "card", "session": "you", "ctx": q["rid"], "card": {}},
                   {"t": "card", "session": "usage", "ctx": q["rid"], "card": {"header": {"title": "Usage"}}})
        self.assertEqual(server.usage_answer(self.chat, q)["card"], {"header": {"title": "Usage"}})
        self.assertEqual(q["pos"], os.path.getsize(self.path))   # read on from there next time
        os.unlink(os.path.join(server.APPDIR, "claude", "in", q["rid"] + ".json"))
        self.assertFalse(self.chat.waiting(q["rid"]))


def deepest():
    """How deeply nested a line this Python's json reads, here (deeper, it gives up with RecursionError)."""
    lo, hi = 1, 1 << 17
    while lo < hi:
        n = (lo + hi + 1) // 2
        try:
            json.loads(b"[" * n + b"]" * n)
            lo = n
        except RecursionError:
            hi = n - 1
    return lo


def strict(body):
    """JSON as a browser reads it: no NaN or Infinity (Python's json reads and writes them; JSON.parse doesn't)."""
    def refuse(c):
        raise ValueError(f"{c} isn't JSON")
    return json.loads(body, parse_constant=refuse)


class FindMsb(unittest.TestCase):
    """msb, found where cage finds it: $CAGE_MSB; else on PATH; else where microsandbox's installer puts it, which a
    session started at login doesn't have on PATH (~/.local/bin, or $MSB_HOME/bin: ~/.microsandbox/bin unless set)."""
    def test_where(self):
        d, saved = tempfile.mkdtemp(dir=HOME), {k: os.environ.get(k) for k in ("CAGE_MSB", "PATH", "HOME", "MSB_HOME")}

        def found_once_put(*where):   # (an msb there now, and that's the one found)
            path = os.path.join(d, *where, "msb")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write("#!/bin/sh\n")
            os.chmod(path, 0o755)
            self.assertEqual(server.find_msb(), path)
        try:
            os.environ.update(HOME=d, PATH=os.path.join(d, "bin"))
            for k in ("CAGE_MSB", "MSB_HOME"):
                os.environ.pop(k, None)
            self.assertIsNone(server.find_msb())
            self.assertIsNone(server.vm_running("claude"))   # (it can't say)
            found_once_put(".microsandbox", "bin")
            os.environ["MSB_HOME"] = os.path.join(d, "msb-home")
            self.assertIsNone(server.find_msb())
            found_once_put("msb-home", "bin")
            found_once_put(".local", "bin")
            found_once_put("bin")
            os.environ["CAGE_MSB"] = "/opt/microsandbox/msb"
            self.assertEqual(server.find_msb(), "/opt/microsandbox/msb")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class Live(unittest.TestCase):
    """What Home asks of the server (/api/activity, Allow and Deny on /api/chat/<a>/action, plan usage) and the chats'
    stream, asked over HTTP of the real handler, as a page, or anything else on this computer, could ask it. The
    agents' logs are written here as their VMs would write them, and what goes to an agent is what lands in its in/."""
    PERM = Activity.PERM
    AT = [1791000000000]   # when each approval was asked: never twice the same

    @classmethod
    def setUpClass(cls):
        cls.token = secrets.token_hex(24)
        with open(server.TOKEN_FILE, "w") as f:
            f.write(cls.token)
        cls.httpd = server.Server(("127.0.0.1", 0), server.Handler)
        cls.port, server.PORT = server.PORT, cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.PORT = cls.port
        os.unlink(server.TOKEN_FILE)

    def setUp(self):
        self.tearDown()

    def tearDown(self):
        for a in server.AGENTS:
            f = os.path.join(server.APPDIR, a)
            if os.path.islink(f) or os.path.isfile(f):
                os.unlink(f)
            else:
                shutil.rmtree(f, True)

    def call(self, method, path, body=None, headers=None, token=True):
        """(status, headers, body) of a request as the page makes it (with the token; a body as JSON), but for these
        headers (None: without that one)."""
        h = {"Host": "127.0.0.1:%d" % server.PORT}
        if token:
            h["X-Cage-Token"] = self.token
        if body is not None and not isinstance(body, bytes):
            body, h["Content-Type"] = json.dumps(body).encode(), "application/json"
        h = {k: v for k, v in dict(h, **(headers or {})).items() if v is not None}
        c = http.client.HTTPConnection("127.0.0.1", server.PORT, timeout=20)
        try:
            c.request(method, path, body, h)
            r = c.getresponse()
            return r.status, r.headers, b"" if r.headers.get("Content-Type") == "text/event-stream" else r.read()
        finally:
            c.close()

    def stream(self, query, until=lambda events: False, timeout=5.0):
        """The chats' stream: its headers, and the events it sent until `until(events)` (or `timeout` seconds)."""
        s = socket.create_connection(("127.0.0.1", server.PORT), timeout=timeout)
        s.sendall(("GET /api/chat/stream?%s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nX-Cage-Token: %s\r\n\r\n" % (query, server.PORT, self.token)).encode())
        buf, events, end = b"", [], time.time() + timeout
        try:
            while not until(events) and time.time() < end:
                s.settimeout(max(0.01, end - time.time()))
                try:
                    chunk = s.recv(1 << 20)
                except socket.timeout:
                    break
                if not chunk:
                    break
                buf += chunk
                lines = buf.partition(b"\r\n\r\n")[2].split(b"\n")[:-1]   # (whole lines only)
                events = [strict(line[6:]) for line in lines if line.startswith(b"data: ")]
        finally:
            s.close()
        return buf.partition(b"\r\n\r\n")[0].decode("latin-1"), events

    def log(self, agent, *entries):
        os.makedirs(os.path.join(server.APPDIR, agent), exist_ok=True)
        with open(os.path.join(server.APPDIR, agent, "log.jsonl"), "ab") as f:
            for e in entries:
                f.write((e if isinstance(e, bytes) else json.dumps(e).encode()) + b"\n")

    def asks(self, agent, text):
        """The agent asks for your OK: what Home gets of it (the "pending" Allow and Deny go with)."""
        Live.AT[0] += 1000
        self.log(agent, {"t": "buttons", "session": "you", "text": text, "buttons": self.PERM, "at": Live.AT[0]})
        return {"text": text, "at": Live.AT[0]}

    def answer(self, agent, action, *pending, **more):
        """Allow or Deny as Home or a card in the chat sends it, with the approval it showed (or, without one, as only
        a page from before cards said which they answer would)."""
        body = dict(more, action=action, label=action)
        if pending:
            body["pending"] = pending[0]
        return self.call("POST", f"/api/chat/{agent}/action", body)

    def sent(self, agent):
        """What went to the agent: its in/, which its VM hasn't taken yet."""
        d = os.path.join(server.APPDIR, agent, "in")
        out = []
        for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            with open(os.path.join(d, name)) as f:
                out.append(json.load(f))
        return out

    def taken(self, agent):
        """The VM takes what was sent, and its log says so, as guest/app.mjs does."""
        for r in self.sent(agent):
            os.unlink(os.path.join(server.APPDIR, agent, "in", r["id"] + ".json"))
            self.log(agent, {"t": "action", "session": r["session"], "id": r["id"], "action": r["action"], "label": r["label"]} if r["type"] == "action"
                     else {"t": "you", "session": r["session"], "id": r["id"], "text": r["text"], "files": r["files"]})

    def card(self, agent):
        """What the newest approval's card in the chat answers with: what it asked and when, as the page has them from
        its line in the log (/history). The page sends what it asked cut at 4,000 characters (counted as Python does);
        this is all of it, which the server cuts the same way."""
        status, _, body = self.call("GET", f"/api/chat/{agent}/history")
        e = [e for e in strict(body)["entries"] if e.get("t") == "buttons"][-1]
        return {"text": e.get("text"), "at": e.get("at")}

    def test_who_may_ask(self):
        """Only cage's own page, on this computer, with the token: without it or with a wrong one (in the header or the
        address), from another site (Sec-Fetch-Site, Origin, even a link that opens it) or through another host name
        (DNS rebinding), nothing is read or sent. A request without Sec-Fetch-Site (curl, `cage ui`, a browser too old
        to send it) still needs the token: a page elsewhere can't make a browser that sends it leave it out."""
        p = self.asks("claude", "Bash(ls)")
        refused = ((401, {}, False), (401, {"X-Cage-Token": "x" * 48}, False), (403, {"Sec-Fetch-Site": "cross-site"}, True),
                   (403, {"Sec-Fetch-Site": "same-site"}, True), (403, {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "document"}, True),
                   (403, {"Origin": "https://evil.example"}, True), (403, {"Origin": "null"}, True),
                   (403, {"Origin": "http://127.0.0.1:%d.evil.example" % server.PORT}, True), (403, {"Host": "evil.example:%d" % server.PORT}, True),
                   (403, {"Host": "127.0.0.1:%d" % (server.PORT + 1)}, True))
        for method, path, body in (("GET", "/api/activity?agents=claude", None), ("POST", "/api/chat/claude/action", {"action": "perm:allow", "pending": p}),
                                   ("POST", "/api/chat/claude/usage", {"fresh": True}), ("GET", "/api/chat/stream?from=claude:0", None)):
            for status, headers, token in refused:
                self.assertEqual(self.call(method, path, body, headers, token)[0], status, (path, headers, token))
            self.assertEqual(self.call(method, path + ("&" if "?" in path else "?") + "token=" + "y" * 48, body, token=False)[0], 401, path)
        self.assertEqual(self.sent("claude"), [])
        for site in (None, "same-origin", "none"):
            status, _, body = self.call("GET", "/api/activity?agents=claude", headers={"Sec-Fetch-Site": site})
            self.assertEqual((status, strict(body)["agents"]["claude"]["pending"]), (200, p), site)
        self.assertEqual(self.call("GET", "/api/activity?agents=claude", headers={"Sec-Fetch-Site": None}, token=False)[0], 401)

    def test_methods(self):
        """GET to look, POST to answer or ask for plan usage: any other method is refused, and sends nothing."""
        p = self.asks("claude", "Bash(ls)")
        for method in ("POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
            status, headers, body = self.call(method, "/api/activity?agents=claude", b"{}" if method in ("POST", "PUT", "PATCH") else None)
            self.assertIn(status, (404, 405, 501), method)
            self.assertNotIn(b"pending", body)
        for what in ("action", "usage"):
            for method in ("GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
                body = json.dumps({"action": "perm:allow", "pending": p}).encode() if method in ("PUT", "PATCH") else None
                self.assertIn(self.call(method, f"/api/chat/claude/{what}", body, {"Content-Type": "application/json"})[0], (405, 501), (what, method))
            self.assertEqual(self.call("POST", f"/api/chat/claude/{what}", b"action=perm:allow", {"Content-Type": "application/json"})[0], 400)
            self.assertEqual(self.call("POST", f"/api/chat/claude/{what}", b"[]", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.sent("claude"), [])

    def test_only_json(self):
        """An answer, a message, a request or plan usage comes as JSON, said to be JSON, as the page's api() sends it.
        A body said to be anything else (a form, text, a beacon: what a page elsewhere can send without the browser
        asking first) is refused (415) before it's read, and nothing goes to the agent. A file you upload is its own
        bytes, whatever their type."""
        p = self.asks("claude", "Bash(ls)")
        body = json.dumps({"action": "perm:allow", "pending": p, "text": "yes", "type": "ls", "path": "."}).encode()
        for what in ("action", "usage", "send", "request"):
            for kind in (None, "", "text/plain", "text/plain; charset=utf-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x",
                         "application/jsonx", "text/json", "application/json-patch+json"):
                self.assertEqual(self.call("POST", f"/api/chat/claude/{what}", body, {"Content-Type": kind})[0], 415, (what, kind))
        self.assertEqual(self.sent("claude"), [])
        for kind in ("application/json", "application/json; charset=utf-8", "Application/JSON"):
            p = self.asks("claude", "Bash(ls)")
            self.assertEqual(self.call("POST", "/api/chat/claude/action", json.dumps({"action": "perm:deny", "pending": p}).encode(), {"Content-Type": kind})[0], 200, kind)
        self.assertEqual([r["action"] for r in self.sent("claude")], ["perm:deny"] * 3)
        status, _, body = self.call("POST", "/api/chat/claude/upload?name=a.pdf", b"%PDF-1.4", {"Content-Type": "application/pdf"})
        self.assertEqual((status, strict(body)["mime"]), (200, "application/pdf"))

    def test_home_answers_the_approval_it_showed(self):
        """Allow or Deny from Home goes with the approval Home showed, and reaches that one or none: one asked before
        the one that waits now, or since, one another agent asked, one cc-connect forgot when it restarted (the relay
        registers with it again), none at all, or one in another conversation than the chat's: each gets 409, and
        nothing goes to any agent."""
        old = self.asks("claude", "Bash(ls)")
        p = self.asks("claude", "Bash(rm -rf ~/work/old)")   # two at once: the one asked last is the one that waits
        theirs = self.asks("codex", "Bash(rm -rf ~/work/old)")
        for agent, pending in (("claude", old), ("claude", dict(p, at=p["at"] - 1)), ("claude", dict(p, text="Bash(ls)")), ("claude", theirs),
                               ("codex", p), ("claude", p["text"]), ("claude", {"text": p["text"]}), ("claude", dict(p, also=1)), ("claude", [p])):
            status, _, body = self.answer(agent, "perm:allow", pending)
            self.assertEqual(status, 409, (agent, pending))
            self.assertEqual(strict(body)["error"], "It isn’t waiting for that any more. Open its chat to see what it’s doing.")
        self.log("codex", {"t": "status", "connected": True})
        self.assertEqual(self.answer("codex", "perm:allow", theirs)[0], 409)
        self.assertEqual(self.sent("claude") + self.sent("codex"), [])
        self.assertEqual(self.answer("claude", "perm:deny", p)[0], 200)
        self.assertEqual([(r["type"], r["session"], r["action"]) for r in self.sent("claude")], [("action", "you", "perm:deny")])
        self.taken("claude")
        self.assertEqual(self.answer("claude", "perm:allow", p)[0], 409)   # answered: what it asks next is another
        self.assertEqual(self.answer("claude", "perm:allow", None)[0], 409)   # nothing waits: not an answer to "nothing"
        q = self.asks("claude", "Bash(ls)")
        self.assertEqual(self.answer("claude", "perm:allow", q, session="usage")[0], 409)   # (Home shows the chat's)
        self.assertEqual(self.sent("claude"), [])

    def test_a_card_answers_the_approval_it_shows(self):
        """A card in the chat answers with the approval it shows, and reaches that one or none. Once the wait for it has
        ended, its Allow (or Deny, or Allow everything) gets 409 and nothing goes to the agent: answered by a message
        (taken by the VM or not yet), stopped (/stop, its Stop button), a new conversation (/new) or another command that
        starts the agent's session afresh, cc-connect restarted (the relay registers with it again), asked anew, or
        answered from another window. An answer to an approval that doesn't say which it answers can't be told apart
        from those: 409 too, even while one waits."""
        def stale(why, end, actions=("perm:allow", "perm:deny", "perm:allow_all")):
            self.asks("claude", "Bash(rm -rf ~/work/old)")
            card = self.card("claude")
            end()
            before = self.sent("claude")
            for action in actions:
                status, _, body = self.answer("claude", action, card)
                self.assertEqual(status, 409, (why, action))
                self.assertIn(strict(body)["error"], ("It isn’t waiting for that any more. Open its chat to see what it’s doing.",
                                                      "You answered that already."), (why, action))
            self.assertEqual(self.sent("claude"), before, why)
            self.taken("claude")

        def typed(text):
            return lambda: self.assertEqual(self.call("POST", "/api/chat/claude/send", {"text": text})[0], 200)

        def then(*steps):
            return lambda: [step() for step in steps]
        stale("a message that answers it, not yet taken", typed("yes, go ahead"))
        stale("a message that answers it", then(typed("No, keep it."), lambda: self.taken("claude")))
        for command in ("/stop", "/new", "/new client call", "/model opus", "/cd ~/other"):
            stale(command, then(typed(command), lambda: self.taken("claude")))
        stale("its Stop button", then(lambda: self.answer("claude", "act:/stop"), lambda: self.taken("claude")))
        stale("cc-connect restarted", lambda: self.log("claude", {"t": "status", "session": "you", "connected": True}))
        stale("answered from another window", then(lambda: self.answer("claude", "perm:deny", self.card("claude")), lambda: self.taken("claude")))
        stale("asked anew", lambda: self.asks("claude", "Bash(ls)"))
        # (and what waits now, asked anew, is answered by its own card)
        self.assertEqual(self.answer("claude", "perm:deny", self.card("claude"))[0], 200)
        self.assertEqual([r["action"] for r in self.sent("claude")], ["perm:deny"])
        self.taken("claude")
        # an answer that doesn't say which it answers, or says it in another shape
        p = self.asks("claude", "Bash(ls)")
        for action in ("perm:allow", "perm:deny", "perm:allow_all", "perm:anything"):
            for pending in ((), (None,), ({},), (p["text"],), ([p],), (dict(p, label="Allow"),), ({"text": p["text"]},)):
                self.assertEqual(self.answer("claude", action, *pending)[0], 409, (action, pending))
        self.assertEqual(self.sent("claude"), [])
        self.assertEqual(self.answer("claude", "perm:allow", p)[0], 200)

    def test_a_card_says_what_its_line_says(self):
        """A card has what was asked, and when, as the agent's log line says it, and Home has what activity() made of
        them: all the same, they're the same approval. All of what it asked (more than 4,000 characters, with
        characters outside the BMP, which JavaScript counts as two) or the first 4,000, as Python counts them; a time
        that's missing, not a time, too big for a float (1e400), or a fraction; a character whose two halves the log
        has apart (Python reads them as two, the page as one)."""
        long = "Bash(echo " + "\U0001F600" * 4100 + ")"
        for text, at, raw in ((long, 1791000000123, None), ("Bash(ls)", "absent", None), ("Bash(ls)", "soon", None), ("Bash(ls)", 1791000000000.5, None),
                              ("Bash(ls)", None, b'{"t": "buttons", "session": "you", "text": "Bash(ls)", "buttons": [[{"data": "perm:allow"}]], "at": 1e400}'),
                              ("Bash(echo \U0001F600)", None, b'{"t": "buttons", "session": "you", "text": "Bash(echo \xed\xa0\xbd\xed\xb8\x80)", "buttons": [[{"data": "perm:allow"}]], "at": 5}')):
            for n, who in enumerate(("card", "card, cut as the page cuts it", "Home")):
                # (each asked anew: with no time to tell them apart, by what it asked first)
                if raw:
                    self.log("claude", raw.replace(b'"text": "', b'"text": "%d ' % n))
                elif at == "absent":
                    self.log("claude", {"t": "buttons", "session": "you", "text": f"{n} {text}", "buttons": self.PERM})
                else:
                    self.log("claude", {"t": "buttons", "session": "you", "text": f"{n} {text}", "buttons": self.PERM, "at": at})
                if who == "Home":
                    pending = strict(self.call("GET", "/api/activity?agents=claude")[2])["agents"]["claude"]["pending"]
                else:
                    pending = self.card("claude")
                    if who != "card":
                        pending["text"] = pending["text"][:4000]
                self.assertEqual(self.answer("claude", "perm:allow", pending)[0], 200, (text[:20], at, who))
                self.taken("claude")

    def test_what_ends_the_wait_is_marked(self):
        """A line that ends the wait for an approval comes to the page with "ends": true, from history and stream alike,
        as activity() reads it; the page doesn't read cc-connect's words again. Whatever "ends" the VM wrote is
        replaced."""
        lines = [({"t": "buttons", "text": "Bash(ls)", "buttons": self.PERM, "ends": True}, False), ({"t": "you", "text": "yes"}, True),
                 ({"t": "you", "text": "What's in it?", "ends": True}, False), ({"t": "you", "text": "/stop"}, True),
                 ({"t": "you", "text": "/stop", "files": [{"name": "a.png", "mime": "image/png"}]}, False), ({"t": "status", "connected": True}, True),
                 ({"t": "status", "connected": False}, False), ({"t": "action", "action": "act:/stop"}, True),
                 ({"t": "action", "action": "perm:allow"}, True), ({"t": "reply", "text": "ok", "ends": "yes"}, False)]
        self.log("claude", *[dict(e, session="you", at=i) for i, (e, _) in enumerate(lines)])
        want = [True if end else None for _, end in lines]
        entries = strict(self.call("GET", "/api/chat/claude/history")[2])["entries"]
        self.assertEqual([e.get("ends") for e in entries], want)
        _, events = self.stream("from=claude:0", lambda events: len([e for e in events if "e" in e]) == len(lines))
        self.assertEqual([e["e"].get("ends") for e in events if "e" in e], want)

    def test_a_question_after_it(self):
        """Once the agent asks a question, the approval it asked before isn't waited for: an Allow for it (from Home or
        its card) would be the question's answer, so it gets 409 and nothing is sent; Home shows no approval."""
        p = self.asks("claude", "Bash(rm -rf ~/work/old)")
        card = self.card("claude")
        self.log("claude", dict(Activity.QUESTION, session="you", at=self.AT[0] + 1))
        for pending in (p, card):
            status, _, body = self.answer("claude", "perm:allow", pending)
            self.assertEqual((status, strict(body)["error"]), (409, "It isn’t waiting for that any more. Open its chat to see what it’s doing."))
        self.assertEqual(self.sent("claude"), [])
        self.assertIsNone(strict(self.call("GET", "/api/activity?agents=claude")[2])["agents"]["claude"]["pending"])
        self.assertTrue(strict(self.call("GET", "/api/chat/claude/history")[2])["entries"][-1].get("ends"))

    def test_after_a_new_log(self):
        """An approval asked just before the VM started a new log still waits: Home shows it, and its card's Allow
        goes."""
        p = self.asks("claude", "Bash(rm -rf ~/work/old)")
        d = os.path.join(server.APPDIR, "claude")
        os.rename(os.path.join(d, "log.jsonl"), os.path.join(d, "log.1.jsonl"))
        self.log("claude", {"t": "you", "session": "you", "text": "What does it delete?", "at": self.AT[0] + 1})
        self.assertEqual(strict(self.call("GET", "/api/activity?agents=claude")[2])["agents"]["claude"]["pending"], p)
        self.assertEqual(self.answer("claude", "perm:allow", self.card("claude"))[0], 200)
        self.assertEqual([r["action"] for r in self.sent("claude")], ["perm:allow"])

    def test_not_while_its_vm_is_stopped(self):
        """An answer to an approval while the agent's VM isn't running (asleep, say), as msb says, though its log still
        has it waiting: cc-connect keeps what it asked only in memory, so it forgot it when it stopped, and started
        afresh, it would drop the answer without a word. So it gets 409 (from Home or a card), and nothing is sent; once
        the VM runs again, the answer goes. When msb can't say (it fails, or isn't there), it goes: the page offers none
        while the agent isn't up. Anything else (a card's button, a message) still goes, and waits for the agent."""
        try:
            for running in ("", "cage-codex\ncage-claude-2\n"):
                with open(RUNNING, "w") as f:
                    f.write(running)
                p = self.asks("claude", "Bash(rm -rf ~/work/old)")
                for action, pending in (("perm:allow", p), ("perm:deny", p), ("perm:allow_all", p), ("perm:allow", self.card("claude"))):
                    status, _, body = self.answer("claude", action, pending)
                    self.assertEqual((status, strict(body)["error"]), (409, "It stopped while waiting for your OK, so it won’t go ahead."), (running, action))
                self.assertEqual(self.sent("claude"), [])
                self.assertEqual(self.answer("claude", "nav:/help")[0], 200)
                self.assertEqual(self.call("POST", "/api/chat/claude/send", {"text": "What does it delete?"})[0], 200)
                self.assertEqual([r.get("action") or r["text"] for r in self.sent("claude")], ["nav:/help", "What does it delete?"])
                self.taken("claude")
            with open(RUNNING, "w") as f:   # running again (with the approval still waiting: it only looked away)
                f.write(EVERY_VM)
            self.assertEqual(self.answer("claude", "perm:deny", p)[0], 200)
            self.taken("claude")
            os.unlink(RUNNING)   # msb fails
            self.assertEqual(self.answer("claude", "perm:deny", self.asks("claude", "Bash(ls)"))[0], 200)
            self.taken("claude")
            os.environ["CAGE_MSB"] = os.path.join(HOME, "no-msb")   # msb isn't there
            self.assertEqual(self.answer("claude", "perm:allow", self.asks("claude", "Bash(ls -la)"))[0], 200)
            self.assertEqual([r["action"] for r in self.sent("claude")], ["perm:allow"])
        finally:
            os.environ["CAGE_MSB"] = MSB
            with open(RUNNING, "w") as f:
                f.write(EVERY_VM)

    def test_one_answer_per_approval(self):
        """cc-connect's buttons say allow or deny, not to what: an answer goes to whatever waits when it gets there.
        Until the VM has taken an answer (and its log says so), the approval it answers still seems to wait, and a
        second answer to it (from another window, or a card in the chat after Home) would reach whatever the agent
        asks next, which nobody has seen. So the first answer to an approval is the one; the others get 409, and
        nothing more is sent. A command still goes, and what it asks next is answered as ever."""
        p = self.asks("claude", "Bash(ls)")
        self.assertEqual(self.answer("claude", "perm:allow", p)[0], 200)
        for action in ("perm:allow", "perm:deny", "perm:allow_all"):
            status, _, body = self.answer("claude", action, p)
            self.assertEqual((status, strict(body)["error"]), (409, "You answered that already."), action)
        self.assertEqual(self.answer("claude", "act:/stop")[0], 200)
        self.assertEqual([r["action"] for r in self.sent("claude")], ["perm:allow", "act:/stop"])
        self.taken("claude")
        nxt = self.asks("claude", "Bash(rm -rf ~/work/old)")   # what it asks next
        self.assertEqual(self.answer("claude", "perm:allow", p)[0], 409)
        self.assertEqual(self.sent("claude"), [])
        # an answer typed in the chat is one too, as cc-connect reads it (a question isn't)
        self.assertEqual(self.call("POST", "/api/chat/claude/send", {"text": "What does it delete?"})[0], 200)
        self.assertEqual(self.answer("claude", "perm:deny", nxt)[0], 200)
        self.taken("claude")
        typed = self.asks("claude", "Bash(rm -rf ~/work/old)")
        self.assertEqual(self.call("POST", "/api/chat/claude/send", {"text": "No, keep it."})[0], 200)
        self.assertEqual(self.answer("claude", "perm:allow", typed)[0], 409)
        self.assertEqual(self.answer("claude", "perm:allow")[0], 409)
        self.assertEqual([r["text"] for r in self.sent("claude")], ["No, keep it."])
        self.taken("claude")
        last = self.asks("claude", "Bash(ls)")
        self.assertEqual(self.answer("claude", "perm:allow", self.card("claude"))[0], 200)   # its card in the chat answers it first
        self.assertEqual(self.answer("claude", "perm:allow", last)[0], 409)
        self.assertEqual([r["action"] for r in self.sent("claude")], ["perm:allow"])

    def test_typed_after_an_answer(self):
        """A message cc-connect reads as an answer ("yes", "ok, and…", "no") is one, typed or not. Typed after Allow (from
        Home, or another window's card) while the approval still seems to wait, it would answer what the agent asks
        next, which nobody has seen. So it gets 409, and nothing is sent (the page keeps it in the box); "/x yes" too,
        which cc-connect reads as a message, x being none of its commands. A command of its own (/stop, or /sto for
        short) still goes, and so does anything once the VM has taken the answer."""
        p = self.asks("claude", "Bash(ls)")
        self.assertEqual(self.answer("claude", "perm:allow", p)[0], 200)
        for text in ("Yes, go on.", "ok, and then run the tests", "No!", "好的", "/stop yes", "/x yes", "/c yes"):
            files = [{"path": "files/a.png", "name": "a.png", "mime": "image/png"}] if text == "/stop yes" else []
            if files:
                os.makedirs(os.path.join(server.APPDIR, "claude", "files"), exist_ok=True)
                open(os.path.join(server.APPDIR, "claude", "files", "a.png"), "wb").close()
            status, _, body = self.call("POST", "/api/chat/claude/send", {"text": text, "files": files})
            self.assertEqual((status, strict(body)["error"]), (409, "You answered that already. Send this again once the chat shows your answer."), text)
        self.assertEqual(self.call("POST", "/api/chat/claude/send", {"text": "What does it do?"})[0], 200)   # (not an answer)
        self.assertEqual(self.call("POST", "/api/chat/claude/send", {"text": "/sto"})[0], 200)
        self.assertEqual(sorted(r.get("action") or r["text"] for r in self.sent("claude")), ["/sto", "What does it do?", "perm:allow"])
        self.taken("claude")
        self.assertEqual(self.call("POST", "/api/chat/claude/send", {"text": "Yes, go on."})[0], 200)

    def test_an_answer_that_didnt_go(self):
        """An answer that couldn't be sent (nothing can be written in the agent's in/: the disk is full, or the VM
        made it a file) is no answer: the page is told, and Allow or Deny can be given again, from Home or the chat."""
        p = self.asks("claude", "Bash(ls)")
        inbox = os.path.join(server.APPDIR, "claude", "in")
        for method, path, body in (("POST", "/api/chat/claude/action", {"action": "perm:allow", "label": "Allow", "pending": p}),
                                   ("POST", "/api/chat/claude/action", {"action": "perm:allow", "label": "Allow", "pending": self.card("claude")}),
                                   ("POST", "/api/chat/claude/send", {"text": "yes"})):
            with open(inbox, "w"):
                pass
            self.assertEqual(self.call(method, path, body)[0], 404, body)
            os.unlink(inbox)
        self.assertEqual(self.answer("claude", "perm:deny", p)[0], 200)
        self.assertEqual([r["action"] for r in self.sent("claude")], ["perm:deny"])
        self.assertEqual(self.answer("claude", "perm:allow", p)[0], 409)   # (and that one went: it's the answer)

    def test_two_windows_at_once(self):
        """Allow for the same approval from two windows at the same moment: one goes, the others get 409. So too when
        the answer takes a while to write (a slow disk): an agent's answers are taken one at a time, so no other finds
        the approval still unanswered while the first is on its way."""
        send = server.Chat.send

        def slowly(chat, req):
            time.sleep(0.2)
            return send(chat, req)

        def allow(p, go, statuses):
            go.wait()
            statuses.append(self.answer("claude", "perm:allow", p)[0])
        for slow in (False, True):
            p, go, statuses = self.asks("claude", "Bash(ls)"), threading.Barrier(8), []
            threads = [threading.Thread(target=allow, args=(p, go, statuses)) for _ in range(8)]
            server.Chat.send = slowly if slow else send
            try:
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()
            finally:
                server.Chat.send = send
            self.assertEqual(sorted(statuses), [200] + [409] * 7, slow)
            self.assertEqual(len(self.sent("claude")), 1, slow)
            self.taken("claude")

    def test_names_stay_inside(self):
        """An agent's name comes in the address: whatever it says (.., a path, NUL, a very long one), only cage's own
        agents' folders are read or written, and none is made for a name that isn't one."""
        before, p = sorted(os.listdir(HOME)), self.asks("claude", "Bash(ls)")
        for name in ("..", "%2e%2e", "..%2f..%2fetc", "%2fetc%2fpasswd", "claude%00", "claude%2f..%2f..%2fui.token", "CLAUDE", "claude%20", "", "x" * 4000):
            for method, what in (("POST", "action"), ("POST", "usage"), ("POST", "send"), ("GET", "history"), ("GET", "file?p=files/x.png")):
                body = {"action": "perm:allow", "pending": p, "text": "yes"} if method == "POST" else None
                self.assertEqual(self.call(method, f"/api/chat/{name}/{what}", body)[0], 400, (name[:20], what))
        for agents in ("..,../..,/etc/passwd,claude%00,claude/../codex,%2e%2e,claude%2f..,CLAUDE", "x" * 30000, ",".join(["claude"] * 5000), "", ",,,"):
            status, _, body = self.call("GET", "/api/activity?since=0&agents=" + agents)
            self.assertEqual(status, 200, agents[:40])
            self.assertLessEqual(set(strict(body)["agents"]), {"claude"}, agents[:40])
        status, _, body = self.call("GET", "/api/activity?agents=claude&since=" + "9" * 5000)   # (an int that big: 400 in Python 3.11 on)
        self.assertIn(status, (200, 400))
        strict(body)
        head, events = self.stream("from=..:0,claude%00:0,%2e%2e:0,/etc/passwd:0", timeout=1)
        self.assertTrue(head.startswith("HTTP/1.1 200"), head)
        self.assertEqual(events, [])
        self.assertEqual(self.sent("claude"), [])
        self.assertEqual(sorted(os.listdir(HOME)), before)
        self.assertEqual(os.listdir(server.APPDIR), ["claude"])

    def test_what_a_vm_could_write(self):
        """An agent's log is its VM's to write. Whatever is in it (huge numbers, NaN and Infinity, nesting as deep as
        Python reads or deeper, bytes that aren't UTF-8, a line of megabytes, half a line, a link, a pipe, a folder, a
        terabyte), Home gets valid JSON at once, with the other agents' approvals and what that agent's log says after
        it; and that agent's chat goes on after it too."""
        p = self.asks("claude", "Bash(ls)")
        deep = lambda n, o=b"[", c=b"]": o * n + c * n   # noqa: E731
        # where reading it may just work, or just not, in this Python or another; and every depth around where this one
        # gives up (about a thousand, or ten thousand from 3.12): just short of it, it reads a line it can't write back
        edge = deepest()
        near = sorted(set(range(900, 4000, 41)) | set(range(edge - 60, edge + 60)))
        lines = {
            "huge numbers": [b'{"t": "reply", "text": "hi", "at": 1e400}', b'{"t": "typing", "on": true, "at": ' + b"9" * 5000 + b"}",
                             b'{"t": "you", "text": "hi", "at": ' + b"9" * 400 + b"}"],
            "NaN and Infinity": [b'{"t": "buttons", "text": NaN, "buttons": [[{"data": "perm:allow"}]], "at": NaN}',
                                 b'{"t": "reply", "text": Infinity, "at": -Infinity}', b'{"t": "typing", "on": true, "at": Infinity}'],
            "deep nesting": [b'{"t": "reply", "at": 1, "text": ' + deep(100000) + b"}", b'{"t": "reply", "at": 1, "text": ' + deep(50000, b'{"a": ', b"}") + b"}"],
            "nesting near the limit": [b'{"t": "reply", "at": 1, "text": ' + deep(n) + b"}" for n in near],
            "nesting near the limit, in a button": [b'{"t": "buttons", "at": 1, "text": "x", "buttons": [[{"data": ' + deep(n) + b"}]]}" for n in near],
            "nesting near the limit, in a card": [b'{"t": "card", "at": 1, "card": {"header": {"title": ' + deep(n) + b"}}}" for n in near],
            "bytes that aren't UTF-8": [b'{"t": "reply", "text": "\xff\xfe", "at": 1}', b"\xc3\x28", b'{"t": "reply", "text": "\xed\xa0\x80", "at": 2}',
                                        b'{"t": "reply", "text": "\\ud800", "at": 3}'],
            "a line of megabytes": [b'{"t": "reply", "text": "' + b"x" * (3 << 20) + b'", "at": 1}'],
        }
        for name, bad in lines.items():
            self.tearDown()
            self.log("claude", {"t": "buttons", "session": "you", "text": p["text"], "buttons": self.PERM, "at": p["at"]})
            self.log("codex", *bad, {"t": "buttons", "session": "you", "text": "after " + name, "buttons": self.PERM, "at": 5})
            t = time.time()
            status, _, body = self.call("GET", "/api/activity?since=0&agents=claude,codex")
            self.assertLess(time.time() - t, 2, name)
            self.assertEqual(status, 200, name)
            agents = strict(body)["agents"]
            self.assertEqual((agents["claude"]["pending"], agents["codex"]["pending"]), (p, {"text": "after " + name, "at": 5}), name)
            status, _, body = self.call("GET", "/api/chat/codex/history")
            self.assertEqual((status, strict(body)["entries"][-1]["text"]), (200, "after " + name), name)
            after = lambda events: any(isinstance(e.get("e"), dict) and e["e"].get("text") == "after " + name for e in events)   # noqa: E731
            self.assertTrue(after(self.stream("from=codex:0", after)[1]), name)
        # what the log is: a link (to another agent's), a pipe, a folder, a terabyte (sparse), half a line; or the chat
        # folder itself a link
        def sparse(f):
            with open(f, "wb") as fh:
                fh.truncate(1 << 40)

        def half(f):
            with open(f, "wb") as fh:
                fh.write(b'{"t": "buttons", "session": "you", "text": "half", "buttons": [[{"data": "perm:al')
        claude_log = os.path.join(server.APPDIR, "claude", "log.jsonl")
        for name, make in (("a link", lambda f: os.symlink(claude_log, f)), ("a pipe", os.mkfifo), ("a folder", os.mkdir), ("a terabyte", sparse),
                           ("half a line", half)):
            shutil.rmtree(os.path.join(server.APPDIR, "codex"), True)
            os.makedirs(os.path.join(server.APPDIR, "codex"))
            make(os.path.join(server.APPDIR, "codex", "log.jsonl"))
            t = time.time()
            status, _, body = self.call("GET", "/api/activity?since=0&agents=claude,codex")
            self.assertLess(time.time() - t, 2, name)
            agents = strict(body)["agents"]
            self.assertEqual((status, agents["claude"]["pending"], agents["codex"]["pending"]), (200, p, None), name)
        shutil.rmtree(os.path.join(server.APPDIR, "codex"))
        os.symlink(os.path.join(server.APPDIR, "claude"), os.path.join(server.APPDIR, "codex"))
        status, _, body = self.call("GET", "/api/activity?since=0&agents=claude,codex")
        self.assertEqual((status, list(strict(body)["agents"])), (200, ["claude"]))

    def test_headers(self):
        """The routes Home uses answer with the headers every other API answer has: JSON, not kept, not sniffed, no
        referrer; whatever the answer (a refusal too). The chats' stream, and a job's, too, but for their type."""
        p = self.asks("claude", "Bash(ls)")
        want = {k: v for k, v in self.call("GET", "/api/jobs")[1].items() if k not in ("Date", "Content-Length", "Server")}
        self.assertEqual(want, {"Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                "Referrer-Policy": "no-referrer"})
        for method, path, body, status in (("GET", "/api/activity?agents=claude,codex", None, 200), ("GET", "/api/activity", None, 200),
                                           ("POST", "/api/chat/claude/action", {"action": "perm:allow", "pending": dict(p, at=1)}, 409),
                                           ("POST", "/api/chat/claude/action", {"action": "perm:deny", "pending": p}, 200),
                                           ("POST", "/api/chat/claude/usage", b"{", 400), ("GET", "/api/chat/claude/usage", None, 405),
                                           ("POST", "/api/chat/claude/action", b"{}", 415), ("GET", "/api/activity?agents=claude", None, 200)):
            kind = {"Content-Type": "application/json" if status != 415 else "text/plain"} if isinstance(body, bytes) else None
            got, headers, _ = self.call(method, path, body, kind)
            self.assertEqual(got, status, path)
            self.assertEqual({k: v for k, v in headers.items() if k not in ("Date", "Content-Length", "Server", "Connection")}, want, path)
        job = server.Job.__new__(server.Job)   # (a job's events, without a command behind it)
        job.events, job.first, job.cond, job.watchers, job.unwatched = [{"t": "exit", "code": 0, "n": 0}], 0, threading.Condition(), 0, 0
        server.Job.jobs["test"] = job
        try:
            for path in ("/api/chat/stream?from=claude:0", "/api/jobs/test/events?from=0"):
                got, headers, _ = self.call("GET", path)
                self.assertEqual({k: v for k, v in headers.items() if k not in ("Date", "Server")},
                                 dict(want, **{"Content-Type": "text/event-stream", "X-Accel-Buffering": "no"}), path)
        finally:
            del server.Job.jobs["test"]


if __name__ == "__main__":
    unittest.main()
