#!/usr/bin/env python3
"""guest/stt.py, the speech-to-text server in the VM, with a stand-in for faster-whisper (no model, no packages).
    python3 test/stt_test.py
"""
import http.client
import http.server
import importlib.util
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("stt", os.path.join(ROOT, "guest", "stt.py"))
stt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stt)
LOGS = []
stt.log = LOGS.append


class FakeWhisper:
    """What stt.py uses of faster_whisper.WhisperModel. Loading waits for `gate` (a download in progress) and
    raises whatever is queued in `fail`."""
    gate = threading.Event()
    fail = []

    def __init__(self, name, **kw):
        FakeWhisper.gate.wait(10)
        if FakeWhisper.fail:
            raise FakeWhisper.fail.pop(0)
        self.name = name

    def transcribe(self, path, language=None, beam_size=5, vad_filter=True):
        with open(path, "rb") as f:
            data = f.read()
        if data == b"boom":
            raise RuntimeError("the model fell over")
        if vad_filter and data == b"no-vad":
            raise ImportError("onnxruntime")
        seg = types.SimpleNamespace
        return iter([seg(text=" heard "), seg(text=f"{len(data)} bytes, {language or 'any language'}")]), None


sys.modules["faster_whisper"] = types.SimpleNamespace(WhisperModel=FakeWhisper)


def form(fields):
    """multipart/form-data, as cc-connect sends it: {name: text, or (filename, bytes)}"""
    b = "cageTestBoundary7"
    out = b""
    for name, value in fields.items():
        if isinstance(value, tuple):
            head = f'Content-Disposition: form-data; name="{name}"; filename="{value[0]}"\r\nContent-Type: audio/ogg'
            data = value[1]
        else:
            head = f'Content-Disposition: form-data; name="{name}"'
            data = value.encode()
        out += f"--{b}\r\n{head}\r\n\r\n".encode() + data + b"\r\n"
    return f"multipart/form-data; boundary={b}", out + f"--{b}--\r\n".encode()


class Server(unittest.TestCase):
    def setUp(self):
        stt.state.update(model=None, error=None)
        FakeWhisper.gate.clear()
        FakeWhisper.fail.clear()
        del LOGS[:]
        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), stt.Handler)   # one request at a time, as in the VM
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        FakeWhisper.gate.set()
        self.httpd.shutdown()
        self.httpd.server_close()

    def request(self, method, path, fields=None, headers=None, timeout=5):
        c = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=timeout)
        body, h = None, dict(headers or {})
        if fields is not None:
            h["Content-Type"], body = form(fields)
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, r.getheader("Content-Type"), data

    def post(self, fields, **kw):
        return self.request("POST", "/v1/audio/transcriptions", fields, **kw)

    def loaded(self):
        FakeWhisper.gate.set()
        stt.load()


class Parsing(unittest.TestCase):
    def test_form_fields(self):
        ctype, body = form({"file": ("note.ogg", b"\x00OggS\xff"), "model": "whisper-1", "language": "de"})
        self.assertEqual(stt.form_fields(ctype, body), {
            "file": (b"\x00OggS\xff", "note.ogg"), "model": (b"whisper-1", None), "language": (b"de", None)})


