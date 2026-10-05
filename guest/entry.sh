#!/bin/bash
# Main process of a cage microVM, started by `cage up` as:
#   msb run -d --name cage-<agent> … ubuntu:24.04 -- /bin/bash /cage/entry.sh <kind>
# Mounts: /cage (this dir, read-only), /cage-config (generated cc-connect.toml, read-only),
#         /home/agent (named volume: the agent's login, sessions and work survive restarts),
#         /memory (the user's approved memory, read-only) and /memory-inbox (this agent's proposed notes).
# /cage-config also says which secrets (names only) and connectors this agent has.
#
# 1. ensure the unprivileged `agent` user owns the persistent home
# 2. first boot: install the agent CLI + cc-connect (retried until it succeeds, each try with a time limit)
# 3. run cc-connect as `agent`, restarting it if it ever exits; the browser, if it's on, gets ready meanwhile
set -uo pipefail

KIND="${1:?usage: entry.sh <claude|codex|cursor|antigravity>}"
U=agent
H=/home/agent
CONFIG_SRC=/cage-config/cc-connect.toml
PROVISION=/cage/provision.sh
PROVISION_LIMIT="${CAGE_PROVISION_LIMIT:-1800}"   # seconds for the first try at provisioning, then it starts over
[[ "$PROVISION_LIMIT" =~ ^[0-9]+$ ]] || PROVISION_LIMIT=1800

log() { echo "cage-entry[$KIND]: $*"; }

# `cage update` sets CAGE_REFRESH: the newest of everything. When that keeps failing (offline, or a vendor's servers
# are down), the agent wakes up with the versions it had, from its cache, instead of staying down.
refresh_arg() { # refresh_arg <attempt>: --refresh for the first two tries of `cage update`, then nothing
  if [ -n "${CAGE_REFRESH:-}" ] && [ "$1" -le 2 ]; then echo --refresh; fi
}

# One try at provisioning, with a time limit: a step that hangs is started over, never waited on forever. The limit
# grows with each try (up to 8 times), as do those of the steps inside (provision.sh), so on a slow connection a
# download that can't resume (a vendor's installer) still gets there. A failure is logged as "provisioning failed",
# which `cage status` shows as a network hiccup.
provision_try() { # provision_try <attempt> <seconds until the next one>
  local refresh rc=0 max=$(( PROVISION_LIMIT * ($1 < 8 ? $1 : 8) ))
  refresh="$(refresh_arg "$1")"
  CAGE_PROVISION_ATTEMPT="$1" timeout -k 60 "$max" bash "$PROVISION" "$KIND" ${refresh:+"$refresh"} </dev/null || rc=$?
  [ "$rc" != 0 ] || return 0
  if [ -n "$refresh" ] && [ -z "$(refresh_arg $(( $1 + 1 )))" ]; then
    log "couldn't get the newest versions (offline?); starting with the ones you had"
  fi
  case $rc in
    124|137) log "provisioning failed: it took more than ${max}s; trying again in ${2}s" ;;
    *) log "provisioning failed; retrying in ${2}s (network down? see output above)" ;;
  esac
  return 1
}

# cc-connect's restarts: after 5s, then twice as long after each quick exit, up to a minute; 5s again after a good run
restart_wait() { # restart_wait <previous wait> <seconds it ran>
  if [ "$2" -ge 300 ] || [ "$1" -lt 5 ]; then echo 5; elif [ "$1" -ge 30 ]; then echo 60; else echo $(( $1 * 2 )); fi
}
cc_connect_stopped() { # cc_connect_stopped <exit code> <seconds it ran>: says so, and sets $pause for the restart
  pause="$(restart_wait "$pause" "$2")"
  if [ "$2" -ge 300 ]; then quick=0; else quick=$((quick + 1)); fi
  if [ "$quick" = 5 ]; then log "cc-connect keeps stopping soon after it starts (5 times in a row); the lines above say why"; fi
  log "cc-connect exited with $1; restarting in ${pause}s"
}

if [ "${CAGE_ENTRY_LIB:-}" = 1 ]; then return 0; fi   # test/provision-unit.sh: just the functions above

if ! id "$U" >/dev/null 2>&1; then
  # uid 1001, as ubuntu:24.04 has always given it (after its own `ubuntu` user), so the files on the home volume stay
  # the agent's whatever image the VM boots
  if getent passwd 1001 >/dev/null; then useradd -M -U -d "$H" -s /bin/bash "$U"
  else useradd -M -u 1001 -U -d "$H" -s /bin/bash "$U"; fi
