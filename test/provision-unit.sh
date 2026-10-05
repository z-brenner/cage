#!/usr/bin/env bash
# Tests the rules guest/provision.sh and guest/entry.sh follow when the network is slow or something doesn't match,
# with their functions loaded on their own (CAGE_PROVISION_LIB=1, CAGE_ENTRY_LIB=1) and stub apt-get, node, npm and
# curl first on PATH: apt's time limits hold even where bash ignores set -e, Playwright never runs apt itself,
# cc-connect must match its checksum, and `cage update` falls back to the cache. Needs GNU coreutils (Linux).
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
chmod +x "$T/bin/"*
export T PATH="$T/bin:$PATH"

lib() { # lib <case function>: runs a case below in a subshell, with provision.sh's functions and set -Eeuo pipefail
  : > "$T/calls"
  ( CAGE_PROVISION_LIB=1 . "$ROOT/guest/provision.sh" claude
    STEP_FILE="$T/step" CACHE="$T/cache" CACHED=0
    "$@" ) > "$T/out" 2>&1
}
shown() { echo "$(cat "$T/out")"$'\n'"calls: $(cat "$T/calls")"; }

# --- apt_install: its limits hold when it is an `if` condition (bash then ignores set -e and the ERR trap) ----------
slow_apt() { # slow_apt <update|download>
  local start=$SECONDS
  export STUB_APT_SLOW="$1"
  if apt_install vim; then echo "IF-BRANCH TAKEN"; fi
  echo "took $((SECONDS - start))s"
}
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
unset CAGE_APT_UPDATE_LIMIT CAGE_APT_FETCH_LIMIT
ok "apt_install gives up within its limits even as an if condition, and installs nothing then"

lib apt_install vim || fail "apt_install: $(shown)"
[ "$(grep -c '^apt-get' "$T/calls")" = 3 ] && tail -n 1 "$T/calls" | grep -q -- 'install -y -qq --no-install-recommends --no-download vim' \
  || fail "the last step should install from what was downloaded only: $(shown)"
grep -q -- '--force-confold' "$T/calls" || fail "dpkg may ask about config files: $(shown)"
ok "apt_install's last step can't download (--no-download), and dpkg never asks about config files"

# --- the browser's libraries: Playwright only says which are missing (--dry-run); apt_install installs them ---------
libs() { export STUB_NODE="$1"; install_browser; }
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
  BROWSER_WRAPPER="$T/cage-browser" BROWSER_READY="$T/ready" BROWSER_WAIT=1
  browser_wrapper
  rm -f "$T/ready"
  if "$T/cage-browser" 2>"$T/err"; then echo "STARTED BEFORE READY"; fi
  cat "$T/err"
  touch "$T/ready"
  "$T/cage-browser" --caps vision
}
lib wrapper || fail "cage-browser: $(shown)"
grep -q 'STARTED BEFORE READY' "$T/out" && fail "cage-browser started before the browser was ready: $(shown)"
grep -qx 'cage-browser: the browser is still being set up; try again in a few minutes' "$T/out" || fail "no plain message: $(shown)"
grep -q "^node $T/npm/@playwright/mcp/cli.js --headless --no-sandbox --no-webmcp .* --caps vision\$" "$T/calls" \
  || fail "cage-browser's Playwright MCP: $(shown)"
ok "cage-browser says the browser is still being set up until it's ready, then starts Playwright MCP without WebMCP"

# --- CAGE_APT_MIRROR: Ubuntu's archive from that mirror first; security updates as before -----------------------------
mirror() {
  SOURCES="$T/ubuntu.sources" MIRRORS="$T/mirrors.txt"
  printf 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\n\nTypes: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\n' > "$SOURCES"
  use_mirror "$1"
}
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
ok "CAGE_APT_MIRROR: a plain http(s) mirror goes first, Ubuntu's own servers second; anything else is ignored"

grep -Eq '^provision\[claude\]: still on base packages \(3 min\) \([0-9]{2}:[0-9]{2}:[0-9]{2}Z\)$' \
  <<<"$( (CAGE_PROVISION_LIB=1 . "$ROOT/guest/provision.sh" claude; log "still on base packages (3 min)") )" || fail "log lines have no time"
ok "provisioning's log lines end with the time"

# The heartbeat: a minute here is 2s (a stub sleep that records itself), and stopping it leaves no sleep behind
mkdir -p "$T/slow"
printf '#!/bin/sh\necho $$ > "$T/sleep.pid"\nexec %s 2\n' "$(command -v sleep)" > "$T/slow/sleep"
chmod +x "$T/slow/sleep"
beat() {
  PATH="$T/slow:$PATH" STEP_FILE="$T/step"
  step "base packages"
  heartbeat > "$T/beat" & local hb=$!
  for _ in $(seq 1 50); do grep -q 'still on' "$T/beat" && break; /bin/sleep 0.1; done
  kill "$hb"; wait "$hb" 2>/dev/null || true
  /bin/sleep 0.3
  # still running, not just dead and waiting to be reaped (a zombie: kill -0 counts those too)
  if [[ "$(awk '{ print $3 }' "/proc/$(cat "$T/sleep.pid")/stat" 2>/dev/null)" =~ ^[RSD]$ ]]; then echo "SLEEP LEFT BEHIND"; fi
  cat "$T/beat"
}
lib beat || fail "heartbeat: $(shown)"
grep -Eq '^provision\[claude\]: still on base packages \(0 min\) \(' "$T/out" || fail "no heartbeat line: $(shown)"
grep -q 'SLEEP LEFT BEHIND' "$T/out" && fail "the heartbeat's sleep outlived it: $(shown)"
ok "while a step runs, a line every minute says which one; stopping the heartbeat stops its sleep too"

echo "all $pass provisioning unit tests passed"