class WhileLoading(Server):
    def test_answers_at_once_while_the_model_downloads(self):
        threading.Thread(target=stt.load, daemon=True).start()
        t = time.time()
        status, ctype, body = self.post({"file": ("note.ogg", b"abc")})
        self.assertLess(time.time() - t, 2)
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body), {"error": {"message": "the speech model is still downloading, try again in a minute"}})
        status, _, body = self.request("GET", "/health")
        self.assertEqual((status, json.loads(body)["ready"]), (503, False))

        FakeWhisper.gate.set()   # the download finishes
        for _ in range(100):
            if stt.state["model"] is not None:
                break
            time.sleep(0.05)
        status, _, body = self.post({"file": ("note.ogg", b"abc")})
        self.assertEqual((status, json.loads(body)), (200, {"text": "heard 3 bytes, any language"}))
        self.assertEqual(self.request("GET", "/health")[0], 200)

    def test_the_download_says_how_far_it_got(self):
        models = tempfile.mkdtemp(prefix="cage-stt-")
        self.addCleanup(shutil.rmtree, models, True)
        old = os.environ.get("STT_MODELS")
        os.environ["STT_MODELS"] = models
        self.addCleanup(lambda: os.environ.pop("STT_MODELS") if old is None else os.environ.update(STT_MODELS=old))
        loading = threading.Thread(target=stt.load, kwargs={"every": 0.05}, daemon=True)
        loading.start()
        with open(os.path.join(models, "model.bin.incomplete"), "wb") as f:   # as huggingface_hub writes it
            for _ in range(50):
                f.write(b"\0" * 1000000)
                f.flush()
                time.sleep(0.05)
                if any("MB so far" in m for m in LOGS):
                    break
        self.assertTrue(any(re.fullmatch(r"downloading the speech model \(base\): [1-9]\d* MB so far", m) for m in LOGS), LOGS)
        FakeWhisper.gate.set()
        loading.join(5)
        self.assertIn("model base loaded", LOGS)

    def test_a_model_that_wont_load_is_tried_again_and_said_meanwhile(self):
        FakeWhisper.gate.set()
        FakeWhisper.fail.append(OSError("no network"))
        stt.load(wait=0.01)
        self.assertIsNotNone(stt.state["model"])
        self.assertIsNone(stt.state["error"])
        self.assertTrue(any("no network" in m and "trying again" in m for m in LOGS), LOGS)
        stt.state.update(model=None, error="OSError: no network")
        status, _, body = self.post({"file": ("note.ogg", b"abc")})
        self.assertEqual(status, 503)
        self.assertIn("couldn't load (OSError: no network)", json.loads(body)["error"]["message"])

    def test_a_client_that_stops_sending_does_not_hold_the_server(self):
        self.assertEqual(stt.Handler.timeout, 60)
        stt.Handler.timeout = 0.5   # the same rule, faster
        try:
            self.loaded()
            stalled = socket.create_connection(self.httpd.server_address)
            stalled.sendall(b"POST /v1/audio/transcriptions HTTP/1.1\r\nContent-Length: 1000\r\n\r\nonly part of it")
            t = time.time()
            status, _, _ = self.post({"file": ("note.ogg", b"abc")}, timeout=5)
            self.assertEqual(status, 200)
            self.assertLess(time.time() - t, 4)
            stalled.close()
        finally:
            stt.Handler.timeout = 60


class Requests(Server):
    def setUp(self):
        super().setUp()
        self.loaded()

    def test_transcribes_as_json_or_text_in_the_language_asked(self):
        status, ctype, body = self.post({"file": ("note.ogg", b"hello"), "language": "de"})
        self.assertEqual((status, ctype, json.loads(body)), (200, "application/json", {"text": "heard 5 bytes, de"}))
        status, ctype, body = self.post({"file": ("note.ogg", b"hello"), "response_format": "text"})
        self.assertEqual((status, ctype, body), (200, "text/plain; charset=utf-8", b"heard 5 bytes, any language\n"))

    def test_without_silence_detection_when_that_fails(self):
        status, _, body = self.post({"file": ("note.ogg", b"no-vad")})
        self.assertEqual((status, json.loads(body)), (200, {"text": "heard 6 bytes, any language"}))

    def test_errors_are_json_with_a_message(self):
        cases = [
            (self.request("POST", "/v1/other", {"file": ("a.ogg", b"x")}), 404, "not found"),
            (self.request("GET", "/nothing"), 404, "not found"),
            (self.request("POST", "/v1/audio/transcriptions", headers={"Content-Length": "0"}), 413, "no audio"),
            (self.request("POST", "/v1/audio/transcriptions", headers={"Content-Length": "x"}), 400, "bad Content-Length"),
            (self.post({"model": "whisper-1"}), 400, "no file field"),
            (self.post({"file": ("note.ogg", b"boom")}), 500, "transcription failed: RuntimeError: the model fell over"),
        ]
        for (status, ctype, body), want, message in cases:
            self.assertEqual(status, want, body)
            self.assertEqual(ctype, "application/json")
            self.assertIn(message, json.loads(body)["error"]["message"])


if __name__ == "__main__":
    unittest.main()
