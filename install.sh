#!/usr/bin/env bash
# cage installer, for Linux and for Ubuntu inside WSL 2:
#   curl -fsSL https://raw.githubusercontent.com/z-brenner/cage/main/install.sh | bash
# Puts cage in ~/cage, a `cage` command in ~/.local/bin, then starts the guided setup.
# Re-running it updates cage. Override with CAGE_DIR, CAGE_REPO, CAGE_REF; CAGE_NO_START=1 skips the setup.
set -euo pipefail

REPO="${CAGE_REPO:-https://github.com/z-brenner/cage}"
REF="${CAGE_REF:-main}"
DIR="${CAGE_DIR:-$HOME/cage}"
BIN="$HOME/.local/bin"

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then A=$'\033[38;5;214m' G=$'\033[38;5;36m' R=$'\033[38;5;203m' D=$'\033[2m' Z=$'\033[0m'; else A="" G="" R="" D="" Z=""; fi
ok() { printf '  %s✓%s %s\n' "$G" "$Z" "$*" >&2; }
die() { printf '  %s✗%s %s\n' "$R" "$Z" "$*" >&2; exit 1; }

printf '\n  %s[%s•%s|%s•%s]%s cage  %sinstalling…%s\n\n' "$A" "$Z" "$A" "$Z" "$A" "$Z" "$D" "$Z" >&2

[ "$(uname -s)" = Linux ] || die "cage runs on Linux, or on Windows inside WSL 2 (see the README)"

missing=()
for c in git curl; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
if [ ${#missing[@]} -gt 0 ]; then
  command -v apt-get >/dev/null 2>&1 || die "please install ${missing[*]} first"
  command -v qrencode >/dev/null 2>&1 || missing+=(qrencode)   # QR codes for links you open on your phone
  ok "installing ${missing[*]} (needs your password)"
  sudo apt-get update -qq && sudo apt-get install -y -qq "${missing[@]}" >/dev/null
elif ! command -v qrencode >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo apt-get install -y -qq qrencode >/dev/null 2>&1 || true   # optional; only when sudo needs no password
fi

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q --depth 1 origin "$REF" && git -C "$DIR" checkout -q -B "$REF" FETCH_HEAD
  ok "updated $DIR"
elif [ -e "$DIR" ]; then
  die "$DIR already exists and isn't a cage checkout; set CAGE_DIR to install elsewhere"
else
  git clone -q --depth 1 --branch "$REF" "$REPO" "$DIR"
  ok "downloaded cage to $DIR"
fi

mkdir -p "$BIN"
ln -sf "$DIR/cage" "$BIN/cage"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    line='export PATH="$HOME/.local/bin:$PATH"   # added by the cage installer'
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
      if [ -f "$rc" ] || [ "$rc" = "$HOME/.bashrc" ]; then
        grep -qF "added by the cage installer" "$rc" 2>/dev/null || printf '\n%s\n' "$line" >> "$rc"
      fi
    done
    export PATH="$BIN:$PATH"
    ;;
esac
ok "type ${A}cage${Z} in any new terminal to come back here"

if [ -n "${CAGE_NO_START:-}" ]; then exit 0; fi
# Under `curl | bash`, stdin is the download, so the guided setup reads the keyboard from the terminal.
if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
  exec "$DIR/cage" </dev/tty
fi
printf '\n  next: run %scage%s\n\n' "$A" "$Z" >&2
