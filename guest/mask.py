#!/usr/bin/env python3
"""cage's privacy mask: sensitive values in your messages are swapped for tokens like [EMAIL_1] before they reach
the AI model, and swapped back in what the agent says to you. Turned on per agent with `cage mask on`.

It sits between cc-connect and the agent's CLI (cc-connect's `cmd`), so it sees exactly what goes to the model:
  python3 mask.py [--types k,k] <cli> [args…]   run the CLI: mask its prompt, unmask its output
    stream-json on stdin (Claude Code):  each user message is masked, line by line (any other line too); so are
                                         your answers to its questions, and tools you approve run with the tokens
                                         the model wrote
    a prompt on stdin (`codex exec … -`): masked as a whole
    a prompt argument (after `--`, or `-p <prompt>`): masked
    anything else that asks for a prompt: refused, so the CLI never runs unmasked by mistake
  python3 mask.py --mask   < text    print the masked text (to try it: `cage mask try`)
  python3 mask.py --mask-lines       the same, each line on its own
  python3 mask.py --unmask < text    the reverse, with the same map

What it finds: email addresses, phone numbers, card numbers (Luhn, card network and length), IBANs (country length,
checksum), US social security numbers, API keys, tokens, passwords and private keys, and your own terms (one per
line in CAGE_MASK_TERMS, e.g. a client's name). Off unless named in CAGE_MASK_TYPES (or --types): public IP
addresses, MAC addresses, crypto wallets, dates of birth, passports, national ids, bank account numbers, street
addresses. The same value always gets the same token (the map is kept in CAGE_MASK_MAP), so the model can still
tell values apart; tokens not seen for CAGE_MASK_KEEP_DAYS (90) are forgotten.

What it doesn't see: files and pictures you send, and whatever the agent reads with its tools (web pages, your apps),
go to the model as they are. Standard library only, and Python 3.9+ (`cage mask try` runs it on your computer).
"""
import base64, bisect, fcntl, hashlib, io, ipaddress, json, os, re, subprocess, sys, threading, time

MAP_PATH = os.environ.get("CAGE_MASK_MAP") or os.path.expanduser("~/.cage/mask/map.json")
TERMS_PATH = os.environ.get("CAGE_MASK_TERMS") or "/etc/cage/mask.terms"
DEFAULT_TYPES = "email phone card iban ssn secret term"
EXTRA_TYPES = "ip mac crypto dob passport id bank address"   # off by default: more prose gets touched
TYPES = set(re.split(r"[\s,]+", (os.environ.get("CAGE_MASK_TYPES") or DEFAULT_TYPES).strip()))
try:
    KEEP_DAYS = float(os.environ.get("CAGE_MASK_KEEP_DAYS") or 90)
except ValueError:
    KEEP_DAYS = 90.0
KINDS = ("EMAIL", "PHONE", "CARD", "IBAN", "SSN", "SECRET", "TERM", "IP", "MAC", "CRYPTO", "DOB", "PASSPORT", "ID",
         "BANK", "ADDRESS")


# --- validators -----------------------------------------------------------------------------------------------------
def digits(s):
    return re.sub(r"\D", "", s)


LUHN2 = {str(n): (n * 2 - 9 if n > 4 else n * 2) for n in range(10)}


def luhn(d):
    """d: ASCII digits"""
    return (sum(int(c) for c in d[-1::-2]) + sum(LUHN2[c] for c in d[-2::-2])) % 10 == 0


def card_lengths(p):
    """the lengths of the card numbers a network issues with these first 6 digits (none: not a card prefix)"""
    p2, p3, p4, p6 = int(p[:2]), int(p[:3]), int(p[:4]), int(p[:6])
    if p[0] == "4":
        return (13, 16, 19)                                        # Visa
    if 51 <= p2 <= 55 or 2221 <= p4 <= 2720:
        return (16,)                                               # Mastercard
    if p2 in (34, 37):
        return (15,)                                               # Amex
    if 2200 <= p4 <= 2204:
        return (16, 17, 18, 19)                                    # Mir
    if p4 == 6011 or 644 <= p3 <= 649 or p2 in (62, 65) or 622126 <= p6 <= 622925:
        return (16, 17, 18, 19)                                    # Discover, UnionPay
    if 3528 <= p4 <= 3589:
        return (16, 17, 18, 19)                                    # JCB
    if 300 <= p3 <= 305 or p2 in (36, 38, 39):
        return (14, 15, 16, 17, 18, 19)                            # Diners
    if p2 == 50 or 56 <= p2 <= 69:
        return (12, 13, 14, 15, 16, 17, 18, 19)                    # Maestro (and RuPay 60, 508)
    if p2 in (81, 82):
        return (16,)                                               # RuPay
    return ()


CARD_PREFIXES = {}   # first 6 digits -> card_lengths(), as long runs of numbers repeat them


def card_ok(d):
    if not 13 <= len(d) <= 19 or len(set(d)) < 2:
        return False
    if d[:6] not in CARD_PREFIXES:
        CARD_PREFIXES[d[:6]] = card_lengths(d[:6])
    return len(d) in CARD_PREFIXES[d[:6]] and luhn(d)


IBAN_LEN = dict(AD=24, AE=23, AL=28, AT=20, AZ=28, BA=20, BE=16, BG=22, BH=22, BR=29, BY=28, CH=21, CR=22, CY=28, CZ=24,
                DE=22, DK=18, DO=28, EE=20, EG=29, ES=24, FI=18, FO=18, FR=27, GB=22, GE=22, GI=23, GL=18, GR=27, GT=28,
                HR=21, HU=28, IE=22, IL=23, IQ=23, IS=26, IT=27, JO=30, KW=30, KZ=20, LB=28, LC=32, LI=21, LT=20, LU=20,
                LV=21, MC=27, MD=24, ME=22, MK=19, MR=27, MT=31, MU=30, NL=18, NO=15, PK=24, PL=28, PS=29, PT=25, QA=29,
                RO=24, RS=22, SA=24, SC=31, SE=24, SI=19, SK=24, SM=27, ST=25, SV=28, TL=23, TN=24, TR=26, UA=29, VA=22,
                VG=24, XK=20)


def iban_ok(s):
    s = re.sub(r"[\s-]", "", s).upper()
    if IBAN_LEN.get(s[:2]) != len(s) or not s[2:4].isdigit() or not (s.isascii() and s.isalnum()):
        return False
    return int("".join(str(int(c, 36)) for c in s[4:] + s[:4])) % 97 == 1


VERHOEFF_D = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
              [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
              [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
              [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]]
VERHOEFF_P = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
              [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
              [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]]


def verhoeff(d):
    c = 0
    for i, ch in enumerate(reversed(d)):
        c = VERHOEFF_D[c][VERHOEFF_P[i % 8][int(ch)]]
    return c == 0


def aba_ok(d):
    return len(d) == 9 and sum(int(a) * w for a, w in zip(d, [3, 7, 1] * 3)) % 10 == 0


B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58check(s):
    n = 0
    for c in s:
        i = B58.find(c)
        if i < 0:
            return False
        n = n * 58 + i
    if n.bit_length() > 200:
        return False
    raw = n.to_bytes(25, "big")
    return hashlib.sha256(hashlib.sha256(raw[:-4]).digest()).digest()[:4] == raw[-4:]


def bech32_ok(s):
    s = s.lower()
    cs = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    hrp, _, data = s.rpartition("1")
    if not hrp or len(data) < 6 or any(c not in cs for c in data):
        return False
    gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp] + [cs.index(c) for c in data]:
        b = chk >> 25
        chk = (chk & 0x1ffffff) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if (b >> i) & 1 else 0
    return chk in (1, 0x2bc830a3)   # bech32, bech32m


