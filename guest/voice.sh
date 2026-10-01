#!/bin/bash
# Voice notes for this agent (`cage voice on`), started in the background by guest/entry.sh as root.
# cc-connect turns a voice note into text before the agent sees it: it converts the audio with ffmpeg, then asks a
# speech-to-text service. Here that's either
#   local: guest/stt.py, Whisper on this VM's CPU (faster-whisper); nothing you say leaves the VM
#   groq:  Groq's Whisper API, with your key (a microsandbox secret: the VM only has a placeholder)
# ffmpeg comes from the imageio-ffmpeg package (a static build). Both live in a Python environment on the home
# volume (~/.cache/cage-voice), so they download once, not at every boot.
set -uo pipefail

KIND="${1:?usage: voice.sh <agent>}"
U=agent
H=/home/agent
CONF=/cage-config/voice.env
DIR="$H/.cache/cage-voice"
VENV="$DIR/venv"
log() { echo "cage-voice[$KIND]: $*"; }

[ -r "$CONF" ] || exit 0
get() { sed -n "s/^$1=//p" "$CONF" | head -n 1; }
MODE="$(get VOICE_MODE)" MODEL="$(get VOICE_MODEL)" LANGUAGE="$(get VOICE_LANGUAGE)" PORT="$(get VOICE_PORT)"
[[ "$MODE" =~ ^(local|groq)$ && "$MODEL" =~ ^[a-z0-9.-]*$ && "$LANGUAGE" =~ ^[a-z]{0,3}$ && "$PORT" =~ ^[0-9]+$ ]] \
  || { log "bad settings in $CONF"; exit 1; }

pkgs="imageio-ffmpeg==0.6.0"
[ "$MODE" = local ] && pkgs="faster-whisper==1.2.1 $pkgs"
as_agent() { # as_agent <command…>: as the agent user, trusting what this VM trusts (microsandbox's CA, if any)
  runuser -u "$U" -- env HOME="$H" bash -c 'set -a; [ -r /etc/cage/runtime.env ] && . /etc/cage/runtime.env; set +a
    [ -z "${SSL_CERT_FILE:-}" ] || export PIP_CERT="$SSL_CERT_FILE"; exec "$@"' _ "$@"
}

install -d -m 700 -o "$U" -g "$U" "$H/.cache" "$DIR"
until [ "$(cat "$DIR/.installed" 2>/dev/null)" = "$pkgs" ]; do
  log "installing $pkgs (once; about $([ "$MODE" = local ] && echo 200 || echo 30) MB)"
  if as_agent python3 -m venv "$VENV" && as_agent "$VENV/bin/pip" install -q --disable-pip-version-check $pkgs; then
    echo "$pkgs" > "$DIR/.installed"
  else
    log "install failed; retrying in 60s"
    sleep 60
  fi
done

ff="$(as_agent "$VENV/bin/python" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())' 2>/dev/null)"
if [ -n "$ff" ] && [ -f "$ff" ]; then
  chmod 755 "$ff"
  ln -sf "$ff" /usr/local/bin/ffmpeg
  log "ffmpeg ready"
else
  log "couldn't find ffmpeg in $VENV"
fi

[ "$MODE" = local ] || exit 0
delay=5
while true; do
  log "speech-to-text on 127.0.0.1:$PORT (Whisper ${MODEL:-base})"
  as_agent env STT_PORT="$PORT" STT_MODEL="$MODEL" STT_LANGUAGE="$LANGUAGE" STT_MODELS="$DIR/models" \
    "$VENV/bin/python" /cage/stt.py
  log "speech-to-text exited ($?); restarting in ${delay}s"
  sleep "$delay"
  delay=$(( delay < 120 ? delay * 2 : 120 ))
done
