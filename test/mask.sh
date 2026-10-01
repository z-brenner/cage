#!/usr/bin/env bash
# Tests guest/mask.py, the privacy mask: what it finds, and that it masks what each CLI is sent and unmasks what it
# says, for every way cc-connect hands a CLI its prompt. Fake CLIs record what they received.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }
export CAGE_MASK_MAP="$T/map.json" CAGE_MASK_TERMS="$T/terms"
echo "Acme Corp" > "$T/terms"
M="$ROOT/guest/mask.py"

out="$(python3 "$M" --mask <<'EOF'
Email bob.smith@example.co.uk, call +1 (415) 555-0132. Card 4111 1111 1111 1111, not 1234 5678 9012 3456.
IBAN GB82 WEST 1234 5698 7654 32, SSN 123-45-6789, key sk-proj-abcdefghijklmnopqrstuvwxyz012345 for acme corp.
Keep: 192.168.100.200, 2026-10-01, v1.2.3, order 42, port 8080, $MSB_GITHUB_TOKEN. Again bob.smith@example.co.uk.
EOF
)"
for want in "Email [EMAIL_1]," "call [PHONE_1]." "Card [CARD_1], not 1234 5678 9012 3456." "IBAN [IBAN_1]," "SSN [SSN_1]," \
            "key [SECRET_1] for [TERM_1]." "Keep: 192.168.100.200, 2026-10-01, v1.2.3, order 42, port 8080, \$MSB_GITHUB_TOKEN." "Again [EMAIL_1]."; do
  grep -qF -- "$want" <<<"$out" || fail "mask: expected '$want' in: $out"
done
[ "$(stat -c %a "$T/map.json")" = 600 ] || fail "the map isn't 0600"
[ "$(printf 'to [EMAIL_1] re [TERM_1], [EMAIL_7]' | python3 "$M" --unmask)" = "to bob.smith@example.co.uk re acme corp, [EMAIL_7]" ] \
  || fail "unmask: $(printf 'to [EMAIL_1] re [TERM_1]' | python3 "$M" --unmask)"
ok "finds emails, phones, cards (Luhn), IBANs, SSNs, keys and your terms; leaves dates, IPs, versions and placeholders"

mkdir -p "$T/bin"
cat > "$T/bin/fake-claude" <<'EOF'
#!/usr/bin/env python3
# Claude Code's stream-json: user messages in, assistant messages out (and the user message replayed)
import json, os, sys
for line in sys.stdin:
    m = json.loads(line)
    open(os.environ["SEEN"], "a").write(json.dumps(m) + "\n")
    if m.get("type") == "user":
        print(json.dumps(m), flush=True)
        print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Writing to " + m["message"]["content"]}]}}), flush=True)
EOF
cat > "$T/bin/fake-argv" <<'EOF'
#!/bin/sh
# Cursor and Antigravity: the prompt is the last argument
for a in "$@"; do last="$a"; done
printf '%s\n' "$last" >> "$SEEN"
printf '{"type":"result","result":"Sure, %s"}\n' "$last"
EOF
cat > "$T/bin/fake-stdin" <<'EOF'
#!/bin/sh
# codex exec … -: the prompt on stdin
cat >> "$SEEN"
echo "Done: mailed [EMAIL_1]"
EOF
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" SEEN="$T/seen"

: > "$SEEN"
out="$(printf '%s\n' '{"type":"user","message":{"role":"user","content":"mail carol@example.org"}}' \
  '{"type":"control_response","response":{"subtype":"success"}}' | python3 "$M" fake-claude --verbose --input-format stream-json --output-format stream-json)"
grep -q '"content": "mail \[EMAIL_2\]"' "$SEEN" || fail "Claude got the real value: $(cat "$SEEN")"
grep -q '"type": "control_response"' "$SEEN" || fail "other input didn't pass through"
grep -q '"text":"Writing to mail carol@example.org"' <<<"$out" || fail "Claude's reply wasn't unmasked: $out"
ok "stream-json (Claude Code): user messages masked on the way in, replies unmasked on the way out"

: > "$SEEN"
out="$(python3 "$M" fake-argv --print --mode ask -- "call dave at +44 20 7946 0958")"
grep -qx 'call dave at \[PHONE_2\]' "$SEEN" && grep -q 'Sure, call dave at +44 20 7946 0958' <<<"$out" || fail "argv after --: $(cat "$SEEN") / $out"
: > "$SEEN"
out="$(python3 "$M" fake-argv --print-timeout=24h -p "about Acme Corp")"
grep -qx 'about \[TERM_2\]' "$SEEN" && grep -q 'Sure, about Acme Corp' <<<"$out" || fail "argv after -p: $(cat "$SEEN") / $out"
ok "a prompt argument (Cursor after --, Antigravity after -p) masked; output unmasked"

: > "$SEEN"
out="$(printf 'send it to bob.smith@example.co.uk' | python3 "$M" fake-stdin exec --json -)"
grep -qx 'send it to \[EMAIL_1\]' "$SEEN" && [ "$out" = "Done: mailed bob.smith@example.co.uk" ] || fail "stdin prompt: $(cat "$SEEN") / $out"
ok "a prompt on stdin (codex exec -) masked; output unmasked"

if python3 "$M" no-such-cli -- hi 2>/dev/null; then fail "a missing CLI didn't fail"; fi
echo "all $pass mask tests passed"
