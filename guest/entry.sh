#!/bin/bash
# Main process of a cage microVM, started by `cage up` as:
#   msb run -d --name cage-<agent> … ubuntu:24.04 -- /bin/bash /cage/entry.sh <kind>
# Mounts: /cage (this dir, read-only), /cage-config (generated cc-connect.toml, read-only),
#         /home/agent (named volume: the agent's login, sessions and work survive restarts).
#
# 1. ensure the unprivileged `agent` user owns the persistent home
# 2. first boot: install the agent CLI + cc-connect (retried until it succeeds)
# 3. run cc-connect as `agent`, restarting it if it ever exits
set -uo pipefail

KIND="${1:?usage: entry.sh <claude|codex|cursor|antigravity>}"
U=agent
H=/home/agent
CONFIG_SRC=/cage-config/cc-connect.toml

log() { echo "cage-entry[$KIND]: $*"; }

if ! id "$U" >/dev/null 2>&1; then
  useradd -M -d "$H" -s /bin/bash "$U"
fi
mkdir -p "$H"
chown "$U:$U" "$H"
chmod 750 "$H"

delay=15
until bash /cage/provision.sh "$KIND"; do
  log "provisioning failed; retrying in ${delay}s (network down? see output above)"
  sleep "$delay"
  delay=$(( delay < 240 ? delay * 2 : 240 ))
done

# The VM is the sandbox: the agent may administer its own VM.
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$U" > /etc/sudoers.d/agent
chmod 0440 /etc/sudoers.d/agent

[ -r "$CONFIG_SRC" ] || { log "missing $CONFIG_SRC (run \`cage up\` on the host)"; sleep infinity; }
install -d -m 700 -o "$U" -g "$U" "$H/.cc-connect" "$H/work"
install -m 600 -o "$U" -g "$U" "$CONFIG_SRC" "$H/.cc-connect/config.toml"

log "starting cc-connect as $U"
while true; do
  runuser -u "$U" -- env -i HOME="$H" USER="$U" LOGNAME="$U" SHELL=/bin/bash LANG=C.UTF-8 \
    PATH="/usr/local/bin:/usr/bin:/bin" TERM=xterm-256color \
    bash -c 'set -a; [ -r /etc/cage/env ] && . /etc/cage/env; set +a; cd "$HOME/work"; exec cc-connect --config "$HOME/.cc-connect/config.toml"'
  log "cc-connect exited with $?; restarting in 5s"
  sleep 5
done