# --- detectors ------------------------------------------------------------------------------------------------------
# Every pattern must stay linear on hostile input (a pasted log, a base64 blob): no unbounded repeat followed by
# something that can fail, unless a lookbehind lets it start only once per run. Python 3.9 has no atomic groups.
PEM_BEGIN = re.compile(r"-----BEGIN[ A-Z]{0,40}PRIVATE KEY(?: BLOCK)?-----")
PEM_END = re.compile(r"-----END[ A-Z]{0,40}PRIVATE KEY(?: BLOCK)?-----")


def key_re(lit, rest, after=r"[A-Za-z0-9_-]"):
    """a key that starts with the text lit, where a run of key characters starts. The literal comes first in the
    pattern, so re finds candidates quickly instead of trying every position."""
    e = re.escape(lit)
    return re.compile(e + "(?<!" + after + e + ")" + rest)


SECRET_RES = [
    key_re("sk_live_", r"[A-Za-z0-9]{10,}"), key_re("sk_test_", r"[A-Za-z0-9]{10,}"), key_re("rk_live_", r"[A-Za-z0-9]{10,}"),
    key_re("rk_test_", r"[A-Za-z0-9]{10,}"), key_re("pk_live_", r"[A-Za-z0-9]{10,}"), key_re("whsec_", r"[A-Za-z0-9]{20,}"),
    key_re("sk-", r"(?:proj-|svcacct-|admin-|ant-(?:api|oat|admin)\d\d-)?[A-Za-z0-9_-]{20,}"),
    key_re("gh", r"[pousr]_[A-Za-z0-9]{30,}"), key_re("github_pat_", r"[A-Za-z0-9_]{40,}"), key_re("glpat-", r"[A-Za-z0-9_-]{20,}"),
    key_re("xox", r"[abposr]-[A-Za-z0-9-]{10,}"), key_re("xapp-", r"[A-Za-z0-9-]{10,}"),
    re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+"),
    key_re("A", r"(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA)[0-9A-Z]{16}(?![A-Za-z0-9])", r"[A-Za-z0-9]"),
    key_re("AIza", r"[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])"), key_re("GOCSPX-", r"[A-Za-z0-9_-]{20,}"),
    key_re("ya29.", r"[0-9A-Za-z_-]{20,}"), key_re("gsk_", r"[A-Za-z0-9]{20,}"), key_re("npm_", r"[A-Za-z0-9]{36}(?![A-Za-z0-9])"),
    key_re("hf_", r"[A-Za-z0-9]{30,}"), key_re("pypi-AgEIcHlwaS5vcmc", r"[A-Za-z0-9_-]{40,}"),
    key_re("SG.", r"[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}(?![A-Za-z0-9_-])"),
    key_re("SK", r"[0-9a-f]{32}(?![A-Za-z0-9])", r"[A-Za-z0-9]"), key_re("AC", r"[0-9a-f]{32}(?![A-Za-z0-9])", r"[A-Za-z0-9]"),
    key_re("shp", r"(?:at|ss|ca|pa)_[0-9a-fA-F]{32}(?![A-Za-z0-9])"), key_re("do", r"[por]_v1_[0-9a-f]{64}(?![A-Za-z0-9])"),
    key_re("AGE-SECRET-KEY-1", r"[0-9A-Z]{58}(?![A-Za-z0-9])"),
] + [key_re(c, r"[A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}(?![A-Za-z0-9_-])") for c in "MNO"] + [   # Discord bot
    key_re("eyJ", r"[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),                    # JWT
]
# secrets known only by what comes before them: the value (group 1) is masked
SECRET_CTX = re.compile(r"""(?ix)(?<![a-z])
    (aws_secret_access_key|secret_access_key|AccountKey|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token|
     secret|token|passwd|password|passwort|mot\ de\ passe|contraseña|pwd|pw|pass)
    ["']?\s*([:=]|\bis\b|\bist\b|\best\b)\s*["']?
    ([^\s"',;]{6,200})""")
# a command line's password flag (--password X, --token=X), and curl's -u user:password
CLI_SECRET = re.compile(r"(?<![\w-])--(password|passwd|pass|token|api-key|secret)(?:=|[ \t]+)[\"']?([^\s\"']{4,200})")
CURL_USER = re.compile(r"(?<!\S)(?:-u|--user)(?:=|[ \t]+)[\"']?[^\s:\"']{1,100}:([^\s\"']{1,200})")
BASIC = re.compile(r"(?i)\bbasic\s+([A-Za-z0-9+/]{8,400}={0,2})(?![\w+/=])")   # Authorization: Basic base64(user:password)
NOT_SECRET = {"none", "null", "nil", "true", "false", "required", "optional", "undefined", "empty", "redacted", "hidden",
              "changeit", "unknown", "invalid", "expired", "missing", "correct", "incorrect", "wrong", "secret", "string"}
CODE_REF = re.compile(r"^[A-Za-z_$][\w.$]*[(\[{]|^(?:os|process|self|this|env|config|settings|request|req|params|args)\.")
BEARER = re.compile(r"(?i)\b(?:bearer|token)\s+([A-Za-z0-9._~+/-]{20,}=*)")
URL_CRED = re.compile(r"(?i)(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}://[^/\s:@]{0,100}:([^\s/]{1,200}?)@(?=[\w.-]{1,253}(?::\d{1,5})?(?:[/?#\s]|$))")
AWS_SECRET = re.compile(r"(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])")
AWS_CTX = re.compile(r"(?i)aws|secret")
TELEGRAM = re.compile(r":AA[A-Za-z0-9_-]{30,}")   # a bot token, after 8-10 digits (checked in spans)
EVM_KEY = re.compile(r"(?i)(?:private|priv|secret)[\w ]{0,20}?[:=]?\s*(0x[0-9a-f]{64})\b")
SEED = re.compile(r"(?i)(?:seed|recovery|mnemonic|secret)\s+(?:phrase|words?)\s*[:=]?\s*((?:[a-z]{3,8}\s+){11,23}[a-z]{3,8})")

EMAIL = re.compile(r"(?<![\w.%+'-])[\w%+-][\w.%+'-]*@[\w-]+(?:\.[\w-]+)*\.[^\W\d_]{2,}(?![\w-])")
EMAIL_ENC = re.compile(r"(?<![\w.%+-])[\w.+-]+%40[\w-]+(?:\.[\w-]+)+")
RETINA = re.compile(r"@\d+x\.(?:png|jpe?g|gif|webp|svg|avif)$", re.I)   # icon@2x.png is a file, not an address

CARD = re.compile(r"(?<![0-9.-])[0-9]{1,19}(?:[ .-][0-9]{1,19})*(?![0-9])")   # a run of digit groups; cards are found inside
IBAN_START = re.compile(r"(?i)\b([A-Z]{2})(\d{2})(?=[ -]?[A-Z0-9])")
SSN = re.compile(r"(?<![\d-])(?!000|666|9)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\d-])")
SSN_CTX = re.compile(r"(?i)\b(?:ssn|social security(?: number)?|itin)\b[^\d\n]{0,15}(\d{3}[- ]?\d{2}[- ]?\d{4})(?!\d)")

# phones, by shape: international (+ or 00), North American, national with a trunk 0; or after a word like "phone"
NOT_AFTER = r"(?![\w-]|[.,:]\d)"
PH_INTL = re.compile(r"(?<![\w+])(?:\+|\b00)[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\(\d{1,4}\))?[ .-]?\d{1,12}(?:[ .-]\d{1,8}){0,5}" + NOT_AFTER)
PH_NANP = re.compile(r"(?<![\w+(-])(?:1[ .-])?(?:\([2-9]\d{2}\) ?|[2-9]\d{2}[ .-])\d{3}[ .-]\d{4}" + NOT_AFTER)
PH_TRUNK = re.compile(r"(?<![\w+.-])0[1-9]\d{0,4}(?:[ ./-]\d{2,8}){1,4}" + NOT_AFTER)
PH_CTX = re.compile(r"(?i)\b(?:phone|tel(?:ephone|efon|éfono|efone)?|mobile?|mob|cell|call|text|sms|whatsapp|fax|handy|"
                    r"portable|móvil|téléphone|ph)\b\.?[^\n\d+]{0,12}(\+?\(?\d[\d ().-]{5,20}\d)" + NOT_AFTER)
DATEISH = re.compile(r"^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(?:[ T]\d{1,2}[.:]\d{2})?$")
CODE_BEFORE = re.compile(r"[A-Za-z0-9]*\d[A-Za-z0-9]* $")   # "AA1 0123 4567 84": the end of a longer code
YEARS = re.compile(r"^(?:(?:19|20)\d\d\s+)+(?:19|20)\d\d$")
# after "call" or "text", an amount rather than a number to dial: 1 234 567, 1.234.567, 1234567.89; "call count: …"
AMOUNT = re.compile(r"^(?:[1-9]\d{0,2}([ .])\d{3}(?:\1\d{3})*|\d+)(?:[.,]\d{1,2})?$")
METRIC = re.compile(r"(?i)\b(?:count|total|sum|rate|volume|duration|length|size|minutes?|mins|hours?|seconds?|secs|"
                    r"cost|price|revenue|per|sent|received|made|logs?|records?|ids?|stack|depth|chars|characters|bytes|"
                    r"words|limit|quota|budget|fees?|charges?|attempts?|retries)\b")

IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.]|\.\d)")
IPV6 = re.compile(r"(?<![\w:])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:])")
PRIVATE_NETS = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7")]
MAC = re.compile(r"(?<![\w:-])[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}(?![\w:-])")
BTC = re.compile(r"\b(?:[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[02-9ac-hj-np-z]{11,71})\b")
ETH = re.compile(r"\b0x[0-9a-fA-F]{40}\b")
MONTHS = (r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|"
          r"oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)")
