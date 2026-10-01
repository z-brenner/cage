#!/bin/bash
# Sets up the agent's web browser (the "browser" connector) at boot, as root. provision.sh installed Playwright MCP
# and Chromium's libraries; Chromium itself downloads once into the home volume. When microsandbox inspects this
# VM's HTTPS (it does once there are secrets or website passwords), Chromium is told to trust microsandbox's CA:
# it keeps its own certificate store (NSS), separate from the system one.
set -euo pipefail
U=agent
H=/home/agent
CA=/.msb/tls/ca.pem
log() { echo "cage-browser: $*"; }

command -v cage-browser >/dev/null || { log "not installed (provision.sh)"; exit 1; }
cli="$(find "$(npm root -g)/@playwright/mcp" -maxdepth 1 -name cli.js | head -n 1)"
if ! ls -d "$H"/.cache/ms-playwright/chromium-* >/dev/null 2>&1; then log "downloading Chromium (once)"; fi
runuser -u "$U" -- env HOME="$H" PLAYWRIGHT_BROWSERS_PATH="$H/.cache/ms-playwright" \
  bash -c 'set -a; [ -r /etc/cage/runtime.env ] && . /etc/cage/runtime.env; set +a; node "$1" install-browser --no-shell chromium >/dev/null' _ "$cli"

# Chromium keeps its own list of trusted CAs, so give it the extra ones this VM trusts: microsandbox's (when it
# inspects HTTPS), the host's that microsandbox passes on (e.g. a company proxy's), and any local additions.
certs="$(mktemp -d)"
n=0
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
  echo "$i"' _ "$certs" > "$certs/count"
log "ready (trusts $(cat "$certs/count") extra CA certificate(s))"
rm -rf "$certs"
