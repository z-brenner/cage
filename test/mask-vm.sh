#!/usr/bin/env bash
# The privacy mask's side in a VM, in a container standing in for one (python:3.12-slim with an "agent" user, and
# /cage, /cage-config and /memory mounted the way `cage up` mounts them), run by the real ./cage through a stand-in
# msb whose `exec` is a `docker exec`. Needs Docker; under a minute.
#   memory.sh: About me and the notes' names and titles reach AGENTS.md masked, and a masked name opens its note;
#              when the mask can't run, nothing is written unmasked
#   cage mask forget: the VM drops the values behind its placeholders, and AGENTS.md gets new ones
#   cage ask: the CLI runs as the agent, behind the mask, with the question from a file that is then removed (also
#             when the CLI fails), and the answer comes back unmasked; your terms as they are now are in place first,
#             from a file of their own for that ask, even before the VM's own setup has put them there and whatever
#             happens to the copy it reads when it wakes up, or to the VM's copy before the CLI's mask reads it; the
#             CLI doesn't run when they can't be
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
NAME="cage-mask-vm-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; pkill -f -- "$ROOT/cage _refresh" 2>/dev/null || true; rm -rf "$T"' EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }

# the stand-in msb: while cage sets up (STANDIN unset) every call just succeeds, as in test/host.sh; then `exec`
# runs in the container, with exec's -w/-u/-e passed on
mkdir -p "$T/bin"
cat > "$T/bin/msb" <<'EOF'
#!/usr/bin/env bash
cmd="$1"; shift
case "$cmd" in
  inspect) [ "$1" = cage-claude ]; exit $? ;;
  ps) echo cage-claude; exit 0 ;;
  exec)
    if [ -z "${STANDIN:-}" ]; then case "$*" in *cage:ready*) echo cage:ready ;; esac; exit 0; fi
    args=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --no-tty) shift ;;
        -w|-u|-e) args+=("$1" "$2"); shift 2 ;;
        --) shift; break ;;
        *) shift ;;   # the VM's name
      esac
    done
    # cage ask, below: the files cage wrote for the VM that MSB_GONE names (a pattern) taken away before the VM reads
    # them, noted in $CAGE_HOME/took; and the copy of your terms the VM reads when it wakes up replaced meanwhile, with
    # MSB_REPLACE's text, as `cage up` does
    if [ -n "${MSB_GONE:-}" ]; then for f in $MSB_GONE; do [ ! -e "$f" ] || { rm -f "$f"; echo "$f"; } >> "$CAGE_HOME/took"; done; fi
    if [ -n "${MSB_REPLACE:-}" ]; then
      f="$CAGE_HOME/agents/claude/mask.terms"; printf '%s\n' "$MSB_REPLACE" > "$f.new" && mv -f "$f.new" "$f"
    fi
    exec docker exec -i "${args[@]}" "$STANDIN" "$@" ;;
esac
exit 0
EOF
chmod +x "$T/bin/msb"
export PATH="$T/bin:$PATH" CAGE_HOME="$T/home" CAGE_NO_SELF_UPDATE=1
cage() { "$ROOT/cage" "$@"; }
cage init >/dev/null 2>&1
cage mask add "Acme Corp" </dev/null >/dev/null 2>&1
cage mask on claude </dev/null >/dev/null 2>&1
cage up claude </dev/null >/dev/null 2>&1
C="$CAGE_HOME/agents/claude"
[ -e "$C/mask.on" ] && grep -qx "Acme Corp" "$C/mask.terms" || fail "cage didn't turn the mask on for claude"

M="$T/memory"
mkdir -p "$M/notes/clients"
printf '# About me\n\n- Name: Dana Tester, dana.tester@example.com, works for Acme Corp\n' > "$M/about-me.md"
printf '# Renewal with Acme Corp\n\nDue in March.\n' > "$M/notes/acme-corp-renewal.md"
printf '# Call Bob back\n' > "$M/notes/clients/bob@example.com.md"
printf '# Groceries\n' > "$M/notes/groceries.md"
cat > "$T/claude" <<'EOF'
#!/bin/bash
# cage ask's CLI: says who ran it, and what it was asked (its last argument)
{ printf 'user=%s dir=%s shell=%s term=%s\n' "$(id -un)" "$PWD" "${SHELL:-}" "${TERM:-}"; printf '%s' "${!#}"; } > /tmp/asked
[ ! -e /tmp/fail ] || { echo "not signed in" >&2; exit 1; }
printf 'answer: %s' "${!#}"
EOF
chmod 755 "$T/claude"