DATE = (r"(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.?\s+" + MONTHS + r"\.?\s+\d{4}|"
        + MONTHS + r"\.?\s+\d{1,2},?\s+\d{4})")
DOB = re.compile(r"(?i)\b(?:born|birth(?:day|date)?|dob|d\.o\.b\.?|geb(?:oren|\.)|date de naissance|né(?:e)? le|nacimiento)\b"
                 r"[^\n\d]{0,20}?(" + DATE + ")")
PASSPORT = re.compile(r"(?i)\b(?:passport|reisepass|passeport|pasaporte|passaporto)\b[^\n\w]{0,3}(?:(?:no|nr|number|num|#)\b\.?)?"
                      r"[^\n\w]{0,3}(?:\([A-Z]{2}\)\s*)?([A-Z0-9]{6,9})\b(?![\w-])")
NINO = re.compile(r"(?i)\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b")
PAN = re.compile(r"\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b")
AADHAAR = re.compile(r"(?<![\d-])[2-9]\d{3} ?\d{4} ?\d{4}(?![\d-])")
MBI = re.compile(r"\b[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y\d]\d-?[AC-HJKMNP-RT-Y]{2}\d{2}\b")
ID_CTX = re.compile(r"(?i)\b(?:SIN|social insurance|driver'?s? licen[cs]e|licen[cs]e no|steuer-?id|tax id|TIN|national id|"
                    r"personalausweis|DNI|NIE|codice fiscale|BSN|PESEL|CPF|PAN|aadhaar|UIDAI|NI number|NINO)\b[^\n\w]{0,3}"
                    r"(?:\([A-Z]{2}\)\s*)?(?:no\.?|number|nr\.?|#)?[^\n\w]{0,3}([A-Z0-9][A-Z0-9 .-]{5,18}[A-Z0-9])(?![\w-])")
BANK_CTX = re.compile(r"(?i)\b(?:sort code|routing(?: number)?|ABA|account(?: number| no\.?| #)?|acct\.?|konto(?:nummer)?|BLZ|BSB)\b"
                      r"[^\n\d]{0,4}(\d[\d -]{4,20}\d)(?![\d-])")
STREET = (r"(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Way|Parkway|Pkwy\.?|Court|Ct\.?|"
          r"Place|Pl\.?|Square|Sq\.?|Terrace|Close|Crescent|Highway|Hwy\.?)")
ADDRESS = re.compile(r"\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][\w'-]*\s+){1,3}" + STREET + r"(?![\w])"
                     r"(?:,?\s+[A-Z][a-z][\w'-]*(?:\s[A-Z][a-z][\w'-]*){0,2})?"
                     r"(?:,?\s+(?:[A-Z]{2}\s+\d{5}(?:-\d{4})?|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}))?")
ADDRESS_DE = re.compile(r"\b[A-ZÄÖÜ][\wäöüß-]*(?:straße|strasse|str\.|weg|allee|platz|gasse)\s+\d{1,4}[a-z]?,?\s+\d{5}\s+[A-ZÄÖÜ][\wäöüß-]+")

KIND_RE = "|".join(KINDS)
TOKEN = re.compile(r"\[(" + KIND_RE + r")_(\d+)\]")
# What a model may turn a token into: [email_1], EMAIL_1, [EMAIL 1], \[EMAIL\_1\], ［EMAIL_1］ (groups: left bracket,
# kind, separator, number, right bracket). 〔EMAIL_1〕 and 〘EMAIL_1〙 are tokens the USER typed: never a real value.
TOKEN_FUZZY = re.compile(r"(?<![〔〘])(\\?[\[［【]\s{0,3})?\b(" + KIND_RE + r")(\\?_|[ -])0*(\d{1,6})\b(\s{0,3}\\?[\]］】])?", re.I)
LITERAL = re.compile("〔(\\s{0,3}(?:" + KIND_RE + r")(?:\\?_|[ -])\d{1,6}\s{0,3})〕|〘((?:" + KIND_RE + r")_\d{1,6})〙", re.I)
KIND_LOWER = [k.lower() for k in KINDS]
AFTER_KIND = re.compile(r"(?:\\?_|[ -])0*\d")


