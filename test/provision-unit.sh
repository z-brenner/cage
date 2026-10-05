#!/usr/bin/env bash
# Tests the rules guest/provision.sh, guest/entry.sh and guest/browser.sh follow when the network is slow or something
# doesn't match, with their functions loaded on their own (CAGE_PROVISION_LIB=1, CAGE_ENTRY_LIB=1, CAGE_BROWSER_LIB=1)
# and stub apt-get, dpkg, node, npm and curl first on PATH: apt's time limits hold even where bash ignores set -e, the
# limits grow with each try, Playwright never runs apt itself, cc-connect must match its checksum, and `cage update`
# falls back to the cache. Needs GNU coreutils (Linux).
# shellcheck disable=SC2034  # the cases below set provision.sh's own variables, for its functions
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }

# Stubs: each records its arguments in $T/calls. STUB_APT_SLOW=update|download makes that part of apt-get hang;
# STUB_NODE picks what Playwright's dry run says; curl serves the files in $T/www by name.
mkdir -p "$T/bin" "$T/www"
cat > "$T/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
echo "apt-get $*" >> "$T/calls"
case "$* " in
  *" update "*) [ "${STUB_APT_SLOW:-}" != update ] || exec sleep 60 ;;
  *" --download-only "*) [ "${STUB_APT_SLOW:-}" != download ] || exec sleep 60 ;;
esac
exit 0
EOF
cat > "$T/bin/node" <<'EOF'
#!/usr/bin/env bash
echo "node $*" >> "$T/calls"
[ "$1" != -p ] || { echo 22; exit 0; }   # Node.js 22 is there
case "$*" in
  *"install-deps --dry-run chromium"*)
    case "${STUB_NODE:-}" in
      ok) echo "All system dependencies are installed." ;;
      missing) printf 'Missing system dependencies (6):\n  fonts-liberation\n  libgbm1\n  libnss3\n  xfonts-cyrillic\n  xfonts-scalable\n  xvfb\n'; exit 1 ;;
      *) echo "Error: 'apt-get install -s' exited with code 100:"; echo "E: Unable to locate package libasound2t64"; exit 1 ;;
    esac ;;
esac
exit 0
EOF
printf '#!/bin/sh\necho "npm $*" >> "$T/calls"\n[ "$*" != "root -g" ] || echo "$T/npm"\n' > "$T/bin/npm"
mkdir -p "$T/npm/@playwright/mcp/node_modules/playwright"   # what npm installs: Playwright MCP, with Playwright's cli.js
touch "$T/npm/@playwright/mcp/cli.js" "$T/npm/@playwright/mcp/node_modules/playwright/cli.js"
cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$T/calls"
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) url="$1"; shift ;; esac; done
f="$T/www/${url##*/}"
[ -f "$f" ] || exit 22
if [ -n "$out" ]; then cp "$f" "$out"; else cat "$f"; fi
EOF
printf '#!/bin/sh\nexit 0\n' > "$T/bin/certutil"   # it's there (browser.sh needs it)
printf '#!/bin/sh\necho "dpkg $*" >> "$T/calls"\n[ "$1" != --print-architecture ] || echo amd64\n' > "$T/bin/dpkg"
chmod +x "$T/bin/"*
export T PATH="$T/bin:$PATH"

lib() { # lib <case function> [args…]: runs a case below with provision.sh's functions and its set -Eeuo pipefail
  # In a bash of its own, not a subshell: lib is called next to || and in if, where bash would turn set -e off for
  # everything inside, subshells too. The cases are exported to it (export -f).
  : > "$T/calls"
  bash -c 'CAGE_PROVISION_LIB=1 . "$0" claude
    STEP_FILE="$T/step" CACHE="$T/cache" CACHED=0
    "$@"' "$ROOT/guest/provision.sh" "$@" > "$T/out" 2>&1
}
shown() { echo "$(cat "$T/out")"$'\n'"calls: $(cat "$T/calls")"; }

still_running() { false; echo "STILL RUNNING after a command failed"; }
export -f still_running
if lib still_running || grep -q 'STILL RUNNING' "$T/out"; then fail "the cases run with set -e off: $(shown)"; fi
ok "the cases run with provision.sh's set -e on, as provisioning does"

