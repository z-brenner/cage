#!/usr/bin/env python3
"""cage's local speech-to-text for voice notes, inside the agent's VM: an OpenAI-compatible
POST /v1/audio/transcriptions on 127.0.0.1 that cc-connect's [speech] calls (provider "openai", base_url here).
faster-whisper runs the Whisper model on the CPU; nothing you say leaves the VM.

  STT_PORT (8178)  STT_MODEL (base: tiny, base, small, medium, large-v3-turbo…)  STT_LANGUAGE (empty: detect)
  STT_MODELS       where models are downloaded to (once)
GET /health says whether the model is loaded. Started by guest/voice.sh as the agent user. The server answers
from the start. A voice note that comes while the model loads (a few seconds at every boot; the first time, a
download of about 150 MB for base) waits for it, up to 2 minutes: cc-connect itself gives up after 5. If the model
still isn't there by then, or couldn't load, the voice note gets a plain "try again" instead. test/stt_test.py
covers it.
"""
import email.parser, email.policy, http.server, json, os, stat, sys, tempfile, threading, time, traceback

PORT = int(os.environ.get("STT_PORT", "8178"))
MODEL = os.environ.get("STT_MODEL") or "base"
LANGUAGE = os.environ.get("STT_LANGUAGE") or None
MAX_BYTES = 50 * 1024 * 1024
WAIT = 120   # how long a voice note waits for the model: well under the 5 minutes cc-connect waits for an answer
state = {"model": None, "error": None}
settled = threading.Event()   # set once the model is loaded, and while it waits to try again after failing
busy = threading.Lock()       # one transcription at a time: each one uses every core


def log(msg):
    print(f"cage-stt: {msg}", file=sys.stderr, flush=True)


def downloaded(root):
    """Bytes under the models folder so far. Links are left out: huggingface_hub keeps each file once (blobs/) and
    links to it from snapshots/, which would count it twice."""
    total = 0
    for d, _, files in os.walk(root):
        for f in files:
            try:
                st = os.lstat(os.path.join(d, f))
                if not stat.S_ISLNK(st.st_mode):
                    total += st.st_size
            except OSError:
                pass
    return total


def load(wait=60, every=30):
    """Loads the model, downloading it the first time and saying how far that got. If that fails (no network
    yet, say), it tries again later, with longer pauses."""
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")   # its progress bars are noise in a log
    root = os.environ.get("STT_MODELS")
    done = threading.Event()

    def progress():
        seen = downloaded(root)
        while not done.wait(every):
            now = downloaded(root)
            if now != seen:
                log(f"downloading the speech model ({MODEL}): {now // 1000000} MB so far")
                seen = now
    if root:
        threading.Thread(target=progress, daemon=True).start()
    while True:
        settled.clear()   # a new try: voice notes wait for it again, rather than hearing about the last one
        state["error"] = None
        try:
            from faster_whisper import WhisperModel
            state["model"] = WhisperModel(MODEL, device="cpu", compute_type="int8", download_root=root,
                                          cpu_threads=os.cpu_count() or 2)
            log(f"model {MODEL} loaded")
            break
        except Exception as e:  # voice notes meanwhile are told it will try again; /health says why
            state["error"] = f"{type(e).__name__}: {e}"
            log(f"couldn't load model {MODEL}: {state['error']}; trying again in {wait}s")
            settled.set()
            time.sleep(wait)
            wait = min(wait * 2, 900)
    settled.set()
    done.set()


def form_fields(content_type, body):
    """multipart/form-data -> {name: (bytes, filename)}"""
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + content_type.encode("latin-1") + b"\r\n\r\n" + body)
    fields = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            fields[name] = (part.get_payload(decode=True) or b"", part.get_filename())
    return fields


def transcribe(audio, filename, language):
    suffix = os.path.splitext(filename or "")[1][:8] or ".mp3"
    with tempfile.NamedTemporaryFile(suffix=suffix) as f:
        f.write(audio)
        f.flush()
        try:   # skipping silence (VAD) needs onnxruntime; without it, transcribe everything
            segments, _ = state["model"].transcribe(f.name, language=language, beam_size=5, vad_filter=True)
            return "".join(s.text for s in segments).strip()
        except Exception:
            log("with silence detection: " + traceback.format_exc().strip().splitlines()[-1] + "; trying without")
            segments, _ = state["model"].transcribe(f.name, language=language, beam_size=5, vad_filter=False)
            return "".join(s.text for s in segments).strip()


class Handler(http.server.BaseHTTPRequestHandler):
    timeout = 60   # a client that stops sending is dropped after a minute, rather than keeping its thread forever

    def log_message(self, *a):
        pass

    def reply(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def error(self, status, message):
        self.reply(status, json.dumps({"error": {"message": message}}))

    def do_GET(self):
        if self.path == "/health":
            ok = state["model"] is not None
            self.reply(200 if ok else 503, json.dumps({"ready": ok, "model": MODEL, "error": state["error"]}))
        else:
            self.error(404, "not found")

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") not in ("/v1/audio/transcriptions", "/audio/transcriptions"):
            return self.error(404, "not found")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.error(400, "bad Content-Length")
        if not 0 < n <= MAX_BYTES:
            return self.error(413, "no audio, or more than 50 MB")
        body = self.rfile.read(n)   # all of it, so the client hears the answer rather than a closed connection
        try:
            fields = form_fields(self.headers.get("Content-Type", ""), body)
        except Exception as e:
            return self.error(400, f"couldn't read the form: {e}")
        if "file" not in fields:
            return self.error(400, "no file field")
        if state["model"] is None:
            settled.wait(WAIT)
        if state["model"] is None:   # cc-connect shows this to whoever sent the voice note
            if state["error"]:
                return self.error(503, "the speech model couldn't load yet; it will try again later")
            return self.error(503, "the speech model is still getting ready (the first time, it downloads); "
                                   "try again in a minute")
        language = (fields.get("language", (b"", None))[0].decode() or LANGUAGE) or None
        try:
            with busy:
                text = transcribe(fields["file"][0], fields["file"][1], language)
        except Exception as e:
            log("transcription failed: " + traceback.format_exc())
            return self.error(500, f"transcription failed: {type(e).__name__}: {e}")
        fmt = fields.get("response_format", (b"json", None))[0].decode() or "json"
        if fmt == "text":
            self.reply(200, text + "\n", "text/plain; charset=utf-8")
        else:
            self.reply(200, json.dumps({"text": text}))


def server(port):
    """A thread for each request, so a voice note waiting for the model, or a client that stopped sending, doesn't
    hold up the rest (/health included). Transcriptions still take turns (busy)."""
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    server(PORT).serve_forever()