docker run -d --name "$NAME" -v "$ROOT/guest:/cage:ro" -v "$C:/cage-config:ro" -v "$M:/memory:ro" \
  python:3.12-slim sleep 900 >/dev/null
# what the VM image and guest/entry.sh set up: the agent user, its work folder, the mask's terms
docker exec "$NAME" bash -c 'useradd -m -d /home/agent -s /bin/bash agent && install -d -o agent -g agent /home/agent/work &&
  install -d /etc/cage && install -m 644 /cage-config/mask.terms /etc/cage/mask.terms' || fail "container setup"
docker cp "$T/claude" "$NAME:/usr/local/bin/claude" >/dev/null
vm() { docker exec "$NAME" "$@"; }
agents_md() { vm cat /home/agent/work/AGENTS.md; }

vm bash /cage/memory.sh claude >/dev/null || fail "memory.sh failed"
md="$(agents_md)"
grep -qF -- '- Name: Dana Tester, [EMAIL_1], works for [TERM_1]' <<<"$md" || fail "About me isn't masked: $md"
grep -qF -- '## Notes you can read (in /run/cage/notes)' <<<"$md" \
  && grep -qF -- '- [TERM_1]-renewal.md: Renewal with [TERM_1]' <<<"$md" \
  && grep -qF -- '- clients/[EMAIL_2].md: Call Bob back' <<<"$md" \
  && grep -qF -- '- groceries.md: Groceries' <<<"$md" || fail "the notes aren't listed masked: $md"
if grep -qiE 'dana\.tester|acme|bob@' <<<"$md"; then fail "a real value is in AGENTS.md: $md"; fi
[ "$(vm runuser -u agent -- cat '/run/cage/notes/[TERM_1]-renewal.md' | head -n 1)" = "# Renewal with Acme Corp" ] \
  && [ "$(vm runuser -u agent -- cat '/run/cage/notes/clients/[EMAIL_2].md')" = "# Call Bob back" ] \
  || fail "the agent can't open a note by its masked name: $(vm ls -lR /run/cage/notes)"
ok "memory.sh: About me and the notes' names and titles are masked; the agent opens a note by its masked name"

# the mask can't run (here: no python3 for it): About me and the list of notes are left out, never sent unmasked
vm bash -c 'mkdir -p /broken && printf "#!/bin/sh\nexit 1\n" > /broken/python3 && chmod 755 /broken/python3'
vm env PATH=/broken:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin bash /cage/memory.sh claude >/dev/null || fail "memory.sh failed without the mask"
md="$(agents_md)"
grep -qF "(Your user's notes are left out: the privacy mask couldn't run.)" <<<"$md" \
  && grep -qF "Their list is left out here: the privacy mask couldn't run." <<<"$md" || fail "nothing says what was left out: $md"
if grep -qiE 'dana|acme|bob|groceries' <<<"$md"; then fail "with the mask broken, AGENTS.md got: $md"; fi
vm bash /cage/memory.sh claude >/dev/null
ok "memory.sh: when the mask can't run, About me and the notes are left out, not sent as they are"

# cage mask forget, as cage runs it: the map goes, the numbers used stay, so AGENTS.md gets new placeholders
vm runuser -u agent -- grep -q dana.tester /home/agent/.cage/mask/map.json || fail "no map before forget"
STANDIN="$NAME" cage mask forget > "$T/out" 2>&1 || fail "cage mask forget: $(cat "$T/out")"
grep -q "Claude Code forgot the values behind its placeholders" "$T/out" || fail "cage mask forget: $(cat "$T/out")"
if vm grep -q '"\[EMAIL_1\]"' /home/agent/.cage/mask/map.json; then fail "forget kept the old values"; fi
md="$(agents_md)"
grep -qF -- '- Name: Dana Tester, [EMAIL_3], works for [TERM_2]' <<<"$md" || fail "after forget, AGENTS.md has: $md"
ok "cage mask forget: the VM drops its values, and AGENTS.md gets new placeholders"