# --- apt_install: its limits hold when it is an `if` condition (bash then ignores set -e and the ERR trap) ----------
slow_apt() { # slow_apt <update|download>
  local start=$SECONDS
  export STUB_APT_SLOW="$1"
  if apt_install vim; then echo "IF-BRANCH TAKEN"; fi
  echo "took $((SECONDS - start))s"
}
export -f slow_apt
export CAGE_APT_UPDATE_LIMIT=2 CAGE_APT_FETCH_LIMIT=2
lib slow_apt update || fail "slow update: $(shown)"
grep -q 'IF-BRANCH' "$T/out" && fail "apt_install worked although the package lists never came: $(shown)"
[ "$(sed -n 's/^took \([0-9]*\)s$/\1/p' "$T/out")" -lt 15 ] || fail "apt_install didn't stop at its 2s limit: $(shown)"
grep -q -- 'install' "$T/calls" && fail "apt_install went on after the lists ran out of time: $(shown)"
grep -q "package lists didn't arrive within 2s" "$T/out" || fail "no plain message: $(shown)"
lib slow_apt download || fail "slow download: $(shown)"
grep -q 'IF-BRANCH' "$T/out" && fail "apt_install worked although the downloads never finished: $(shown)"
[ "$(sed -n 's/^took \([0-9]*\)s$/\1/p' "$T/out")" -lt 15 ] || fail "apt_install didn't stop at its 2s limit: $(shown)"
grep -q -- '--no-download' "$T/calls" && fail "apt_install installed after the downloads ran out of time: $(shown)"
grep -q "downloads didn't finish within 2s (what arrived is kept for the next try)" "$T/out" || fail "no plain message: $(shown)"
CAGE_PROVISION_ATTEMPT=2 lib slow_apt update || fail "slow update, second try: $(shown)"
grep -q "package lists didn't arrive within 4s" "$T/out" && [ "$(sed -n 's/^took \([0-9]*\)s$/\1/p' "$T/out")" -ge 4 ] \
  || fail "the second try didn't get twice the time: $(shown)"
unset CAGE_APT_UPDATE_LIMIT CAGE_APT_FETCH_LIMIT
ok "apt_install gives up within its limits even as an if condition, and installs nothing then; the next try waits longer"

# Every download's limit grows with the try (CAGE_PROVISION_ATTEMPT, from entry.sh), up to 8 times: a vendor's
# installer or npm starts over each time, so on a slow connection only a longer try ever finishes
grown() {
  timeout() { echo "timeout $*" >> "$T/calls"; }   # what each step's limit is, without running it
  printf 'exit 0\n' > "$T/www/install.sh"
  TOOLS="$T/tools"
  apt_install vim
  npm_install some-package
  vendor_install https://vendor.example/install.sh
}
export -f grown
for t in 1:1 3:3 8:8 20:8 0:1 x:1; do
  n="${t#*:}"
  CAGE_PROVISION_ATTEMPT="${t%:*}" lib grown || fail "limits on try ${t%:*}: $(shown)"
  for want in "$((120 * n)) apt-get .* update" "$((300 * n)) apt-get .* --download-only" "$((600 * n)) npm install -g" "$((900 * n)) bash /"; do
    grep -q "^timeout -k 30 $want" "$T/calls" || fail "try ${t%:*} should allow $want: $(shown)"
  done
done
ok "each try allows the downloads more time than the one before (8 times the first one's at most)"

lib apt_install vim || fail "apt_install: $(shown)"
[ "$(grep -c '^apt-get' "$T/calls")" = 3 ] && tail -n 1 "$T/calls" | grep -q -- 'install -y -qq --no-install-recommends --no-download vim' \
  || fail "the last step should install from what was downloaded only: $(shown)"
grep -q -- '--force-confold' "$T/calls" || fail "dpkg may ask about config files: $(shown)"
ok "apt_install's last step can't download (--no-download), and dpkg never asks about config files"