def token_spots(text):
    """where a token could be: each kind name (any case) followed by a separator and a digit. A plain substring
    search, so most of a 10 MB tool result costs nothing; a case-insensitive regex would scan it slowly."""
    low = text.lower()
    if len(low) != len(text):   # a few letters change length in lower case (İ): fall back to the slow scan
        return [m.start(2) for m in TOKEN_FUZZY.finditer(text)]
    spots = []
    for k in KIND_LOWER:
        i = low.find(k)
        while i >= 0:
            if AFTER_KIND.match(low, i + len(k)):
                spots.append(i)
            i = low.find(k, i + 1)
    return spots


def spans(text, terms_re=None, types=None):
    """[(start, end, KIND)] of what to mask in text, sorted and disjoint. Every detector proposes spans with a
    priority; an overlap goes to the higher priority (a lower number), then to the longer span."""
    types = TYPES if types is None else types
    low = text.lower()
    out = []

    def add(s, e, kind, prio):
        if e > s:
            out.append((prio, s - e, s, e, kind))

    if "secret" in types:
        ends = [m.end() for m in PEM_END.finditer(text)]
        pos = 0
        for m in PEM_BEGIN.finditer(text):   # a private key block, to its END line (or, if cut off, a blank line)
            if m.start() < pos:
                continue
            i = bisect.bisect_left(ends, m.end() + 1)
            if i < len(ends):
                stop = ends[i]
            else:
                body = m.end()
                while body < len(text) and text[body] in "\r\n":
                    body += 1   # a PGP block starts with a blank line
                stop = text.find("\n\n", body)
                stop = len(text) if stop < 0 else stop
            add(m.start(), stop, "SECRET", 0)
            pos = stop
        for r in SECRET_RES:
            for m in r.finditer(text):
                if m.group(0).startswith("sk-") and len(digits(m.group(0))) < 2:
                    continue   # sk-button-primary-… is a CSS class, not a key
                add(m.start(), m.end(), "SECRET", 0)
        for m in TELEGRAM.finditer(text):
            i = m.start()
            while i > 0 and text[i - 1].isdigit() and m.start() - i <= 10:
                i -= 1
            if 8 <= m.start() - i <= 10 and not (i > 0 and text[i - 1] == ":"):
                add(i, m.end(), "SECRET", 0)
        # the patterns below ignore case, which makes re try every position: run each only if its words are there
        for r, words in ((URL_CRED, ("://",)), (BEARER, ("bearer", "token")), (EVM_KEY, ("0x",)),
                         (SEED, ("seed", "recovery", "mnemonic", "secret"))):
            if any(w in low for w in words):
                for m in r.finditer(text):
                    add(m.start(1), m.end(1), "SECRET", 1)
        for m in SECRET_CTX.finditer(text) if any(w in low for w in ("pass", "pw", "secret", "token", "key", "contrase")) else ():
            v, s, e = m.group(3), m.start(3), m.end(3)
            while v[-1:] in (".", ":") and len(v) > 1:
                v, e = v[:-1], e - 1   # the end of a sentence
            if secretish(m.group(1), m.group(2), v):
                add(s, e, "SECRET", 1)
        for m in CLI_SECRET.finditer(text) if "--" in text else ():
            if secretish(m.group(1), ":", m.group(2)):
                add(m.start(2), m.end(2), "SECRET", 1)
        if "curl" in low:   # only curl's -u: `docker run -u 1000:1000` is a user and a group
            curls = [c.start() for c in re.finditer("curl", low)]
            # where command lines end: a line ending in \ (or cmd's ^), as "copy as cURL" writes them, goes on
            lines = [n.start() for n in re.finditer("\n", text)
                     if text[max(0, n.start() - 2):n.start()].rstrip("\r")[-1:] not in ("\\", "^")]
            for m in CURL_USER.finditer(text):
                i = bisect.bisect_left(curls, m.start()) - 1   # the last "curl" before it, in the same command
                line = lines[bisect.bisect_left(lines, m.start()) - 1] if lines and lines[0] < m.start() else -1
                if i >= 0 and curls[i] > line and secretish("-u", ":", m.group(1)):
                    add(m.start(1), m.end(1), "SECRET", 1)
        for m in BASIC.finditer(text) if "basic" in low else ():
            try:
                plain = base64.b64decode(m.group(1), validate=True).decode("utf-8")
            except (ValueError, UnicodeDecodeError):
                continue
            if ":" in plain and plain.isprintable():   # base64 of user:password
                add(m.start(1), m.end(1), "SECRET", 1)
        for m in AWS_SECRET.finditer(text) if "aws" in low or "secret" in low else ():
            v = m.group(0)
            if (any(c.isupper() for c in v) and any(c.islower() for c in v) and any(c.isdigit() for c in v)
                    and AWS_CTX.search(text, max(0, m.start() - 60), m.start())):
                add(m.start(), m.end(), "SECRET", 1)
    if "email" in types:
        for m in EMAIL.finditer(text):
            v = m.group(0)
            if RETINA.search(v) or (v.lower().startswith("git@") and text[m.end():m.end() + 1] == ":"):
                continue   # git@github.com:org/repo is an address for git, not a person
            add(m.start(), m.end(), "EMAIL", 2)
        for m in EMAIL_ENC.finditer(text):
            add(m.start(), m.end(), "EMAIL", 2)
    if "iban" in types:
        for m in IBAN_START.finditer(text):
            want = IBAN_LEN.get(m.group(1).upper())
            if not want:
                continue
            # exactly the country's length in letters and digits, with single spaces or dashes between them
            n, i = 4, m.end()
            while n < want and i < len(text):
                c = text[i]
                if c.isascii() and c.isalnum():
                    n, i = n + 1, i + 1
                elif c in " -" and i + 1 < len(text) and text[i + 1].isascii() and text[i + 1].isalnum():
                    i += 1
                else:
                    break
            if n == want and not (i < len(text) and text[i].isalnum()) and iban_ok(text[m.start():i]):
                add(m.start(), i, "IBAN", 3)
    if "card" in types:
        for m in CARD.finditer(text):
            card_spans(m, add)
    if "ssn" in types:
        for m in SSN.finditer(text):
            add(m.start(), m.end(), "SSN", 5)
        for m in SSN_CTX.finditer(text) if "ssn" in low or "social security" in low or "itin" in low else ():
            add(m.start(1), m.end(1), "SSN", 5)
    if "id" in types:
        for r in (NINO, PAN, MBI):
            for m in r.finditer(text):
                add(m.start(), m.end(), "ID", 6)
        for m in AADHAAR.finditer(text):
            if verhoeff(digits(m.group(0))):
                add(m.start(), m.end(), "ID", 6)
        for m in ID_CTX.finditer(text):
            if sum(c.isdigit() for c in m.group(1)) >= 4:
                add(m.start(1), m.end(1), "ID", 6)
    if "passport" in types:
        for m in PASSPORT.finditer(text):
            if any(c.isdigit() for c in m.group(1)):
                add(m.start(1), m.end(1), "PASSPORT", 6)
    if "bank" in types:
        for m in BANK_CTX.finditer(text):
            d = digits(m.group(1))
            if len(d) != 9 or aba_ok(d) or not re.search(r"(?i)routing|aba", m.group(0)):
                add(m.start(1), m.end(1), "BANK", 6)
    if "dob" in types:
        for m in DOB.finditer(text):
            add(m.start(1), m.end(1), "DOB", 6)
    if "crypto" in types:
        for m in BTC.finditer(text):
            v = m.group(0)
            if bech32_ok(v) if v.startswith("bc1") else base58check(v):
                add(m.start(), m.end(), "CRYPTO", 6)
        for m in ETH.finditer(text):
            add(m.start(), m.end(), "CRYPTO", 6)
    if "phone" in types:
        for r, lo in ((PH_INTL, 8), (PH_NANP, 10), (PH_TRUNK, 9)):
            for m in r.finditer(text):
                v = m.group(0)
                if v.startswith("00") and (len(digits(v)) < 10 or not re.search(r"[ .()-]", v)):
                    continue   # "#00123456" is a case number; "0049 30 1234567" is a phone
                if r is PH_TRUNK and CODE_BEFORE.search(text, max(0, m.start() - 20), m.start()):
                    continue
                if lo <= len(digits(v)) <= 15 and not DATEISH.match(v):
                    add(m.start(), m.end(), "PHONE", 7)
        ctx = ("ph", "tel", "tél", "mob", "móvil", "cell", "call", "text", "sms", "whatsapp", "fax", "handy", "portable")
        for m in PH_CTX.finditer(text) if any(w in low for w in ctx) else ():
            v = m.group(1).strip()
            if (7 <= len(digits(v)) <= 15 and not DATEISH.match(v) and not YEARS.match(v)
                    and not (AMOUNT.match(v) and not v.startswith("0") and not v.isdigit())
                    and not METRIC.search(text, m.start(), m.start(1))):
                add(m.start(1), m.end(1), "PHONE", 7)
    if "ip" in types:
        for m in IPV4.finditer(text):
            try:
                ip = ipaddress.IPv4Address(m.group(0))
            except ValueError:
                continue
            if not (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved
                    or any(ip in n for n in PRIVATE_NETS)):
                add(m.start(), m.end(), "IP", 8)
        for m in IPV6.finditer(text):
            if m.group(0).count(":") < 2:
                continue
            try:
                ip = ipaddress.IPv6Address(m.group(0))
            except ValueError:
                continue
            if not (ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast or any(ip in n for n in PRIVATE_NETS)):
                add(m.start(), m.end(), "IP", 8)
    if "mac" in types:
        for m in MAC.finditer(text):
            if m.group(0).lower().replace("-", ":") not in ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"):
                add(m.start(), m.end(), "MAC", 8)
    if "address" in types:
        for r in (ADDRESS, ADDRESS_DE):
            for m in r.finditer(text):
                add(m.start(), m.end(), "ADDRESS", 8)
    if "term" in types and terms_re is not None:
        for m in terms_re.finditer(text):   # last, so an email that contains a name stays one email
            add(m.start(), m.end(), "TERM", 9)
    out.sort()
    starts, ends, chosen = [], [], []   # accepted spans, kept sorted and disjoint
    for _, _, s, e, kind in out:
        i = bisect.bisect_left(starts, s)
        if (i > 0 and ends[i - 1] > s) or (i < len(starts) and starts[i] < e):
            continue
        starts.insert(i, s)
        ends.insert(i, e)
        chosen.append((s, e, kind))
    chosen.sort()
    return chosen


