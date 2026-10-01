#!/usr/bin/env bash
# cage installer, for Linux and for Ubuntu inside WSL 2:
#   curl -fsSL https://github.com/z-brenner/cage/releases/latest/download/install.sh | bash
# Installs the latest release into ~/cage (checked against the release's SHA256SUMS), puts a `cage` command in
# ~/.local/bin, then starts the guided setup. Re-running it updates cage.
# Overrides: CAGE_DIR (where), CAGE_REF (install a branch or tag from git instead, e.g. main), CAGE_REPO,
# CAGE_RELEASES (where releases live); CAGE_NO_START=1 skips the setup.
set -euo pipefail

REPO="${CAGE_REPO:-https://github.com/z-brenner/cage}"
RELEASES="${CAGE_RELEASES:-$REPO/releases}"
REF="${CAGE_REF:-}"
DIR="${CAGE_DIR:-$HOME/cage}"
BIN="$HOME/.local/bin"

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then A=$'\033[38;5;214m' G=$'\033[38;5;36m' R=$'\033[38;5;203m' D=$'\033[2m' Z=$'\033[0m'; else A="" G="" R="" D="" Z=""; fi
ok() { printf '  %s✓%s %s\n' "$G" "$Z" "$*" >&2; }
warn() { printf '  %s!%s %s\n' "$A" "$Z" "$*" >&2; }
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

is_cage() { [ -f "$1/cage" ] && [ -d "$1/guest" ]; }
[ ! -e "$DIR" ] || is_cage "$DIR" || die "$DIR already exists and isn't a cage checkout; set CAGE_DIR to install elsewhere"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# The latest release: its tarball, checked against the release's SHA256SUMS, swapped in for the old copy.
install_release() {
  local tag tmp want got
  tag="$(curl -fsSI "$RELEASES/latest" 2>/dev/null | tr -d '\r' | sed -n 's#^[Ll]ocation: .*/tag/\([^/[:space:]]*\)$#\1#p' | head -n 1 || true)"
  [ -n "$tag" ] || return 1
  if [ -f "$DIR/VERSION" ] && [ "$(cat "$DIR/VERSION")" = "$tag" ] && [ ! -d "$DIR/.git" ]; then
    ok "cage $tag is already the latest"
    return 0
  fi
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/cage.tar.gz" "$RELEASES/download/$tag/cage-$tag.tar.gz" &&
    curl -fsSL -o "$tmp/SHA256SUMS" "$RELEASES/download/$tag/SHA256SUMS" || { rm -rf "$tmp"; die "couldn't download cage $tag"; }
  want="$(sed -n "s/^\([0-9a-f]\{64\}\)  cage-$tag\.tar\.gz$/\1/p" "$tmp/SHA256SUMS")"
  got="$(sha256 "$tmp/cage.tar.gz")"
  [ -n "$want" ] && [ "$want" = "$got" ] || { rm -rf "$tmp"; die "the download doesn't match its checksum; nothing was installed"; }
  mkdir "$tmp/x" && tar -xzf "$tmp/cage.tar.gz" -C "$tmp/x"
  is_cage "$tmp/x/cage" || { rm -rf "$tmp"; die "the release doesn't look like cage; nothing was installed"; }
  mkdir -p "$(dirname "$DIR")"
  if [ -e "$DIR" ] && [ ! -d "$DIR/.git" ]; then
    # In place, so the folders stay the same ones: running agents' VMs keep their mount of guest/, and a running
    # cage keeps reading its old copy. Then files the new release no longer has are taken out.
    (cd "$tmp/x/cage" && find . -type f -o -type l | sort) > "$tmp/new"
    (cd "$DIR" && find . -type f -o -type l | sort) > "$tmp/old"
    tar -xzf "$tmp/cage.tar.gz" -C "$DIR" --strip-components=1
    comm -23 "$tmp/old" "$tmp/new" | (cd "$DIR" && xargs -r -d '\n' rm -f --)
  else
    if [ -e "$DIR" ]; then mv "$DIR" "$DIR.old.$$"; fi   # a git checkout becomes a release
    mv "$tmp/x/cage" "$DIR"
    rm -rf "$DIR.old.$$"
  fi
  rm -rf "$tmp"
  ok "installed cage $tag (checksum verified)"
}

# A branch or tag straight from git (for development, or before the first release).
install_git() {
  local ref="${REF:-main}"
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch -q --depth 1 origin "$ref" && git -C "$DIR" checkout -q -B "$ref" FETCH_HEAD
    ok "updated $DIR ($ref)"
  else
    [ ! -e "$DIR" ] || mv "$DIR" "$DIR.old.$$"
    git clone -q --depth 1 --branch "$ref" "$REPO" "$DIR"
    rm -rf "$DIR.old.$$"
    ok "downloaded cage ($ref) to $DIR"
  fi
  # `cage update` stays on a branch you picked; without one, it moves to releases once there are some.
  if [ -n "$REF" ]; then printf '%s\n' "$REF" > "$DIR/.git/cage-ref"; else rm -f "$DIR/.git/cage-ref"; fi
}

if [ -n "$REF" ]; then
  install_git
elif ! install_release; then
  warn "no cage release found; installing the development version from git"
  install_git
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