# --- the browser's libraries: Playwright only says which are missing (--dry-run); apt_install installs them ---------
libs() { export STUB_NODE="$1"; install_browser; }
export -f libs
for f in ok missing other; do
  rc=0; lib libs "$f" || rc=$?
  if grep '^node .*install-deps' "$T/calls" | grep -qv -- '--dry-run'; then fail "Playwright ran apt itself ($f): $(shown)"; fi
  case "$f" in
    ok) [ "$rc" = 0 ] && ! grep -q '^apt-get' "$T/calls" || fail "nothing missing, yet: $(shown)" ;;
    missing) [ "$rc" = 0 ] || fail "missing libraries: $(shown)"
      last="$(grep -- '--no-download' "$T/calls" | tail -n 1)"
      for p in libnss3-tools fonts-liberation libgbm1 libnss3; do [[ " $last " == *" $p "* ]] || fail "$p not installed: $(shown)"; done
      for p in xvfb xfonts-cyrillic xfonts-scalable; do [[ " $last " != *" $p "* ]] || fail "$p installed (the browser is headless): $(shown)"; done ;;
    other) [ "$rc" = 1 ] && ! grep -q '^apt-get' "$T/calls" || fail "an answer it can't read should fail without apt: $(shown)"
      grep -q 'Unable to locate package libasound2t64' "$T/out" || fail "Playwright's answer isn't shown: $(shown)" ;;
  esac
done
ok "the browser's libraries: nothing when nothing is missing, the missing ones (no X server) through apt_install, a plain failure otherwise"

wrapper() {
  echo "waits ${BROWSER_WAIT}s"
  BROWSER_WRAPPER="$T/cage-browser" BROWSER_READY="$T/ready" BROWSER_WAIT=1
  browser_wrapper
  rm -f "$T/ready"
  if "$T/cage-browser" 2>"$T/err"; then echo "STARTED BEFORE READY"; fi
  cat "$T/err"
  touch "$T/ready"
  "$T/cage-browser" --caps vision
}
export -f wrapper
lib wrapper || fail "cage-browser: $(shown)"
grep -q 'STARTED BEFORE READY' "$T/out" && fail "cage-browser started before the browser was ready: $(shown)"
# shorter than the agents' CLIs wait for a tool to start (Codex: 10s), or they give up before the message
[ "$(sed -n 's/^waits \([0-9]*\)s$/\1/p' "$T/out")" -lt 10 ] || fail "cage-browser waits longer than the agents do: $(shown)"
grep -qx 'cage-browser: the browser is still being set up; try again in a few minutes' "$T/out" || fail "no plain message: $(shown)"
grep -q "^node $T/npm/@playwright/mcp/cli.js --headless --no-sandbox --no-webmcp .* --caps vision\$" "$T/calls" \
  || fail "cage-browser's Playwright MCP: $(shown)"
ok "cage-browser says, within seconds, that the browser is still being set up until it's ready, then starts Playwright MCP without WebMCP"

