#!/bin/bash
# Runs the WhatsApp adapter (guest/whatsapp.mjs) as the agent user, if this agent has WhatsApp turned on
# (`cage chat add whatsapp`). Started in the background by guest/entry.sh. The adapter's packages and the
# WhatsApp session live on the home volume (~/.cage/whatsapp), so the link survives restarts.
# The packages are exactly the ones in guest/whatsapp/package-lock.json (versions and checksums), installed without
# running their install scripts and without Baileys' optional extras (sharp, for pictures, which cage doesn't send).
# To update them: change guest/whatsapp/package.json, then `npm install --package-lock-only` in that folder.
set -uo pipefail

KIND="${1:?usage: whatsapp.sh <agent>}"
U=agent
H=/home/agent
CONF=/cage-config/whatsapp.env
DIR="$H/.cage/whatsapp"
APP="$DIR/app"
PKG=/cage/whatsapp
log() { echo "cage-whatsapp[$KIND]: $*"; }

[ -r "$CONF" ] || exit 0
# The settings are written by `cage up` from validated values; read them without running anything.
get() { sed -n "s/^$1=//p" "$CONF" | head -n 1; }
MODE="$(get WA_MODE)" ALLOW="$(get WA_ALLOW)" PORT="$(get WA_BRIDGE_PORT)" TOKEN="$(get WA_BRIDGE_TOKEN)" NAME="$(get WA_NAME)"
[[ "$MODE" =~ ^(own|spare)$ && "$ALLOW" =~ ^[0-9,]*$ && "$PORT" =~ ^[0-9]+$ && "$TOKEN" =~ ^[a-f0-9]+$ && "$NAME" =~ ^[A-Za-z]+$ ]] \
  || { log "bad settings in $CONF"; exit 1; }

# Node.js normally comes with provisioning. If it's missing, keep trying, with longer pauses each time.
pause=30
until command -v node >/dev/null 2>&1 || { bash /cage/provision.sh "$KIND" --node && command -v node >/dev/null 2>&1; }; do
  log "couldn't install Node.js; trying again in ${pause}s"
  sleep "$pause"
  pause=$(( pause * 2 < 600 ? pause * 2 : 600 ))
done
install -d -m 700 -o "$U" -g "$U" "$H/.cage" "$DIR" "$APP"

want="$(sha256sum < "$PKG/package-lock.json" | cut -d' ' -f1)"
until [ "$(cat "$APP/.installed" 2>/dev/null)" = "$want" ]; do
  log "installing the WhatsApp client (Baileys $(sed -n 's/.*"@whiskeysockets\/baileys": "\(.*\)".*/\1/p' "$PKG/package.json"))"
  install -m 644 -o "$U" -g "$U" "$PKG/package.json" "$PKG/package-lock.json" "$APP/"
  if runuser -u "$U" -- env HOME="$H" bash -c 'set -a; [ -r /etc/cage/runtime.env ] && . /etc/cage/runtime.env; set +a
      cd "$1" && npm ci --omit=dev --omit=peer --ignore-scripts --no-fund --no-audit >/dev/null' _ "$APP"; then
    echo "$want" > "$APP/.installed"
  else
    log "install failed; retrying in 30s"
    sleep 30
  fi
done

delay=5
while true; do
  started=$SECONDS
  install -m 644 -o "$U" -g "$U" /cage/whatsapp.mjs "$APP/adapter.mjs"
  # Same environment as cc-connect, so it trusts the same CAs (microsandbox's, or a corporate proxy's).
  runuser -u "$U" -- env -i HOME="$H" PATH="/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 \
    WA_DIR="$DIR" WA_MODE="$MODE" WA_ALLOW="$ALLOW" WA_NAME="$NAME" \
    WA_BRIDGE_URL="ws://127.0.0.1:$PORT/bridge/ws" WA_BRIDGE_TOKEN="$TOKEN" \
    bash -c 'set -a; [ -r /etc/cage/runtime.env ] && . /etc/cage/runtime.env; set +a; exec node "$1"' _ "$APP/adapter.mjs"
  rc=$?
  # Logged out (3) means it needs a new link: wait for `cage chat link whatsapp`, which shows a fresh code.
  # After a run of more than 5 minutes, a crash is news, not a loop: start again from the shortest pause.
  if [ $rc = 3 ] || [ $(( SECONDS - started )) -gt 300 ]; then delay=5; else delay=$(( delay * 2 < 120 ? delay * 2 : 120 )); fi
  log "adapter exited ($rc); restarting in ${delay}s"
  sleep "$delay"
done
