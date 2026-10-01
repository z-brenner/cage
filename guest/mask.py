#!/usr/bin/env python3
"""cage's privacy mask: sensitive values in your messages are swapped for tokens like [EMAIL_1] before they reach
the AI model, and swapped back in what the agent says to you. Turned on per agent with `cage mask on`.

It sits between cc-connect and the agent's CLI (cc-connect's `cmd`), so it sees exactly what goes to the model:
  python3 mask.py <cli> [args…]      run the CLI: mask its prompt, unmask its output
    stream-json on stdin (Claude Code):  each user message is masked, line by line
    a prompt on stdin (`codex exec … -`): masked as a whole
    a prompt argument (after `--`, or `-p <prompt>`): masked
  python3 mask.py --mask   < text    print the masked text (to try it: `cage mask try`)
  python3 mask.py --unmask < text    the reverse, with the same map

What it finds: email addresses, phone numbers, card numbers (Luhn-checked), IBANs (checksum), US social security
numbers, API keys and tokens (common formats, private keys, JWTs), and your own terms (one per line in
CAGE_MASK_TERMS, e.g. a client's name). CAGE_MASK_TYPES limits the kinds. The same value always gets the same token
(the map is kept in CAGE_MASK_MAP), so the model can still tell values apart. Standard library only.
"""
import fcntl, json, os, re, subprocess, sys, threading

MAP_PATH = os.environ.get("CAGE_MASK_MAP") or os.path.expanduser("~/.cage/mask/map.json")
TERMS_PATH = os.environ.get("CAGE_MASK_TERMS") or "/etc/cage/mask.terms"
TYPES = set((os.environ.get("CAGE_MASK_TYPES") or "email phone card iban ssn secret term").split())


def luhn(digits):
    total, alt = 0, False
    for d in reversed(digits):
        n = int(d)
        if alt:
            n = n * 2 - 9 if n > 4 else n * 2
        total, alt = total + n, not alt
    return total % 10 == 0


def iban_ok(s):
    s = s.replace(" ", "").upper()
    if not 15 <= len(s) <= 34:
        return False
    n = "".join(str(int(c, 36)) for c in s[4:] + s[:4])
    return int(n) % 97 == 1


SECRET = re.compile(r"""(?x)
    -----BEGIN[ A-Z]*PRIVATE\ KEY-----[\s\S]+?-----END[ A-Z]*PRIVATE\ KEY-----
  | \b(?:sk|pk|rk)-(?:[a-z]+-)?[A-Za-z0-9_-]{20,}
  | \bgh[pousr]_[A-Za-z0-9]{30,}\b | \bgithub_pat_[A-Za-z0-9_]{40,}\b
  | \bxox[abprs]-[A-Za-z0-9-]{10,}\b | \bxapp-[A-Za-z0-9-]{10,}\b
  | \bAKIA[0-9A-Z]{16}\b | \bAIza[0-9A-Za-z_-]{35}\b | \bgsk_[A-Za-z0-9]{20,}\b
  | \bglpat-[A-Za-z0-9_-]{20,}\b | \bnpm_[A-Za-z0-9]{36}\b
  | \beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}
""")
EMAIL = re.compile(r"(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")
CARD = re.compile(r"(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])")
IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b")
SSN = re.compile(r"(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])")
# a phone number: optional +country, then 9-15 digits in groups; needs a + or a separator so plain numbers stay
PHONE = re.compile(r"(?<![\w+])(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}(?:[ .-]\d{2,4}){1,4}(?![\w-])|(?<![\w+])\+\d{9,15}\b")
IPV4 = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")
TOKEN = re.compile(r"\[(EMAIL|PHONE|CARD|IBAN|SSN|SECRET|TERM)_(\d+)\]")


def terms():
    try:
        with open(TERMS_PATH, encoding="utf-8") as f:
            return [t.strip() for t in f if t.strip() and not t.startswith("#")]
    except OSError:
        return []


