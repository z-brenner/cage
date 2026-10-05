#!/bin/bash
# Runs cage's chat in the app (guest/app.mjs) as the agent user, for as long as the VM runs. Started in the
# background by guest/entry.sh. It talks to cc-connect's bridge in this VM, and to the app through /cage-app.
set -uo pipefail

KIND="${1:?usage: app.sh <agent>}"
U=agent
H=/home/agent
CONF=/cage-config/app.env
log() { echo "cage-app[$KIND]: $*"; }

[ -r "$CONF" ] && [ -d /cage-app ] || exit 0
# The settings are written by `cage up` from validated values; read them without running anything.
get() { sed -n "s/^$1=//p" "$CONF" | head -n 1; }
BRIDGE="$(get APP_BRIDGE_PORT)" MGMT="$(get APP_MGMT_PORT)" TOKEN="$(get APP_TOKEN)"
[[ "$BRIDGE" =~ ^[0-9]+$ && "$MGMT" =~ ^[0-9]+$ && "$TOKEN" =~ ^[a-f0-9]+$ ]] || { log "bad settings in $CONF"; exit 1; }

# Node.js normally comes with provisioning. If it's missing, keep trying (a network hiccup shouldn't leave the app's
# chat dead until the next boot), with longer pauses each time.
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] 2>/dev/null; }
pause=30
until node_ok || { bash /cage/provision.sh "$KIND" --node && node_ok; }; do
  log "couldn't install Node.js; trying again in ${pause}s"
  sleep "$pause"
  pause=$(( pause * 2 < 600 ? pause * 2 : 600 ))
done
chown "$U:$U" /cage-app /cage-app/in /cage-app/out /cage-app/files 2>/dev/null || true

delay=2
while true; do
  started=$SECONDS
  runuser -u "$U" -- env -i HOME="$H" PATH="/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 \
    APP_DIR=/cage-app APP_WORK="$H/work" APP_TOKEN="$TOKEN" \
    APP_BRIDGE_URL="ws://127.0.0.1:$BRIDGE/bridge/ws" APP_MGMT_URL="http://127.0.0.1:$MGMT" \
    node /cage/app.mjs
  rc=$?
  # After a run of more than 5 minutes, a crash is news, not a loop: start again from the shortest pause.
  [ $(( SECONDS - started )) -gt 300 ] && delay=2
  log "exited ($rc); restarting in ${delay}s"
  sleep "$delay"
  delay=$(( delay * 2 < 60 ? delay * 2 : 60 ))
done