# --- cc-connect: checked against its SHA-256 (pinned, or the release's own list for other versions) ----------------
case "$(uname -m)" in x86_64) arch=amd64 ;; *) arch=arm64 ;; esac
export arch
mkdir -p "$T/pkg"
printf '#!/bin/sh\necho cc-connect stub\n' > "$T/pkg/cc-connect-v9.9.9-linux-$arch"
chmod +x "$T/pkg/cc-connect-v9.9.9-linux-$arch"
tar -czf "$T/www/cc-connect-v9.9.9-linux-$arch.tar.gz" -C "$T/pkg" "cc-connect-v9.9.9-linux-$arch"
cp "$T/www/cc-connect-v9.9.9-linux-$arch.tar.gz" "$T/www/cc-connect-v1.5.0-linux-$arch.tar.gz"   # not v1.5.0's real file
cc() { # cc <version> [1: as `cage update`]
  CC_CONNECT_VERSION="$1" CACHED=1 REFRESH="${2:-0}" CC_CONNECT_BIN="$T/cc-connect"
  mkdir -p "$CACHE"
  install_cc_connect
}
export -f cc
if lib cc v1.5.0; then fail "a cc-connect that doesn't match its pinned checksum was installed: $(shown)"; fi
grep -q "cc-connect's download doesn't match its checksum; not using it" "$T/out" || fail "no plain message: $(shown)"
[ ! -e "$T/cc-connect" ] && [ -z "$(ls -A "$T/cache")" ] || fail "the mismatched download was kept: $(ls -R "$T/cache")"
echo "$(sha256sum "$T/www/cc-connect-v9.9.9-linux-$arch.tar.gz" | cut -d' ' -f1)  cc-connect-v9.9.9-linux-$arch.tar.gz" > "$T/www/checksums.txt"
lib cc v9.9.9 || fail "cc-connect matching its release's checksums.txt: $(shown)"
[ "$("$T/cc-connect")" = "cc-connect stub" ] && grep -q 'a weaker check' "$T/out" || fail "unknown version: $(shown)"
lib cc v9.9.9 || fail "cc-connect from the cache: $(shown)"
grep -q '^curl' "$T/calls" && fail "a checked copy in the cache was downloaded again: $(shown)"
echo tampered >> "$T/cache/cc-connect-v9.9.9-linux-$arch.tar.gz"
lib cc v9.9.9 || fail "cc-connect after a changed cache: $(shown)"
grep -q "^curl .*/v9.9.9/cc-connect-v9.9.9-linux-$arch.tar.gz" "$T/calls" || fail "a changed copy in the cache was used: $(shown)"
echo "0000000000000000000000000000000000000000000000000000000000000000  cc-connect-v9.9.8-linux-$arch.tar.gz" > "$T/www/checksums.txt"
cp "$T/www/cc-connect-v9.9.9-linux-$arch.tar.gz" "$T/www/cc-connect-v9.9.8-linux-$arch.tar.gz"
if lib cc v9.9.8; then fail "a cc-connect that doesn't match its release's checksums.txt was installed: $(shown)"; fi
ok "cc-connect: a download that doesn't match its checksum is refused; the cached copy is checked before each use"

# A version cage hasn't pinned: the cache's copy of its checksum only catches damage, so `cage update` asks again
mkdir -p "$T/evil"
printf '#!/bin/sh\necho EVIL\n' > "$T/evil/cc-connect-v9.9.9-linux-$arch"
chmod +x "$T/evil/cc-connect-v9.9.9-linux-$arch"
tar -czf "$T/cache/cc-connect-v9.9.9-linux-$arch.tar.gz" -C "$T/evil" "cc-connect-v9.9.9-linux-$arch"
sha256sum "$T/cache/cc-connect-v9.9.9-linux-$arch.tar.gz" | cut -d' ' -f1 > "$T/cache/cc-connect-v9.9.9-linux-$arch.tar.gz.sha256"
echo "$(sha256sum "$T/www/cc-connect-v9.9.9-linux-$arch.tar.gz" | cut -d' ' -f1)  cc-connect-v9.9.9-linux-$arch.tar.gz" > "$T/www/checksums.txt"
lib cc v9.9.9 1 || fail "cage update with a changed cache: $(shown)"
[ "$("$T/cc-connect")" = "cc-connect stub" ] && grep -q '^curl .*/v9.9.9/checksums.txt' "$T/calls" \
  || fail "cage update trusted the cache's own checksum of an unpinned version: $(shown)"
ok "cc-connect: for a version cage hasn't pinned, cage update checks against the release again, not the cache's copy"

# What older cage kept in the cache: the binary itself. Used when it's the published one (no network needed to wake
# up), refused when it isn't. Here v7.7.7 is "pinned" to the stub's tarball and binary.
pinned() { # pinned <stub: the published binary, or what else the cached one says>
  cc_connect_sha256() {
    if [ "${3:-}" = binary ]; then sha256sum "$T/pkg/cc-connect-v9.9.9-linux-$2"; else sha256sum "$T/www/cc-connect-v9.9.9-linux-$2.tar.gz"; fi | cut -d' ' -f1
  }
  if [ "$1" = stub ]; then cp "$T/pkg/cc-connect-v9.9.9-linux-$arch" "$T/cache/cc-connect-v7.7.7-linux-$arch"
  else printf '#!/bin/sh\necho %s\n' "$1" > "$T/cache/cc-connect-v7.7.7-linux-$arch"; fi
  cc v7.7.7
}
export -f pinned
cp "$T/www/cc-connect-v9.9.9-linux-$arch.tar.gz" "$T/www/cc-connect-v7.7.7-linux-$arch.tar.gz"
lib pinned stub || fail "the binary an older cage cached: $(shown)"
[ "$("$T/cc-connect")" = "cc-connect stub" ] && ! grep -q '^curl' "$T/calls" || fail "the published binary in the cache wasn't used as it is: $(shown)"
rm -f "$T/cc-connect"
lib pinned EVIL || fail "a changed binary in the cache: $(shown)"
[ "$("$T/cc-connect")" = "cc-connect stub" ] && grep -q "^curl .*/v7.7.7/cc-connect-v7.7.7-linux-$arch.tar.gz" "$T/calls" \
  || fail "a changed binary in the cache was used: $(shown)"
