#!/bin/bash
# Runs the WhatsApp adapter (guest/whatsapp.mjs) as the agent user, if this agent has WhatsApp turned on
# (`cage chat add whatsapp`). Started in the background by guest/entry.sh. The adapter's packages and the
# WhatsApp session live on the home volume (~/.cage/whatsapp), so the link survives restarts.
set -uo pipefail

KIND="${1:?usage: whatsapp.sh <agent>}"
U=agent
H=/home/agent
CONF=/cage-config/whatsapp.env
DIR="$H/.cage/whatsapp"
APP="$DIR/app"
BAILEYS="${CAGE_BAILEYS_VERSION:-7.0.0-rc14}"
log() { echo "cage-whatsapp[$KIND]: $*"; }

[ -r "$CONF" ] || exit 0
# The settings are written by `cage up` from validated values; read them without running anything.
get() { sed -n "s/^$1=//p" "$CONF" | head -n 1; }
MODE="$(get WA_MODE)" ALLOW="$(get WA_ALLOW)" PORT="$(get WA_BRIDGE_PORT)" TOKEN="$(get WA_BRIDGE_TOKEN)" NAME="$(get WA_NAME)"
[[ "$MODE" =~ ^(own|spare)$ && "$ALLOW" =~ ^[0-9,]*$ && "$PORT" =~ ^[0-9]+$ && "$TOKEN" =~ ^[a-f0-9]+$ && "$NAME" =~ ^[A-Za-z]+$ ]] \
  || { log "bad settings in $CONF"; exit 1; }

command -v node >/dev/null 2>&1 || bash /cage/provision.sh "$KIND" --node || { log "couldn't install Node.js"; exit 1; }
install -d -m 700 -o "$U" -g "$U" "$H/.cage" "$DIR" "$APP"

want="baileys@$BAILEYS"
until [ "$(cat "$APP/.installed" 2>/dev/null)" = "$want" ]; do
  log "installing the WhatsApp client ($want)"
  if runuser -u "$U" -- env HOME="$H" bash -c 'set -a; [ -r /etc/cage/runtime.env ] && . /etc/cage/runtime.env; set +a
      cd "$1" && { [ -f package.json ] || echo "{\"type\":\"module\",\"private\":true}" > package.json; } &&
      npm install --no-fund --no-audit --omit=dev "@whiskeysockets/baileys@$2" ws@8 pino@9 >/dev/null' _ "$APP" "$BAILEYS"; then
    echo "$want" > "$APP/.installed"
  else
    log "install failed; retrying in 30s"
    sleep 30
  fi
done

delay=5
while true; do
  install -m 644 -o "$U" -g "$U" /cage/whatsapp.mjs "$APP/adapter.mjs"
  runuser -u "$U" -- env -i HOME="$H" PATH="/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 \
    WA_DIR="$DIR" WA_MODE="$MODE" WA_ALLOW="$ALLOW" WA_NAME="$NAME" \
    WA_BRIDGE_URL="ws://127.0.0.1:$PORT/bridge/ws" WA_BRIDGE_TOKEN="$TOKEN" \
    node "$APP/adapter.mjs"
  rc=$?
  # Logged out (3) means it needs a new link: wait for `cage chat link whatsapp`, which shows a fresh code.
  if [ $rc = 3 ]; then delay=5; else delay=$(( delay < 120 ? delay * 2 : 120 )); fi
  log "adapter exited ($rc); restarting in ${delay}s"
  sleep "$delay"
done