# cage ask, as cage runs it: the question from a file in /cage-config, the CLI as the agent behind the mask
q="mail dana.tester@example.com about Acme Corp; keep \"quotes\" \$HOME \`id\` \$(id)
-p and a second line"
out="$(STANDIN="$NAME" cage ask "$q" claude 2>/dev/null)"
asked="$(vm cat /tmp/asked)"
grep -qx 'user=agent dir=/home/agent/work shell=/bin/bash term=xterm-256color' <<<"$asked" || fail "the CLI ran as: $asked"
grep -qF 'mail [EMAIL_3] about [TERM_2]; keep "quotes" $HOME `id` $(id)' <<<"$asked" && grep -qx -- '-p and a second line' <<<"$asked" \
  || fail "the CLI was asked: $asked"
if grep -qiE 'dana\.tester|acme' <<<"$asked"; then fail "the CLI got real values: $asked"; fi
grep -qF 'answer: mail dana.tester@example.com about Acme Corp; keep "quotes"' <<<"$out" || fail "cage ask: $out"
[ -z "$(ls -A "$C/replies" 2>/dev/null)" ] || fail "the question stayed on disk: $(ls "$C/replies")"
vm touch /tmp/fail
out="$(STANDIN="$NAME" timeout 120 "$ROOT/cage" ask "is dana.tester@example.com in?" claude 2>/dev/null)" || fail "cage ask hung"
grep -q "no answer" <<<"$out" || fail "cage ask, the CLI failing: $out"
[ -z "$(ls -A "$C/replies" 2>/dev/null)" ] || fail "the question stayed on disk when the CLI failed"
ok "cage ask: the CLI runs as the agent, masked, with the question as typed; its file is removed, also when it fails"

# The VM's copy of your terms isn't there yet (its own setup puts it there only once it has installed everything), and
# a term was added since it woke up: the CLI still gets your terms as they are now, masked. When they can't be put in
# place (here: /etc/cage isn't a folder), the CLI doesn't run at all.
vm rm -f /tmp/fail /tmp/asked /etc/cage/mask.terms
cage mask add "Zeta Partners" </dev/null >/dev/null 2>&1
out="$(STANDIN="$NAME" cage ask "ask Acme Corp and Zeta Partners" claude 2>/dev/null)"
asked="$(vm cat /tmp/asked)"
grep -qE 'ask \[TERM_[0-9]+\] and \[TERM_[0-9]+\]$' <<<"$asked" || fail "the CLI didn't get your terms masked: $asked"
if grep -qiE 'acme|zeta' <<<"$asked"; then fail "the CLI got your terms: $asked"; fi
grep -qF 'answer: ask Acme Corp and Zeta Partners' <<<"$out" || fail "cage ask: $out"
[ "$(vm stat -c '%a %U' /etc/cage/mask.terms)" = "644 root" ] && [ "$(vm cat /etc/cage/mask.terms)" = "$(cat "$CAGE_HOME/mask.terms")" ] \
  && grep -qx 'Zeta Partners' "$CAGE_HOME/mask.terms" && [ "$(vm ls -A /etc/cage)" = mask.terms ] \
  || fail "the VM's terms: $(vm ls -lA /etc/cage; vm cat /etc/cage/mask.terms)"
vm sh -c 'rm -f /tmp/asked && mv /etc/cage /etc/cage.d && touch /etc/cage'
out="$(STANDIN="$NAME" timeout 120 "$ROOT/cage" ask "is Acme Corp in?" claude 2>/dev/null)" || fail "cage ask hung"
grep -q "no answer" <<<"$out" && ! vm test -e /tmp/asked || fail "the CLI ran without your terms in place: $out / $(vm cat /tmp/asked 2>&1)"
vm sh -c 'rm -f /etc/cage && mv /etc/cage.d /etc/cage'
[ -z "$(ls -A "$C/replies" 2>/dev/null)" ] || fail "the question stayed on disk"
ok "cage ask: the CLI gets your terms as they are now, masked, even before the VM has its own copy; it doesn't run when they can't be put in place"

