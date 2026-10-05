#!/usr/bin/env python3
"""Unit tests for the web app's server (host/ui/server.py): the parts that decide what a request or a file becomes,
without a browser or a running server. test/ui.sh tests the running server.

  python3 test/server_test.py
"""
import importlib.util, io, json, os, signal, socket, struct, sys, tempfile, threading, time, unittest

HOME = tempfile.mkdtemp()
os.environ["CAGE_HOME"] = HOME
spec = importlib.util.spec_from_file_location("server", os.path.join(os.path.dirname(__file__), "..", "host", "ui", "server.py"))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


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
    """Just enough of a request for Handler.length() and Handler.body()."""
    def __init__(self, headers, body=b""):
        self.headers, self.rfile = headers, io.BytesIO(body)

        class Conn:
            def settimeout(self, t):
                pass
        self.connection = Conn()


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


if __name__ == "__main__":
    unittest.main()