class Mask:
    def __init__(self, path=MAP_PATH):
        self.path = path
        self.by_value, self.by_token = {}, {}
        self.dirty = False
        self.load()

    def load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                self.by_token = json.load(f)
        except (OSError, ValueError):
            self.by_token = {}
        self.by_value = {v: k for k, v in self.by_token.items()}

    def save(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        with open(self.path + ".lock", "w") as lock:   # several CLIs may run at once
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                with open(self.path, encoding="utf-8") as f:
                    theirs = json.load(f)
            except (OSError, ValueError):
                theirs = {}
            theirs.update(self.by_token)
            tmp = f"{self.path}.tmp{os.getpid()}"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(theirs, f)
            os.replace(tmp, self.path)
            self.by_token = theirs
            self.by_value = {v: k for k, v in theirs.items()}

    def token(self, kind, value):
        if value in self.by_value:
            return self.by_value[value]
        n = 1 + sum(1 for t in self.by_token if t.startswith(f"[{kind}_"))
        t = f"[{kind}_{n}]"
        while t in self.by_token:
            n += 1
            t = f"[{kind}_{n}]"
        self.by_token[t], self.by_value[value] = value, t
        self.dirty = True
        return t

    def mask(self, text):
        if not isinstance(text, str) or not text:
            return text
        self.dirty = False

        def sub(kind, pattern, check=None):
            nonlocal text

            def repl(m):
                v = m.group(0)
                return self.token(kind, v) if check is None or check(v) else v
            text = pattern.sub(repl, text)

        if "secret" in TYPES:
            sub("SECRET", SECRET)
        if "term" in TYPES:
            for t in sorted(terms(), key=len, reverse=True):
                sub("TERM", re.compile(r"(?<!\w)" + re.escape(t) + r"(?!\w)", re.IGNORECASE))
        if "email" in TYPES:
            sub("EMAIL", EMAIL)
        if "iban" in TYPES:
            sub("IBAN", IBAN, iban_ok)
        if "card" in TYPES:
            sub("CARD", CARD, lambda v: luhn(re.sub(r"\D", "", v)) and len(set(re.sub(r"\D", "", v))) > 1)
        if "ssn" in TYPES:
            sub("SSN", SSN)
        if "phone" in TYPES:
            sub("PHONE", PHONE, lambda v: 9 <= len(re.sub(r"\D", "", v)) <= 15 and not IPV4.fullmatch(v))
        if self.dirty:
            self.save()
        return text

    def unmask(self, text):
        if not isinstance(text, str) or "[" not in text:
            return text
        found = {m.group(0) for m in TOKEN.finditer(text)}
        if any(t not in self.by_token for t in found):
            self.load()   # another process added tokens
        return TOKEN.sub(lambda m: self.by_token.get(m.group(0), m.group(0)), text)

    def walk(self, obj, fn):
        if isinstance(obj, str):
            return fn(obj)
        if isinstance(obj, list):
            return [self.walk(x, fn) for x in obj]
        if isinstance(obj, dict):
            return {k: self.walk(v, fn) for k, v in obj.items()}
        return obj


def mask_user_message(mask, msg):
    """Claude Code stream-json input: mask the text of a user message, leave everything else alone."""
    if msg.get("type") != "user" or not isinstance(msg.get("message"), dict):
        return msg
    content = msg["message"].get("content")
    if isinstance(content, str):
        msg["message"]["content"] = mask.mask(content)
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                part["text"] = mask.mask(part.get("text", ""))
    return msg


def unmask_line(mask, line):
    if "[" not in line:
        return line
    stripped = line.strip()
    if stripped.startswith("{"):
        try:
            obj = json.loads(stripped)
        except ValueError:
            return mask.unmask(line)
        return json.dumps(mask.walk(obj, mask.unmask), ensure_ascii=False, separators=(",", ":")) + "\n"
    return mask.unmask(line)


def run(argv):
    mask = Mask()
    args = list(argv)
    stdin_mode = "inherit"
    if "--input-format" in args and args[args.index("--input-format") + 1:][:1] == ["stream-json"]:
        stdin_mode = "stream"
    elif args and args[-1] == "-":
        stdin_mode = "text"
    elif "--" in args:
        i = args.index("--")
        args = args[:i + 1] + [mask.mask(a) for a in args[i + 1:]]
    elif "-p" in args and args.index("-p") + 1 < len(args):
        i = args.index("-p") + 1
        args[i] = mask.mask(args[i])

    child = subprocess.Popen(args, stdin=subprocess.PIPE if stdin_mode != "inherit" else None,
                             stdout=subprocess.PIPE, bufsize=0)

    def feed():
        try:
            if stdin_mode == "text":
                child.stdin.write(mask.mask(sys.stdin.read()).encode())
            else:
                for line in sys.stdin:
                    s = line.strip()
                    if s.startswith("{"):
                        try:
                            line = json.dumps(mask_user_message(mask, json.loads(s)), ensure_ascii=False) + "\n"
                        except ValueError:
                            pass
                    child.stdin.write(line.encode())
                    child.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                child.stdin.close()
            except OSError:
                pass

    if stdin_mode != "inherit":
        threading.Thread(target=feed, daemon=True).start()
    out = sys.stdout.buffer
    for raw in iter(child.stdout.readline, b""):
        out.write(unmask_line(mask, raw.decode("utf-8", "replace")).encode())
        out.flush()
    return child.wait()


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["--mask"]:
        sys.stdout.write(Mask().mask(sys.stdin.read()))
    elif a[:1] == ["--unmask"]:
        sys.stdout.write(Mask().unmask(sys.stdin.read()))
    elif a:
        try:
            sys.exit(run(a))
        except FileNotFoundError as e:
            print(f"cage-mask: {e}", file=sys.stderr)
            sys.exit(127)
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