# The file with your terms that cage writes for this ask is gone by the time the VM reads it (it looks 3 times): with
# nothing to say what your terms are, the CLI doesn't run, rather than run with none.
vm rm -f /tmp/asked; rm -f "$CAGE_HOME/took"
out="$(MSB_GONE="$C/replies/*.terms" STANDIN="$NAME" timeout 120 "$ROOT/cage" ask "is Acme Corp in?" claude 2>/dev/null)" || fail "cage ask hung"
grep -q '/replies/[0-9-]*\.terms$' "$CAGE_HOME/took" || fail "the stand-in msb didn't take the file away: $(cat "$CAGE_HOME/took" 2>&1)"
grep -q "no answer" <<<"$out" && ! vm test -e /tmp/asked || fail "the CLI ran with your terms' file gone: $out / $(vm cat /tmp/asked 2>&1)"
[ -z "$(ls -A "$C/replies" 2>/dev/null)" ] || fail "the question stayed on disk"
ok "cage ask: when the file with your terms is gone before the VM reads it, the CLI doesn't run"

# The copy of your terms the VM read when it woke up is replaced meanwhile (`cage up` does that, and in a microVM the
# VM can go on seeing the old one for a moment, or a stale handle to it): the ask doesn't rely on that copy, so the CLI
# gets your terms as they are now, from the file for this ask.
vm rm -f /tmp/asked
out="$(MSB_REPLACE="Other Corp" STANDIN="$NAME" cage ask "ask Acme Corp and Zeta Partners" claude 2>/dev/null)"
[ "$(cat "$C/mask.terms")" = "Other Corp" ] || fail "the stand-in msb didn't replace the VM's copy: $(cat "$C/mask.terms")"
asked="$(vm cat /tmp/asked)"
grep -qE 'ask \[TERM_[0-9]+\] and \[TERM_[0-9]+\]$' <<<"$asked" || fail "with the VM's copy replaced, the CLI didn't get your terms masked: $asked"
grep -qF 'answer: ask Acme Corp and Zeta Partners' <<<"$out" && [ "$(vm cat /etc/cage/mask.terms)" = "$(cat "$CAGE_HOME/mask.terms")" ] \
  || fail "with the VM's copy replaced: $out / $(vm cat /etc/cage/mask.terms)"
[ -z "$(ls -A "$C/replies" 2>/dev/null)" ] || fail "the question stayed on disk"
cp "$CAGE_HOME/mask.terms" "$C/mask.terms"
ok "cage ask: with the copy of your terms the VM woke up with replaced meanwhile, the CLI still gets your terms as they are now"

# After the VM has put this ask's terms in place, and before the CLI's mask reads them, something else replaces them
# with other terms (the VM's own setup, still waking up, putting in the ones it woke up with; or an ask that started
# earlier, with the terms you had then): here, a runuser that does that first. The CLI's mask still reads the terms
# put in place for this ask.
printf '#!/bin/sh\nprintf "Other Corp\\n" > /etc/cage/.other && chmod 644 /etc/cage/.other && mv -f /etc/cage/.other /etc/cage/mask.terms\nexec %s "$@"\n' \
  "$(vm sh -c 'command -v runuser')" > "$T/runuser"
chmod 755 "$T/runuser"
docker cp "$T/runuser" "$NAME:/usr/local/bin/runuser" >/dev/null
vm rm -f /tmp/asked
out="$(STANDIN="$NAME" cage ask "ask Acme Corp and Zeta Partners" claude 2>/dev/null)"
[ "$(vm cat /etc/cage/mask.terms)" = "Other Corp" ] || fail "the VM's copy wasn't replaced before the CLI ran: $(vm cat /etc/cage/mask.terms)"
asked="$(vm cat /tmp/asked)"
grep -qE 'ask \[TERM_[0-9]+\] and \[TERM_[0-9]+\]$' <<<"$asked" && ! grep -qiE 'acme|zeta' <<<"$asked" \
  || fail "with the VM's copy replaced before its mask read it, the CLI didn't get your terms masked: $asked"
grep -qF 'answer: ask Acme Corp and Zeta Partners' <<<"$out" || fail "cage ask, the VM's copy replaced: $out"
vm rm -f /usr/local/bin/runuser
[ -z "$(ls -A "$C/replies" 2>/dev/null)" ] || fail "the question stayed on disk"
ok "cage ask: the CLI's mask reads the terms put in place for its ask, even when they're replaced before it gets there"

echo "all $pass mask VM tests passed"