def card_spans(m, add):
    """cards in a run of digit groups: from the left, the longest window of groups that is a valid card number, so
    '4111 1111 1111 1111 12/27' (with its expiry) and two cards in one run are both found"""
    run = m.group(0)
    groups = [(g.start(), g.end()) for g in re.finditer(r"[0-9]+", run)]
    d = "".join(run[a:b] for a, b in groups)
    off = [0]
    for a, b in groups:
        off.append(off[-1] + b - a)
    i = 0
    while i < len(groups):
        p = d[off[i]:off[i] + 6]
        if len(p) < 6:
            break
        if p not in CARD_PREFIXES:
            CARD_PREFIXES[p] = card_lengths(p)
        lengths, best = CARD_PREFIXES[p], None
        for j in range(i, len(groups)) if lengths else ():
            n = off[j + 1] - off[i]
            if n > 19:
                break
            if n >= 13 and n in lengths and len(set(d[off[i]:off[j + 1]])) > 1 and luhn(d[off[i]:off[j + 1]]):
                best = j
        if best is None:
            i += 1
            continue
        add(m.start() + groups[i][0], m.start() + groups[best][1], "CARD", 4)
        i = best + 1


def secretish(key, sep, v):
    """is this value after "password:" (or "token is") a secret, rather than code or a word?"""
    low = v.lower().rstrip(")]}")
    if v.startswith(("$", "[", "<", "{", "%", "*", "〔", "〘")) or low in NOT_SECRET or low == key.lower():
        return False
    if len(set(v)) < 3 or CODE_REF.search(v):
        return False   # "******", os.environ["X"], get_password()
    if sep in (":", "="):
        return True
    # "my password is …": a password has a digit, a symbol or a capital inside; "the token is invalid" is prose
    w = v.rstrip(".,:;!?)")
    return any(c.isdigit() or not c.isalnum() for c in w) or any(c.isupper() for c in w[1:])


def normalize(kind, v):
    """the map's key for a value: the same email, number or term written differently gets the same token"""
    if kind in ("PHONE", "CARD", "SSN", "BANK"):
        return kind + ":" + digits(v)
    if kind in ("IBAN", "ID", "PASSPORT", "MAC"):
        return kind + ":" + re.sub(r"[\s.:-]", "", v).upper()
    if kind == "TERM":
        return kind + ":" + re.sub(r"[\s_.-]+", "", v).casefold()
    if kind in ("EMAIL", "ADDRESS"):
        return kind + ":" + re.sub(r"\s+", " ", v.replace("%40", "@")).strip().casefold()
    return kind + ":" + v


def read_terms(path):
    """your terms, one per line (cage writes this file, so every line is a term, '#ProjectX' too)"""
    try:
        with open(path, encoding="utf-8") as f:
            return [t.strip() for t in f if t.strip()]
    except (OSError, ValueError):
        return []


def terms_regex(terms):
    """one pattern for all your terms. Words may be joined by spaces, a line break, _ . - or nothing ("Acme Corp",
    "Acme  Corp", "AcmeCorp"); a two-word name also matches the other way round ("Doe, Jane")."""
    alts = []
    for t in sorted(set(terms), key=len, reverse=True):
        words = [w for w in re.split(r"[\s_.-]+", t) if w]
        if not words:
            continue
        alts.append(r"[\s_.-]*".join(re.escape(w) for w in words))
        if len(words) == 2:
            alts.append(re.escape(words[1]) + r",\s*" + re.escape(words[0]))
    if not alts:
        return None
    return re.compile(r"(?<!\w)(?:" + "|".join(alts) + r")(?!\w)", re.IGNORECASE)