[ ! -e "$T/cache/cc-connect-v7.7.7-linux-$arch" ] && [ -e "$T/cache/cc-connect-v7.7.7-linux-$arch.tar.gz" ] \
  || fail "the checked tarball should replace the old binary: $(ls "$T/cache")"
ok "cc-connect: the binary an older cage cached is used offline when it's the published one, and replaced when it isn't"

# --- CAGE_APT_MIRROR: Ubuntu's archive from that mirror first; security updates as before -----------------------------
mirror() {
  SOURCES="$T/ubuntu.sources" MIRRORS="$T/mirrors.txt"
  printf 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\n\nTypes: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\n' > "$SOURCES"
  use_mirror "$1"
}
export -f mirror
lib mirror http://azure.archive.ubuntu.com/ubuntu/ || fail "mirror: $(shown)"
[ "$(cat "$T/mirrors.txt")" = $'http://azure.archive.ubuntu.com/ubuntu/\nhttp://archive.ubuntu.com/ubuntu/' ] || fail "mirror list: $(cat "$T/mirrors.txt")"
grep -qx "URIs: mirror+file:$T/mirrors.txt" "$T/ubuntu.sources" && grep -qx 'URIs: http://security.ubuntu.com/ubuntu/' "$T/ubuntu.sources" \
  || fail "sources: $(cat "$T/ubuntu.sources")"
rm -f "$T/mirrors.txt"
for bad in 'http://mirror.example/ubuntu/ $(id)' 'file:///etc/' 'http://mirror.example/ubuntu/
deb http://evil.example/ x main'; do
  lib mirror "$bad" || fail "mirror: $(shown)"
  [ ! -e "$T/mirrors.txt" ] && grep -qx 'URIs: http://archive.ubuntu.com/ubuntu/' "$T/ubuntu.sources" || fail "used a bad mirror: $bad"
  grep -q "CAGE_APT_MIRROR isn't a plain http(s) address" "$T/out" || fail "no plain message: $(shown)"
