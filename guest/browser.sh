#!/bin/bash
# Sets up the agent's web browser (the "browser" connector) after each boot, as root. guest/entry.sh starts it in the
# background next to cc-connect, so the agent can chat while the browser gets ready:
#   provision.sh --browser installs Playwright MCP and Chromium's libraries (from the cache after the first time);
#   Chromium itself downloads once into the home volume;
#   when microsandbox inspects this VM's HTTPS (it does once there are secrets or website passwords), Chromium is told
#   to trust microsandbox's CA: it keeps its own certificate store (NSS), separate from the system one.
# Each step has a time limit, and the whole is tried again until it works. Then /opt/cage/browser-ready lets
# cage-browser (see provision.sh) start; until then it tells the agent the browser is still being set up.
#   usage: browser.sh <claude|codex|cursor|antigravity>
set -uo pipefail
KIND="${1:?usage: browser.sh <agent>}"
U=agent
H=/home/agent
CA=/.msb/tls/ca.pem
READY=/opt/cage/browser-ready
log() { echo "cage-browser: $*"; }

get_chromium() { # Chromium itself, into the home volume (it downloads once)
  local cli
  cli="$(find "$(npm root -g)/@playwright/mcp" -maxdepth 1 -name cli.js 2>/dev/null | head -n 1)"
  [ -n "$cli" ] || { log "Playwright MCP isn't installed"; return 1; }
  if ! ls -d "$H"/.cache/ms-playwright/chromium-* >/dev/null 2>&1; then log "downloading Chromium (once)"; fi
  timeout -k 30 900 runuser -u "$U" -- env HOME="$H" PLAYWRIGHT_BROWSERS_PATH="$H/.cache/ms-playwright" \
    bash -c 'set -a; [ -r /etc/cage/runtime.env ] && . /etc/cage/runtime.env; set +a; node "$1" install-browser --no-shell chromium >/dev/null' _ "$cli"
}

trust_cas() { # prints how many extra CA certificates Chromium now trusts
  # Chromium keeps its own list of trusted CAs, so give it the extra ones this VM trusts: microsandbox's (when it
  # inspects HTTPS), the host's that microsandbox passes on (e.g. a company proxy's), and any local additions.
  local certs f n=0 rc=0
  certs="$(mktemp -d)"
  for f in "$CA" /.msb/tls/host-cas.pem /usr/local/share/ca-certificates/*.crt /usr/local/share/ca-certificates/*.pem; do
    [ -r "$f" ] || continue
    awk -v dir="$certs" -v base="$n" '/-----BEGIN CERTIFICATE-----/ { i++; out = sprintf("%s/c-%d-%d.pem", dir, base, i) }
      out { print > out } /-----END CERTIFICATE-----/ { close(out); out = "" }' "$f"
    n=$((n + 1))
  done
  chmod -R a+rX "$certs"
  runuser -u "$U" -- bash -c '
    db="sql:$HOME/.pki/nssdb"; mkdir -p "$HOME/.pki/nssdb"
    [ -e "$HOME/.pki/nssdb/cert9.db" ] || certutil -d "$db" -N --empty-password
    certutil -d "$db" -L 2>/dev/null | sed -n "s/^\(cage-[^ ]*\) .*/\1/p" | while read -r nick; do certutil -d "$db" -D -n "$nick"; done
    i=0; for c in "$1"/*.pem; do [ -s "$c" ] || continue; i=$((i + 1)); certutil -d "$db" -A -t "C,," -n "cage-$i" -i "$c" 2>/dev/null || true; done
    echo "$i"' _ "$certs" || rc=$?
  rm -rf "$certs"
  return "$rc"
}

command -v cage-browser >/dev/null || { log "not installed (provision.sh)"; exit 1; }
rm -f "$READY"   # a container that restarts keeps its system disk; a VM never does
delay=15
until timeout -k 30 900 bash /cage/provision.sh "$KIND" --browser </dev/null && get_chromium </dev/null && n="$(trust_cas)"; do
  log "not ready yet; trying again in ${delay}s"
  sleep "$delay"
  delay=$(( delay * 2 < 300 ? delay * 2 : 300 ))
done
mkdir -p "$(dirname "$READY")" && touch "$READY"
log "ready (trusts $n extra CA certificate(s))"