fi
mkdir -p "$H"
if [ -e "$H/.cc-connect" ] && [ "$(stat -c %u "$H/.cc-connect")" != "$(id -u "$U")" ]; then
  log "the agent's files belong to another user id; giving them back to $U (once)"
  chown -R "$U:$U" "$H"
fi
chown "$U:$U" "$H"
chmod 750 "$H"

attempt=1
delay=15
until provision_try "$attempt" "$delay"; do
  sleep "$delay"
  delay=$(( delay < 240 ? delay * 2 : 240 ))
  attempt=$((attempt + 1))
done

# Your time zone (cage passes it as TZ), so "every weekday at 8am" in a scheduled task means your 8am. Set for the
# whole VM, since cc-connect starts with a clean environment.
if [[ "${TZ:-}" =~ ^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$ ]] && [ -f "/usr/share/zoneinfo/$TZ" ]; then
  ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime
  echo "$TZ" > /etc/timezone
fi

# The VM is the sandbox: the agent may administer its own VM.
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$U" > /etc/sudoers.d/agent
chmod 0440 /etc/sudoers.d/agent

[ -r "$CONFIG_SRC" ] || { log "missing $CONFIG_SRC (run \`cage up\` on the host)"; sleep infinity; }
install -d -m 700 -o "$U" -g "$U" "$H/.cc-connect" "$H/work"
install -m 600 -o "$U" -g "$U" "$CONFIG_SRC" "$H/.cc-connect/config.toml"
# cc-connect starts with a clean environment, so carry over what microsandbox set up for this VM: the
# placeholders standing in for the user's secrets, and the CA that its TLS interception needs trusted.
# A placeholder looks like $MSB_GITHUB_TOKEN. Some CLIs expand $VARS in their config files, so each placeholder is
# also set to itself: expanded or not, what leaves the VM is the placeholder that microsandbox swaps out.
for v in SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO \
         $(cat /cage-config/secrets.names 2>/dev/null); do
  [[ "$v" =~ ^[A-Z][A-Z0-9_]*$ ]] && [ -n "${!v:-}" ] || continue
  printf '%s=%q\n' "$v" "${!v}"
  if [[ "${!v}" =~ ^\$(MSB_[A-Z0-9_]+)$ ]]; then printf '%s=%q\n' "${BASH_REMATCH[1]}" "${!v}"; fi
done > /etc/cage/runtime.env
chmod 644 /etc/cage/runtime.env
# The privacy mask's own terms (cage mask add), readable by the agent user that runs guest/mask.py
if [ -r /cage-config/mask.terms ]; then install -m 644 /cage-config/mask.terms /etc/cage/mask.terms; else rm -f /etc/cage/mask.terms; fi
bash /cage/memory.sh "$KIND" || log "could not wire memory (continuing without it)"
bash /cage/connectors.sh "$KIND" || log "could not wire connectors (continuing without them)"

# The app's chat (guest/app.sh), and WhatsApp if it's on for this agent: adapters on cc-connect's bridge
if [ -r /cage-config/app.env ]; then bash /cage/app.sh "$KIND" & fi
if [ -r /cage-config/whatsapp.env ]; then bash /cage/whatsapp.sh "$KIND" & fi
# Voice notes, if they're on (`cage voice on`): ffmpeg, and speech-to-text on this VM (guest/voice.sh)
if [ -r /cage-config/voice.env ]; then bash /cage/voice.sh "$KIND" & fi
# /all and stand-ins write requests for cage into /cage-outbox (guest/hook.sh)
if [ -d /cage-outbox ]; then chown "$U:$U" /cage-outbox 2>/dev/null || true; fi

# The browser gets ready in the background (guest/browser.sh): the first time, Chromium downloads, and the agent can
# chat meanwhile
if grep -q '^browser|local:browser|' /cage-config/connectors.list 2>/dev/null; then bash /cage/browser.sh "$KIND" & fi

log "starting cc-connect as $U"
pause=0
quick=0
while true; do
  started=$SECONDS
  runuser -u "$U" -- env -i HOME="$H" USER="$U" LOGNAME="$U" SHELL=/bin/bash LANG=C.UTF-8 \
    PATH="/usr/local/bin:/usr/bin:/bin" TERM=xterm-256color \
    bash -c 'set -a; [ -r /etc/cage/env ] && . /etc/cage/env; [ -r /etc/cage/runtime.env ] && . /etc/cage/runtime.env; set +a
      cd "$HOME/work"; exec cc-connect --config "$HOME/.cc-connect/config.toml"'
  cc_connect_stopped "$?" $((SECONDS - started))
  sleep "$pause"
done
