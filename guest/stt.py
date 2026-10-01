#!/usr/bin/env python3
"""cage's local speech-to-text for voice notes, inside the agent's VM: an OpenAI-compatible
POST /v1/audio/transcriptions on 127.0.0.1 that cc-connect's [speech] calls (provider "openai", base_url here).
faster-whisper runs the Whisper model on the CPU; nothing you say leaves the VM.

  STT_PORT (8178)  STT_MODEL (base: tiny, base, small, medium, large-v3-turbo…)  STT_LANGUAGE (empty: detect)
  STT_MODELS       where models are downloaded to (once)
GET /health says whether the model is loaded. Started by guest/voice.sh as the agent user.
"""
import email.parser, email.policy, http.server, json, os, sys, tempfile, threading, traceback

PORT = int(os.environ.get("STT_PORT", "8178"))
MODEL = os.environ.get("STT_MODEL") or "base"
LANGUAGE = os.environ.get("STT_LANGUAGE") or None
MAX_BYTES = 50 * 1024 * 1024
state = {"model": None, "error": None}
ready = threading.Event()


def log(msg):
    print(f"cage-stt: {msg}", file=sys.stderr, flush=True)


def load():
    try:
        from faster_whisper import WhisperModel
        state["model"] = WhisperModel(MODEL, device="cpu", compute_type="int8", download_root=os.environ.get("STT_MODELS"),
                                      cpu_threads=os.cpu_count() or 2)
        log(f"model {MODEL} loaded")
    except Exception as e:  # reported on every request until fixed
        state["error"] = f"{type(e).__name__}: {e}"
        log(f"couldn't load model {MODEL}: {state['error']}")
    ready.set()


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
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= MAX_BYTES:
            return self.error(413, "no audio, or more than 50 MB")
        try:
            fields = form_fields(self.headers.get("Content-Type", ""), self.rfile.read(n))
        except Exception as e:
            return self.error(400, f"couldn't read the form: {e}")
        if "file" not in fields:
            return self.error(400, "no file field")
        if not ready.wait(timeout=900) or state["model"] is None:
            return self.error(503, f"the speech model isn't ready: {state['error'] or 'still loading'}")
        language = (fields.get("language", (b"", None))[0].decode() or LANGUAGE) or None
        try:
            text = transcribe(fields["file"][0], fields["file"][1], language)
        except Exception as e:
            log("transcription failed: " + traceback.format_exc())
            return self.error(500, f"transcription failed: {type(e).__name__}: {e}")
        fmt = fields.get("response_format", (b"json", None))[0].decode() or "json"
        if fmt == "text":
            self.reply(200, text + "\n", "text/plain; charset=utf-8")
        else:
            self.reply(200, json.dumps({"text": text}))


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    # one request at a time: transcription uses every core
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