# --- the token map --------------------------------------------------------------------------------------------------
# map.json keeps the format older versions of this file read and write ({"[EMAIL_1]": "bob@example.com"}), so
# going back to an older cage never breaks the mask. map.json.meta adds when each token was last seen, and the
# highest number each kind has used, so a forgotten token's number is never given to another value.
class Mask:
    def __init__(self, path=MAP_PATH, terms_path=None):
        self.path = path
        self.terms_path = terms_path or TERMS_PATH
        self.entries, self.seen, self.next, self.by_key = {}, {}, {}, {}
        self._stamp = None
        self._terms = (None, None, {})   # (file stamp, pattern, {normalized key: your spelling})
        self._mu = threading.Lock()      # the CLI's input and output are handled on two threads
        self.typed = set()               # tokens someone typed (literal()): never unmasked by this process
        with self._mu:
            self._refresh()

    def _read(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
        try:
            with open(self.path + ".meta", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            meta = {}
        entries = {}
        if isinstance(data, dict):
            for tok, v in data.items():
                if isinstance(v, str) and TOKEN.fullmatch(tok):
                    entries[tok] = v
        seen = meta.get("seen") if isinstance(meta, dict) and isinstance(meta.get("seen"), dict) else {}
        nxt = meta.get("next") if isinstance(meta, dict) and isinstance(meta.get("next"), dict) else {}
        now = time.time()
        self.entries = entries
        self.seen = {t: float(seen[t]) if isinstance(seen.get(t), (int, float)) else now for t in entries}
        self.next = {k: int(n) for k, n in nxt.items() if k in KINDS and isinstance(n, int)}
        self.by_key = {}
        for tok in sorted(entries, key=lambda t: int(TOKEN.fullmatch(t).group(2))):
            kind = TOKEN.fullmatch(tok).group(1)
            self.by_key.setdefault(self.key(kind, entries[tok]), tok)
            self.next[kind] = max(self.next.get(kind, 1), int(TOKEN.fullmatch(tok).group(2)) + 1)

    def _refresh(self):
        """re-read the map if another process changed it (each write replaces the file, so its inode changes)"""
        try:
            st = os.stat(self.path)
            stamp = (st.st_ino, st.st_mtime_ns, st.st_size)
        except OSError:
            stamp = None
        if stamp != self._stamp or stamp is None:
            self._read()
            self._stamp = stamp

    def _write(self):
        if KEEP_DAYS > 0:
            cutoff = time.time() - KEEP_DAYS * 86400
            for tok in [t for t, s in self.seen.items() if s < cutoff]:
                self.entries.pop(tok, None)
                self.seen.pop(tok, None)
        for path, data in ((self.path + ".meta", {"seen": self.seen, "next": self.next}), (self.path, self.entries)):
            tmp = "%s.tmp%d" % (path, os.getpid())
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp, path)
        st = os.stat(self.path)
        self._stamp = (st.st_ino, st.st_mtime_ns, st.st_size)
        self.by_key = {}
        for tok in sorted(self.entries, key=lambda t: int(TOKEN.fullmatch(t).group(2))):
            self.by_key.setdefault(self.key(TOKEN.fullmatch(tok).group(1), self.entries[tok]), tok)

    def key(self, kind, v):
        k = normalize(kind, v)
        if kind == "TERM" and k not in self._terms[2] and "," in v:
            last, first = v.split(",", 1)   # "Doe, Jane" is the term "Jane Doe"
            alt = normalize(kind, first + last)
            if alt in self._terms[2]:
                return alt
        return k

    def tokens_for(self, found):
        """found: [(kind, value)] -> {(kind, value): token}. Tokens are handed out under a lock, against the map as it
        is on disk right then, so two chats running at once never give one token to two values."""
        out = {}
        if not found:
            return out
        now = time.time()
        with self._mu:
            os.makedirs(os.path.dirname(self.path) or ".", mode=0o700, exist_ok=True)
            with open(self.path + ".lock", "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                self._refresh()
                dirty = False
                for kind, v in found:
                    if (kind, v) in out:
                        continue
                    k = self.key(kind, v)
                    tok = self.by_key.get(k)
                    if tok is None:
                        n = self.next.get(kind, 1)
                        tok = "[%s_%d]" % (kind, n)
                        self.next[kind] = n + 1
                        # a term comes back the way you wrote it in your list
                        self.entries[tok] = self._terms[2].get(k, v) if kind == "TERM" else v
                        self.by_key[k] = tok
                        dirty = True
                    if now - self.seen.get(tok, 0) > 3600:
                        self.seen[tok] = now   # in use: don't forget it (written at most hourly)
                        dirty = True
                    out[(kind, v)] = tok
                if dirty:
                    self._write()
        return out

    def value(self, tok):
        with self._mu:
            self._refresh()   # another process may have added it, or `cage mask forget` dropped the map
            return self.entries.get(tok)

    # -- mask / unmask
    def terms_re(self):
        try:
            st = os.stat(self.terms_path)
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError:
            stamp = None
        if self._terms[0] != stamp:
            terms = read_terms(self.terms_path) if stamp else []
            self._terms = (stamp, terms_regex(terms), {normalize("TERM", t): t for t in terms})
        return self._terms[1]

    def find(self, text):
        return spans(text, self.terms_re())

    def mask(self, text):
        if not isinstance(text, str) or not text:
            return text
        text = literal(text, lambda tok: self.value(tok) is not None, self.typed)
        found = self.find(text)
        if not found:
            return text
        toks = self.tokens_for([(kind, text[s:e]) for s, e, kind in found])
        out, last = [], 0
        for s, e, kind in found:
            out.append(text[last:s])
            out.append(toks[(kind, text[s:e])])
            last = e
        out.append(text[last:])
        return "".join(out)

    def unmask(self, text):
        if not isinstance(text, str) or not text:
            return text
        out, last = [], 0
        for m in fuzzy_tokens(text):
            form = token_form(m)
            lb, kind, _, n, rb = m.groups()
            tok = "[%s_%d]" % (kind.upper(), int(n))
            v = self.value(tok) if form and tok not in self.typed else None
            if v is None:
                continue   # (a token someone typed stays a token, even with its brackets dropped: "repeat it without them")
            if form == "bare":
                v = (lb or "") + v + (rb or "")   # a lone bracket stays
            elif lb == "[" and rb == "]" and text[m.end():m.end() + 1] == "(":
                v = "[" + v + "]"   # [EMAIL_1](mailto:[EMAIL_1]) is a markdown link: keep its brackets
            out.append(text[last:m.start()])
            out.append(v)
            last = m.end()
        if last:
            out.append(text[last:])
            text = "".join(out)
        if "\u3014" in text or "\u3018" in text:   # tokens you typed, as you typed them (literal())
            text = LITERAL.sub(lambda m: "[" + m.group(1) + "]" if m.group(1) is not None else m.group(2), text)
        return text

    def walk(self, obj, fn):
        if isinstance(obj, str):
            return fn(obj)
        if isinstance(obj, list):
            return [self.walk(x, fn) for x in obj]
        if isinstance(obj, dict):
            return {k: self.walk(v, fn) for k, v in obj.items()}
        return obj


def fuzzy_tokens(text):
    """TOKEN_FUZZY's matches in text, in order and apart, looked for only around token spots"""
    last = 0
    for a, b in windows(token_spots(text)):
        for m in TOKEN_FUZZY.finditer(text, a, b):
            if m.start() >= last:
                last = m.end()
                yield m


def windows(spots):
    """merged stretches of text around token spots, wide enough for any form of a token"""
    out = []
    for i in sorted(spots):
        a, b = max(0, i - 8), i + 48
        if out and a <= out[-1][1]:
            out[-1][1] = b
        else:
            out.append([a, b])
    return out


def token_form(m):
    """a TOKEN_FUZZY match that stands for a token: "bracketed" ([EMAIL_1], [email_1], [EMAIL 1], \\[EMAIL\\_1\\],
    ［EMAIL_1］) or "bare" (exactly EMAIL_1); None for prose like [Term 1] or "email 1" """
    lb, kind, sep, n, rb = m.groups()
    if lb and rb:
        return "bracketed" if kind.isupper() or sep in ("_", "\\_") else None
    core = m.group(0)[len(lb or ""):len(m.group(0)) - len(rb or "")]
    return "bare" if kind.isupper() and core == kind + "_" + n else None


def literal(text, known, typed=None):
    """A token the user typed ([EMAIL_1], [email 1], EMAIL_1…) must never come back as a real value, or anyone who can
    write to the agent could have it repeat one. It goes to the model as 〔EMAIL_1〕 (EMAIL_1 as 〘EMAIL_1〙) and comes
    back to you as you typed it; typed collects the tokens it stood for. [EMAIL_1] is always changed while emails are
    masked (it may stand for one later); [IP_1] with IPs off, EMAIL_1 and [email_1] only when they stand for something
    (known), so cols[ID_1] or rows[id_1] in your code stays as it is.
    This stops the model repeating a token verbatim, and Mask.unmask won't turn a typed token back into a value either,
    however the model writes it, in the same process (one conversation with Claude, one turn with the others). It
    doesn't stop someone who can chat with the agent from getting a value some other way: the mask hides values from
    the AI company, not from the people in the chat."""
    out, last = [], 0
    for m in fuzzy_tokens(text):
        form = token_form(m)
        lb, kind, _, n, rb = m.groups()
        tok = "[%s_%d]" % (kind.upper(), int(n))
        always = form == "bracketed" and kind.isupper() and kind.lower() in TYPES
        if form is None or not (always or known(tok)):
            continue
        if typed is not None:
            typed.add(tok)
        core = m.group(0)[len(lb or ""):len(m.group(0)) - len(rb or "")]
        if form == "bracketed":
            inert = "\u3014" + core.strip().replace("\\", "") + "\u3015"
        else:
            inert = (lb or "") + "\u3018" + core + "\u3019" + (rb or "")   # a lone bracket stays
        out.append(text[last:m.start()])
        out.append(inert)
        last = m.end()
    if not last:
        return text
    out.append(text[last:])
    return "".join(out)


# --- the relay between cc-connect and the CLI ------------------------------------------------------------------------
# a local path in a prompt: to the end of cc-connect's "(Files saved locally, please read them: a, b)" list item
# (names may hold spaces), or up to the first space
PATHS = (re.compile(r"(?<![\w/])(?:/home/agent|/tmp|/memory)/[^\n]*?(?=, /|\)\s*(?:\n|$)|\n|$)"),
         re.compile(r"(?<![\w/])(?:/home/agent|/tmp|/memory)/[^\s,)\"'`]*"))


def alias_paths(masked, mask):
    """A file you send is saved in the VM, and the prompt names its path. If the path now holds a token ("…/[TERM_1]
    contract.pdf"), the agent couldn't open it: link the masked name to the real file, next to it."""
    for p in {m.group(0).rstrip(".") for r in PATHS for m in r.finditer(masked)}:
        if "[" not in p:
            continue
        real = mask.unmask(p)
        if real == p or not os.path.exists(real):
            continue
        a, b = p.split("/"), real.split("/")
        if len(a) != len(b):
            continue
        for i in range(len(a)):
            if a[i] != b[i]:
                alias, target = "/".join(a[:i + 1]), "/".join(b[:i + 1])
                try:
                    if not os.path.lexists(alias):
                        os.symlink(os.path.basename(target), alias)
                except OSError:
                    pass
                break


def mask_prompt(mask, text):
    masked = mask.mask(text)
    if masked != text:
        alias_paths(masked, mask)
    return masked


def json_bytes(obj, **kw):
    """obj as a line of UTF-8 JSON. A string cut inside an emoji (JSON.stringify writes "\\ud83d" for it) has no UTF-8
    form: then the line is written with \\u escapes, which is the same JSON, rather than stopping the relay."""
    try:
        return (json.dumps(obj, ensure_ascii=False, **kw) + "\n").encode("utf-8", "surrogateescape")
    except UnicodeEncodeError:
        return (json.dumps(obj, **kw) + "\n").encode("ascii")


PENDING = {}   # request_id -> a tool's input as the model wrote it (masked), from control_request lines on stdout


def restore(mask, new, orig, shown=None):
    """What cc-connect sends back for an approved tool: the input it was shown (unmasked), maybe with your answers
    added. Any text it was shown goes back exactly as the model wrote it (so a question's text, or an option you
    picked, still matches what the model asked); anything new is masked."""
    if shown is None:
        shown = {}   # each text in the model's input, unmasked (what cc-connect showed you) -> as the model wrote it

        def collect(o):
            if isinstance(o, str):
                shown.setdefault(mask.unmask(o), o)
            elif isinstance(o, list):
                for x in o:
                    collect(x)
            elif isinstance(o, dict):
                for k, v in o.items():
                    collect(k)
                    collect(v)
        collect(orig)
    if isinstance(new, str):
        return shown[new] if new in shown else mask.mask(new)
    if isinstance(new, dict):
        return {(shown[k] if k in shown else mask.mask(k)): restore(mask, v, None, shown) for k, v in new.items()}
    if isinstance(new, list):
        return [restore(mask, v, None, shown) for v in new]
    return new


# the fields of a stream-json message that are the protocol's, not anyone's words: left as they are
PROTOCOL = {"type", "subtype", "role", "request_id", "uuid", "session_id", "parent_tool_use_id", "tool_use_id", "id",
            "media_type", "behavior"}


def mask_all(mask, obj, key=None, holder=None):
    """every text in a message masked, but for the protocol's own fields and a picture's (or a file's) base64 data"""
    if isinstance(obj, str):
        if key in PROTOCOL or (key == "data" and isinstance(holder, dict) and holder.get("type") == "base64"):
            return obj
        return mask_prompt(mask, obj)
    if isinstance(obj, list):
        return [mask_all(mask, x) for x in obj]
    if isinstance(obj, dict):
        return {(mask.mask(k) if isinstance(k, str) else k): mask_all(mask, v, k, obj) for k, v in obj.items()}
    return obj


def mask_user_message(mask, msg):
    """Claude Code's stream-json input: your messages, and your replies to its permission and question prompts.
    Anything else, in whatever shape a newer cc-connect sends (a tool result, a new kind of message), is masked
    all through too: never passed on as it is."""
    resp = msg.get("response")
    if msg.get("type") == "control_response" and isinstance(resp, dict) and isinstance(resp.get("response"), dict):
        # cc-connect echoes a tool's input back as updatedInput when you approve it, but it only ever saw the
        # unmasked input (the request was unmasked on its way to you). Give the CLI back what the model wrote, and
        # mask only what cc-connect added: your answers to its questions, a reason for saying no.
        orig = PENDING.pop(resp.get("request_id"), None)
        r = resp["response"]
        approved = "updatedInput" in r
        new = r.pop("updatedInput", None)
        msg = mask_all(mask, msg)
        if approved:
            msg["response"]["response"]["updatedInput"] = restore(mask, new, orig)
        return msg
    return mask_all(mask, msg)


class Unmasker:
    """The CLI's output, line by line, with tokens turned back into values. Streamed text (Cursor's thinking, Claude's
    partial messages) comes in pieces, and a token can be cut in two ("[EMA" + "IL_1]"): the end of a piece that
    could be the start of a token waits for the next piece, or goes out on its own before any other line."""
    TAIL = re.compile(r"(?:\\?[\[［【]\s{0,3})?(?:[A-Za-z]{1,8}(?:\\?_|[ -])?\d{0,6})?\\?$")

    def __init__(self, mask, out):
        self.mask, self.out = mask, out
        self.held = {}   # stream key -> (text held back, a copy of its last event)

    def write(self, b):
        self.out.write(b)
        self.out.flush()

    @staticmethod
    def delta(obj):
        """(stream key, the dict holding the text, its field) for a streamed piece of text, else None"""
        if obj.get("type") == "thinking" and obj.get("subtype") == "delta" and isinstance(obj.get("text"), str):
            return ("thinking",), obj, "text"
        ev = obj.get("event")
        if obj.get("type") == "stream_event" and isinstance(ev, dict) and ev.get("type") == "content_block_delta":
            d = ev.get("delta")
            for f in ("text", "thinking"):
                if isinstance(d, dict) and isinstance(d.get(f), str):
                    return ("stream", ev.get("index")), d, f
        return None

    def tail(self, s):
        """how many characters at the end of s could still turn out to be part of a token"""
        m = self.TAIL.search(s, max(0, len(s) - 24))
        if not m or m.start() == len(s):
            return 0
        frag = m.group(0)
        word = re.sub(r"[^A-Za-z]", "", frag)
        if word and not any(k.startswith(word.upper()) for k in KINDS):
            return 0
        if frag[0] not in "\\[［【" and (not word.isupper() or (m.start() and s[m.start() - 1].isalnum())):
            return 0   # a bare token is all capitals, on its own
        return len(s) - m.start()

    def emit(self, obj):
        self.write(json_bytes(self.mask.walk(obj, self.mask.unmask), separators=(",", ":")))

    def flush(self):
        for key in list(self.held):
            text, obj = self.held.pop(key)
            _, holder, field = self.delta(obj)
            holder[field] = text
            self.emit(obj)

    def line(self, line):
        s = line.strip()
        obj = None
        if s.startswith("{") and ('"control_request"' in line or "delta" in line or "\u3014" in line or "\u3018" in line or token_spots(line)):
            try:
                obj = json.loads(s)
            except ValueError:
                pass
        d = self.delta(obj) if isinstance(obj, dict) else None
        if not d:
            self.flush()
        if not isinstance(obj, dict):
            return self.write(self.mask.unmask(line).encode("utf-8", "surrogateescape"))
        if obj.get("type") == "control_request" and isinstance(obj.get("request"), dict):
            # the tool's input as the model wrote it, for when cc-connect sends it back approved (mask_user_message)
            PENDING[obj.get("request_id")] = obj["request"].get("input")
            while len(PENDING) > 1000:
                PENDING.pop(next(iter(PENDING)))
        if d:
            key, holder, field = d
            text = self.held.pop(key, ("", None))[0] + holder[field]
            n = self.tail(text)
            if n:
                self.held[key] = (text[len(text) - n:], json.loads(json.dumps(obj)))
            holder[field] = text[:len(text) - n]
        self.emit(obj)


PROMPT_FLAGS = ("-p", "--print", "exec", "--input-format")
FLAG = re.compile(r"--?[A-Za-z][\w-]*(?:=\S*)?$")   # an option, not a prompt ("- buy milk" is a prompt)


def run(argv):
    mask = Mask()
    args = list(argv)
    fmt = None
    for i, a in enumerate(args):
        if a == "--input-format" and i + 1 < len(args):
            fmt = args[i + 1]
        elif a.startswith("--input-format="):
            fmt = a.split("=", 1)[1]
    stdin_mode = "inherit"
    if fmt == "stream-json":
        stdin_mode = "stream"
    elif args and args[-1] == "-":
        stdin_mode = "text"
    elif "--" in args:
        i = args.index("--")
        args = args[:i + 1] + [mask_prompt(mask, a) for a in args[i + 1:]]
    elif "-p" in args and args.index("-p") + 1 < len(args) and not FLAG.match(args[args.index("-p") + 1]):
        i = args.index("-p") + 1   # (after `claude -p --verbose`, the prompt would be somewhere else)
        args[i] = mask_prompt(mask, args[i])
    elif any(a == f or a.startswith(f + "=") for a in args[1:] for f in PROMPT_FLAGS):
        # a CLI (or a new cc-connect) that takes its prompt some other way: never run it unmasked by mistake
        print("cage-mask: can't find where this CLI takes its prompt, so it didn't run (your mask is on)", file=sys.stderr)
        return 2

    child = subprocess.Popen(args, stdin=subprocess.PIPE if stdin_mode != "inherit" else None,
                             stdout=subprocess.PIPE, bufsize=0)

    def feed():
        try:
            if stdin_mode == "text":
                text = sys.stdin.buffer.read().decode("utf-8", "surrogateescape")
                child.stdin.write(mask_prompt(mask, text).encode("utf-8", "surrogateescape"))
            else:
                for raw in iter(sys.stdin.buffer.readline, b""):
                    line = raw.decode("utf-8", "surrogateescape")
                    try:
                        msg = json.loads(line) if line.lstrip().startswith("{") else None
                    except ValueError:
                        msg = None
                    if isinstance(msg, dict):
                        out = json_bytes(mask_user_message(mask, msg))
                    else:   # not JSON: masked as text, never passed on as it is
                        out = (mask.mask(line) if line.strip() else line).encode("utf-8", "surrogateescape")
                    child.stdin.write(out)
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
    um = Unmasker(mask, sys.stdout.buffer)
    # bufsize=0 keeps what we write to the CLI unbuffered, but readline() on a raw pipe reads ONE BYTE per system
    # call: read the CLI's output through a buffer (readline still returns as soon as a whole line is there)
    for raw in iter(io.BufferedReader(child.stdout, 1 << 16).readline, b""):
        um.line(raw.decode("utf-8", "surrogateescape"))
    um.flush()
    return child.wait()


def main(a):
    global TYPES
    if a[:1] == ["--types"] and len(a) > 1:
        TYPES = set(t for t in re.split(r"[\s,]+", a[1]) if t)
        a = a[2:]
    if a[:1] in (["--mask"], ["--unmask"], ["--mask-lines"]):
        text = sys.stdin.buffer.read().decode("utf-8", "surrogateescape")
        m = Mask()
        if a[0] == "--mask-lines":   # each line on its own, so the lines stay as many (memory.sh's note titles)
            out = "".join(m.mask(line) + "\n" for line in text.split("\n")[:-1 if text.endswith("\n") else None])
        else:
            out = m.mask(text) if a[0] == "--mask" else m.unmask(text)
        sys.stdout.buffer.write(out.encode("utf-8", "surrogateescape"))
        return 0
    if a:
        try:
            return run(a)
        except FileNotFoundError as e:
            print("cage-mask: %s" % e, file=sys.stderr)
            return 127
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