done
no_sources() { SOURCES="$T/no-such.sources" MIRRORS="$T/mirrors.txt"; use_mirror http://azure.archive.ubuntu.com/ubuntu/; }
export -f no_sources
lib no_sources || fail "a system without Ubuntu's sources file stopped provisioning: $(shown)"
[ ! -e "$T/mirrors.txt" ] && grep -q "doesn't get its packages from archive.ubuntu.com, so it isn't used" "$T/out" || fail "no plain message: $(shown)"
ok "CAGE_APT_MIRROR: a plain http(s) mirror goes first, Ubuntu's own servers second; anything else is ignored, as is a system without Ubuntu's sources"

# --- dpkg cut short by the time limit, and Node.js for the chat adapters ---------------------------------------------
finish() { DPKG_UPDATES="$T/updates"; finish_dpkg; }
export -f finish
mkdir -p "$T/updates"
lib finish || fail "finish_dpkg: $(shown)"
grep -q '^dpkg' "$T/calls" && fail "dpkg ran with nothing to finish: $(shown)"
touch "$T/updates/0001"
lib finish || fail "finish_dpkg: $(shown)"
grep -q '^dpkg --force-confdef --force-confold --configure -a' "$T/calls" && grep -q 'finishing an install that was cut short' "$T/out" \
  || fail "an install cut short wasn't finished: $(shown)"
ok "an install that a time limit cut short is finished first (dpkg --configure -a), without questions"

adapters() { # adapters <the config files>: with a Node.js that can't be installed
  node_22() { echo "NODE.JS FAILED"; return 1; }
  CONFIG="$T/config"
  rm -rf "$CONFIG"; mkdir -p "$CONFIG"
  for f in "$@"; do touch "$CONFIG/$f"; done
  adapters_node
  echo "CARRIED ON"
}
export -f adapters
lib adapters app.env || fail "Node.js for the app's chat stopped provisioning: $(shown)"
grep -q 'NODE.JS FAILED' "$T/out" && grep -q 'CARRIED ON' "$T/out" && grep -q "the app's chat needs Node.js; it starts once" "$T/out" \
  || fail "Node.js for the app's chat: $(shown)"
if lib adapters app.env whatsapp.env || grep -q 'CARRIED ON' "$T/out"; then fail "WhatsApp went on without Node.js: $(shown)"; fi
lib adapters || fail "no adapters: $(shown)"
grep -q 'NODE.JS' "$T/out" && fail "Node.js without an adapter that needs it: $(shown)"
ok "Node.js: WhatsApp waits for it; the app's chat doesn't keep the agent offline when it can't be installed"

grep -Eq '^provision\[claude\]: still on base packages \(3 min\) \([0-9]{2}:[0-9]{2}:[0-9]{2}Z\)$' \
  <<<"$( (CAGE_PROVISION_LIB=1 . "$ROOT/guest/provision.sh" claude; log "still on base packages (3 min)") )" || fail "log lines have no time"
ok "provisioning's log lines end with the time"

# The heartbeat: a minute here is 2s (a stub sleep that records itself), and stopping it leaves no sleep behind
mkdir -p "$T/slow"
printf '#!/bin/sh\necho $$ > "$T/sleep.pid"\nexec %s 2\n' "$(command -v sleep)" > "$T/slow/sleep"
chmod +x "$T/slow/sleep"
beat() { # beat <seconds the step has been going>
  PATH="$T/slow:$PATH" STEP_FILE="$T/step"
  step "base packages"
  printf '%s base packages\n' "$(( $(date +%s) - $1 ))" > "$STEP_FILE"
  : > "$T/sleep.pid"
  heartbeat > "$T/beat" & local hb=$!
  for _ in $(seq 1 50); do [ -s "$T/beat" ] && break; /bin/sleep 0.1; done
  /bin/sleep 0.2
  kill "$hb"; wait "$hb" 2>/dev/null || true
  /bin/sleep 0.3
  # still running, not just dead and waiting to be reaped (a zombie: kill -0 counts those too)
  if [[ "$(awk '{ print $3 }' "/proc/$(cat "$T/sleep.pid")/stat" 2>/dev/null)" =~ ^[RSD]$ ]]; then echo "SLEEP LEFT BEHIND"; fi
  cat "$T/beat"
}
export -f beat
lib beat 130 || fail "heartbeat: $(shown)"
grep -Eq '^provision\[claude\]: still on base packages \(2 min\) \(' "$T/out" || fail "no heartbeat line: $(shown)"
grep -q 'SLEEP LEFT BEHIND' "$T/out" && fail "the heartbeat's sleep outlived it: $(shown)"
lib beat 10 || fail "heartbeat: $(shown)"
grep -q 'still on' "$T/out" && fail "a step that just started was reported: $(shown)"
ok "while a step runs, a line every minute says which one (from its first minute on); stopping it stops its sleep too"

# --- browser.sh: each try allows more time for Chromium, which downloads from the start every time ---------------------
browser() { ( CAGE_BROWSER_LIB=1 . "$ROOT/guest/browser.sh" codex
  PROVISION="$T/provision.sh"
  timeout() { echo "timeout $* (try ${CAGE_PROVISION_ATTEMPT:-none})" >> "$T/calls"; }
  trust_cas() { echo 0; }
  "$@" ) > "$T/out" 2>&1; }
: > "$T/calls"
browser browser_try 3 || fail "browser.sh: $(shown)"
grep -q "^timeout -k 30 2700 bash $T/provision.sh codex --browser (try 3)" "$T/calls" && grep -q '^timeout -k 30 2700 runuser ' "$T/calls" \
  || fail "browser.sh's third try should allow 3 times as long: $(shown)"
: > "$T/calls"
browser browser_try 1 || fail "browser.sh: $(shown)"
grep -q "^timeout -k 30 900 bash $T/provision.sh codex --browser (try 1)" "$T/calls" && grep -q '^timeout -k 30 900 runuser ' "$T/calls" \
  || fail "browser.sh's first try: $(shown)"
ok "the browser: each try allows Chromium and the browser's part of the system more time"

# --- entry.sh: each try has a time limit that grows; `cage update` falls back to the cache; cc-connect's restarts -------
entry() { ( CAGE_ENTRY_LIB=1 . "$ROOT/guest/entry.sh" claude; PROVISION="$T/provision.sh"; "$@" ); }
[ "$(CAGE_REFRESH=1 entry refresh_arg 1)$(CAGE_REFRESH=1 entry refresh_arg 2)" = --refresh--refresh ] || fail "refresh on the first tries"
[ -z "$(CAGE_REFRESH=1 entry refresh_arg 3)" ] && [ -z "$(CAGE_REFRESH='' entry refresh_arg 1)" ] || fail "--refresh after 2 tries, or without cage update"
# A stand-in provision.sh: it says how it was called, and then hangs (slow), fails or works (STUB_PROVISION)
printf '#!/bin/sh\necho "provision $* (try $CAGE_PROVISION_ATTEMPT)" >> "$T/calls"\ncase "$STUB_PROVISION" in slow) exec sleep 60 ;; fail) exit 1 ;; esac\n' > "$T/provision.sh"
try() { : > "$T/calls"; entry provision_try "$@" > "$T/out" 2>&1; }
export CAGE_PROVISION_LIMIT=1 STUB_PROVISION=slow
if try 1 15; then fail "a try that hung counted as done: $(shown)"; fi
[ "$(cat "$T/out")" = 'cage-entry[claude]: provisioning failed: it took more than 1s; trying again in 15s' ] || fail "a try that hung: $(shown)"
start=$SECONDS
if try 3 60; then fail "a try that hung counted as done: $(shown)"; fi
grep -q 'it took more than 3s' "$T/out" && [ $((SECONDS - start)) -ge 3 ] || fail "the third try should allow 3 times as long: $(shown)"
STUB_PROVISION=fail
if CAGE_REFRESH=1 try 2 30; then fail "a failed try counted as done: $(shown)"; fi
grep -qx 'provision claude --refresh (try 2)' "$T/calls" && grep -q "couldn't get the newest versions (offline?); starting with the ones you had" "$T/out" \
  || fail "cage update's last try with --refresh: $(shown)"
# `cage status` reads the last line: "provisioning failed" is a network hiccup, anything else would be "waking up"
tail -n 1 "$T/out" | grep -q 'provisioning failed; retrying in 30s' || fail "the last line isn't the failure: $(shown)"
CAGE_REFRESH=1 try 3 60 || true
grep -qx 'provision claude (try 3)' "$T/calls" || fail "the third try of cage update should use the cache: $(shown)"
STUB_PROVISION=ok
try 1 15 && [ ! -s "$T/out" ] || fail "a try that worked: $(shown)"
unset CAGE_PROVISION_LIMIT STUB_PROVISION
ok "provisioning: each try has a time limit, longer each time; cage update uses the cache after 2 tries; cage status sees each failure"
waits=""; p=0
for ran in 1 1 1 1 1 1 400 1; do p="$(entry restart_wait "$p" "$ran")"; waits="$waits $p"; done
[ "$waits" = " 5 10 20 40 60 60 5 10" ] || fail "cc-connect's restart waits:$waits"
stops() { pause=0 quick=0; for ran in "$@"; do cc_connect_stopped 1 "$ran"; done; }
out="$(entry stops 1 1 1 1 1 1 400 1 1 1 1 1)"
[ "$(grep -c 'keeps stopping soon after it starts (5 times in a row)' <<<"$out")" = 2 ] \
  && [ "$(sed -n '5p' <<<"$out")" = 'cage-entry[claude]: cc-connect keeps stopping soon after it starts (5 times in a row); the lines above say why' ] \
  && [ "$(grep -c 'cc-connect exited with 1; restarting in' <<<"$out")" = 12 ] || fail "cc-connect's quick exits: $out"
ok "cc-connect restarts after 5s, twice as long after each quick exit up to a minute, and 5s again after a good run; 5 quick exits in a row are said plainly, once"

echo "all $pass provisioning unit tests passed"
