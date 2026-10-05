#!/usr/bin/env bash
# cage installer, for Linux and for Ubuntu inside WSL 2:
#   curl -fsSL https://github.com/z-brenner/cage/releases/latest/download/install.sh | bash
# Installs the latest release into ~/cage (checked against the release's SHA256SUMS), puts a `cage` command in
# ~/.local/bin, then starts the guided setup. Re-running it updates cage. It never moves to an older release on its
# own, and never swaps a release for a git checkout. When GitHub can't be reached it changes nothing and exits with 3;
# an update that stops halfway (some files new, VERSION still the old one) exits with 4: running it again finishes it.
# Overrides: CAGE_DIR (where), CAGE_VERSION (a release to install, e.g. v0.3.0, older ones too: `cage update --to`),
# CAGE_REF (a branch or tag from git instead, e.g. main), CAGE_REPO, CAGE_RELEASES (where releases live);
# CAGE_NO_START=1 skips the setup, CAGE_TERMINAL=1 keeps it in this terminal; CAGE_ALLOW_ROOT=1 installs as root.
# Each release it installs is also kept in ~/.cage/releases (the last two), so `cage rollback` can go back without a
# download: CAGE_FROM=<one of those folders> installs from there.
set -euo pipefail

REPO="${CAGE_REPO:-https://github.com/z-brenner/cage}"
RELEASES="${CAGE_RELEASES:-$REPO/releases}"
REF="${CAGE_REF:-}"
WANT="${CAGE_VERSION:-}"
FROM="${CAGE_FROM:-}"
DIR="${CAGE_DIR:-$HOME/cage}"
DIR="${DIR%/}"
BIN="$HOME/.local/bin"
KEEP="${CAGE_HOME:-$HOME/.cage}/releases"
MARK="added by the cage installer"

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then A=$'\033[38;5;214m' G=$'\033[38;5;36m' R=$'\033[38;5;203m' D=$'\033[2m' Z=$'\033[0m'; else A="" G="" R="" D="" Z=""; fi
ok() { printf '  %s✓%s %s\n' "$G" "$Z" "$*" >&2; }
warn() { printf '  %s!%s %s\n' "$A" "$Z" "$*" >&2; }
die() { printf '  %s✗%s %s\n' "$R" "$Z" "$*" >&2; exit 1; }
offline() { printf '  %s✗%s %s\n' "$R" "$Z" "$*" >&2; exit 3; }   # the network isn't there; `cage update` stops too
halfway() { printf '  %s✗%s %s\n' "$R" "$Z" "$*; run this again to finish the update" >&2; exit 4; }   # so does it here

printf '\n  %s[%s•%s|%s•%s]%s cage  %sinstalling…%s\n\n' "$A" "$Z" "$A" "$Z" "$A" "$Z" "$D" "$Z" >&2

[ "$(uname -s)" = Linux ] || die "cage runs on Linux, or on Windows inside WSL 2 (see the README)"

# cage lives in your home folder and runs as you; run as root (or with sudo), it would end up in /root instead.
SUDO=sudo
if [ "${CAGE_TEST_EUID:-$EUID}" = 0 ]; then
  [ -n "${CAGE_ALLOW_ROOT:-}" ] || die "install cage as your normal user, not with sudo or as root (CAGE_ALLOW_ROOT=1 installs it as root anyway)"
  SUDO=""
fi
as_root() { if [ -n "$SUDO" ]; then sudo "$@"; else "$@"; fi; }

pkg_hint() { # pkg_hint <package>...: how to install packages on this kind of Linux
  if command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install $*"
  elif command -v dnf >/dev/null 2>&1; then echo "sudo dnf install $*"
  elif command -v pacman >/dev/null 2>&1; then echo "sudo pacman -S $*"
  elif command -v zypper >/dev/null 2>&1; then echo "sudo zypper install $*"
  else echo "install $* with your system's package manager"; fi
}

need() { # need <command>...: installs the missing ones (apt-get; it may ask for your password), or says how to
  local missing=() c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  [ ${#missing[@]} -gt 0 ] || return 0
  command -v apt-get >/dev/null 2>&1 || die "cage needs ${missing[*]}: $(pkg_hint "${missing[@]}"), then run this again"
  [ -z "$SUDO" ] || command -v sudo >/dev/null 2>&1 ||
    die "cage needs ${missing[*]}, and installing them needs sudo: ask whoever looks after this computer to $(pkg_hint "${missing[@]}")"
  command -v qrencode >/dev/null 2>&1 || missing+=(qrencode)   # QR codes for links you open on your phone
  ok "installing ${missing[*]}${SUDO:+ (needs your password)}"
  { as_root apt-get update -qq && as_root apt-get install -y -qq "${missing[@]}"; } >/dev/null ||
    die "couldn't install ${missing[*]}; try $(pkg_hint "${missing[@]}") yourself, then run this again"
}

need curl tar gzip
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
  die "cage needs sha256sum (or shasum) to check what it downloads: $(pkg_hint coreutils)"
if ! command -v qrencode >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1 && { [ -z "$SUDO" ] || sudo -n true 2>/dev/null; }; then
  as_root apt-get install -y -qq qrencode >/dev/null 2>&1 || true   # optional; only when it needs no password
fi

is_cage() { [ -f "$1/cage" ] && [ -d "$1/guest" ]; }
[ ! -e "$DIR" ] || is_cage "$DIR" || die "$DIR already exists and isn't a cage checkout; set CAGE_DIR to install elsewhere"

# Left by an install that was stopped on the way (killed, or the computer went off): an update's unpacked files, a new
# copy that never went in, the old copy after a swap. Each is named after the installer's process, so the folders of
# one still running (the web app's Update and a `cage update` at once) stay. An old copy whose replacement never
# arrived goes back where it was.
for d in "$DIR"/.update.* "$DIR".new.* "$DIR".old.*; do
  pid="${d##*.}"
  [ -e "$d" ] && [ -n "$pid" ] && [ -z "${pid//[0-9]/}" ] || continue
  ! kill -0 "$pid" 2>/dev/null || continue
  case "$d" in "$DIR".old.*) if [ ! -e "$DIR" ] && is_cage "$d" && mv "$d" "$DIR"; then continue; fi ;; esac
  rm -rf "$d" 2>/dev/null || warn "couldn't remove $d, left by an install that was stopped on the way"
done

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
valid_tag() { [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; }
older() { # older <a> <b>: release a came before b (v1.2.0-rc.1 comes before v1.2.0, as in semver)
  local a="${1%%-*}" b="${2%%-*}"
  [ "$1" != "$2" ] || return 1
  if [ "$a" = "$b" ]; then
    [ "$1" != "$a" ] || return 1   # a is the release itself, b one of its previews
    [ "$2" != "$b" ] || return 0
    a="$1" b="$2"
  fi
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n 1)" = "$a" ]
}
host_of() { local h="${1#*://}"; printf '%s' "${h%%/*}"; }

# Downloads retry a few times, over https only (redirects too), and give up on a server that stops answering instead of
# waiting forever. The one exception to https is the tests' stand-in for GitHub, plain http on this computer;
# CAGE_TEST_TIMEOUT shortens the waits for them.
https=(--proto "=https" --proto-redir "=https")
case "$RELEASES" in
  https://*) ;;
  http://127.0.0.1[:/]*|http://localhost[:/]*) https=() ;;
  *) [ -n "$REF" ] || die "CAGE_RELEASES has to be an https:// address, so what's downloaded from it can be trusted (not $RELEASES)" ;;
esac
wait_s="${CAGE_TEST_TIMEOUT:-15}"
net=(--retry 3 --retry-connrefused --retry-max-time "$((wait_s * 4))" --connect-timeout "$wait_s" ${https[@]+"${https[@]}"})

# Whatever goes wrong, temporary files go, and a half-done swap of the whole folder is undone.
TMP="" STAGE="" OLD=""
cleanup() {
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  if [ -n "$OLD" ] && [ -e "$OLD" ] && [ ! -e "$DIR" ]; then mv "$OLD" "$DIR"; fi
  [ -z "$TMP" ] || rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The newest release, from where /releases/latest redirects to. Prints its tag, "none" (there's no release yet: a 404,
# or a redirect that isn't to a release) or "unreachable" (no answer, or one that makes no sense).
latest_tag() {
  local out code url tag
  out="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "${net[@]}" --max-time "$((wait_s * 2))" \
    "$RELEASES/latest" 2>/dev/null)" || out=""
  code="${out%% *}" url="${out#* }"
  case "$code" in
    404) echo none ;;
    301|302|303|307|308)
      case "$url" in
        */tag/*) tag="${url##*/tag/}"; if valid_tag "$tag"; then echo "$tag"; else echo unreachable; fi ;;
        *) echo none ;;
      esac ;;
    *) echo unreachable ;;
  esac
}

fetch() { # fetch <url> <file>: a download that was there (a 404 means it isn't; anything else, the network)
  local code
  # a slow line is fine; one where almost nothing arrives for a minute isn't
  code="$(curl -sSL "${net[@]}" --speed-limit 1024 --speed-time "$((wait_s * 4))" -o "$2" -w '%{http_code}' "$1" 2>/dev/null)" ||
    code=000
  case "$code" in
    2??) ;;
    404) die "there's no ${1##*/} to download at $(dirname "$1"); nothing was changed" ;;
    *) offline "the download from $(host_of "$1") didn't finish: check your internet connection, then try again. Nothing was changed." ;;
  esac
}

# A release: its tarball, checked against the release's SHA256SUMS, put in place of the old copy.
install_release() { # install_release <tag>
  local tag="$1" have="" want
  if [ -f "$DIR/VERSION" ] && [ ! -d "$DIR/.git" ]; then have="$(cat "$DIR/VERSION")"; fi
  if [ "$have" = "$tag" ]; then
    if [ -n "$WANT" ]; then ok "cage $tag is already installed"; else ok "cage $tag is already the latest"; fi
    return 0
  fi
  if [ -n "$have" ] && [ -z "$WANT" ] && valid_tag "$have" && older "$tag" "$have"; then
    warn "this cage ($have) is newer than the latest release ($tag), so it stays as it is (CAGE_VERSION=$tag installs that)"
    return 0
  fi
  TMP="$(mktemp -d)"
  if [ -n "$FROM" ]; then
    { cp "$FROM/cage-$tag.tar.gz" "$TMP/cage.tar.gz" && cp "$FROM/SHA256SUMS" "$TMP/SHA256SUMS"; } 2>/dev/null ||
      die "there's no copy of cage $tag in $FROM; nothing was changed"
  else
    fetch "$RELEASES/download/$tag/cage-$tag.tar.gz" "$TMP/cage.tar.gz"
    fetch "$RELEASES/download/$tag/SHA256SUMS" "$TMP/SHA256SUMS"
  fi
  want="$(sed -n "s/^\([0-9a-f]\{64\}\)  cage-${tag//./\\.}\.tar\.gz$/\1/p" "$TMP/SHA256SUMS")"
  if [ -z "$want" ] || [ "$want" != "$(sha256 "$TMP/cage.tar.gz")" ]; then
    [ -z "$FROM" ] || die "the copy of cage $tag in $FROM changed since it was installed (it doesn't match its checksum), so it isn't used; nothing was installed"
    die "the download was incomplete or changed (it doesn't match its checksum); try again (nothing was installed)"
  fi
  # Unpacked on the same disk as the install, so putting each file in place is a rename that can't half-happen.
  if [ -e "$DIR" ] && [ ! -d "$DIR/.git" ]; then STAGE="$DIR/.update.$$"; else STAGE="$DIR.new.$$"; fi
  { mkdir -p "$(dirname "$DIR")" && mkdir "$STAGE"; } || die "couldn't write to $(dirname "$STAGE"); nothing was changed"
  tar -xzf "$TMP/cage.tar.gz" -C "$STAGE" --strip-components=1 ||
    die "couldn't unpack cage $tag (is the disk full?); nothing was changed"
  is_cage "$STAGE" && [ "$(cat "$STAGE/VERSION" 2>/dev/null)" = "$tag" ] || die "the download doesn't contain cage $tag; nothing was changed"
  if [ "$STAGE" = "$DIR/.update.$$" ]; then
    update_in_place
  else
    swap_in "$STAGE"   # a first install, or a git checkout becoming a release
    STAGE=""
  fi
  [ "$(cat "$DIR/VERSION" 2>/dev/null)" = "$tag" ] || halfway "cage $tag didn't end up in $DIR"
  keep_release "$tag"
  rm -rf "$TMP"
  TMP=""
  ok "installed cage $tag (checksum verified)"
}

# In place, so the folders stay the same ones: running agents' VMs keep their mount of guest/, and a running cage
# keeps reading its old copy (each file is swapped by a rename). The files the new release dropped go next, and VERSION
# last: a cage that stops halfway still says the old version, and running this again finishes the job.
update_in_place() {
  local f p
  (cd "$STAGE" && find . \( -type f -o -type l \) -print | LC_ALL=C sort) > "$TMP/new" || die "couldn't list the new files"
  (cd "$DIR" && find . -path './.update.*' -prune -o \( -type f -o -type l \) -print | LC_ALL=C sort) > "$TMP/old" ||
    die "couldn't list the files in $DIR; nothing was changed"
  while IFS= read -r f; do
    [ "$f" != ./VERSION ] || continue
    { clear_way "${f#./}" && mkdir -p "$DIR/${f%/*}" && mv -f "$STAGE/$f" "$DIR/$f"; } || halfway "couldn't replace $DIR/${f#./}"
  done < "$TMP/new"
  while IFS= read -r f; do
    p="$DIR/${f#./}"
    # gone already, or a folder now: the new release turned that file into one (and put its files in it above)
    if [ -L "$p" ] || { [ -e "$p" ] && [ ! -d "$p" ]; }; then
      rm -f -- "$p" || halfway "couldn't remove $p, which the new release dropped"
    fi
    p="${p%/*}"
    while [ "$p" != "$DIR" ] && rmdir -- "$p" 2>/dev/null; do p="${p%/*}"; done   # folders it leaves empty go too
  done < <(LC_ALL=C comm -23 "$TMP/old" "$TMP/new")
  mv -f "$STAGE/VERSION" "$DIR/VERSION" || halfway "couldn't replace $DIR/VERSION"
  rm -rf "$STAGE" || warn "couldn't remove $STAGE"
  STAGE=""
}

clear_way() { # clear_way <path in $DIR>: what stands where a file of the new release goes: a file (or link) where it
  # needs a folder, a folder (or a link) where the file goes. Only when a release turns a file into a folder or back.
  local p="$DIR" rest="$1"
  while [ "${rest#*/}" != "$rest" ]; do
    p="$p/${rest%%/*}" rest="${rest#*/}"
    if [ -L "$p" ] || { [ -e "$p" ] && [ ! -d "$p" ]; }; then rm -f -- "$p" || return 1; fi
  done
  p="$p/$rest"
  if [ -L "$p" ]; then rm -f -- "$p" || return 1
  elif [ -d "$p" ]; then rm -rf -- "$p" || return 1; fi
  return 0
}

swap_in() { # swap_in <folder>: it becomes $DIR; if that fails on the way, the old copy is put back
  local o
  if [ -e "$DIR" ]; then
    OLD="$DIR.old.$$"
    mv "$DIR" "$OLD" || { OLD=""; die "couldn't move the old $DIR aside; nothing was changed"; }
  fi
  mv "$1" "$DIR" || die "couldn't put the new cage in $DIR; the old one is back"
  if [ -n "$OLD" ]; then
    o="$OLD" OLD=""
    rm -rf "$o" || warn "couldn't remove the old copy in $o"
  fi
}

keep_release() { # keep_release <tag>: a copy for `cage rollback`, with its checksums; the last two releases are kept
  local d="$KEEP/$1" old n=0
  { (umask 077; mkdir -p "$d") && cp "$TMP/cage.tar.gz" "$d/cage-$1.tar.gz" && cp "$TMP/SHA256SUMS" "$d/SHA256SUMS" && touch "$d"; } 2>/dev/null ||
    { warn "couldn't keep a copy of cage $1 in $KEEP (for cage rollback)"; return 0; }
  while IFS= read -r old; do
    valid_tag "$old" || continue
    n=$((n + 1))
    [ "$n" -le 2 ] || rm -rf "${KEEP:?}/$old"
  done < <(ls -1t "$KEEP")
}

# A branch or tag straight from git (for development, or before the first release).
install_git() {
  local ref="${REF:-main}"
  need git
  if [ -d "$DIR/.git" ]; then
    { git -C "$DIR" fetch -q --depth 1 origin "$ref" && git -C "$DIR" checkout -q -B "$ref" FETCH_HEAD; } ||
      die "couldn't update $DIR from git ($ref)"
    ok "updated $DIR ($ref)"
  else
    mkdir -p "$(dirname "$DIR")"
    STAGE="$DIR.new.$$"
    git clone -q --depth 1 --branch "$ref" "$REPO" "$STAGE" || die "couldn't download cage ($ref) from $REPO; nothing was changed"
    swap_in "$STAGE"
    STAGE=""
    ok "downloaded cage ($ref) to $DIR"
  fi
  # `cage update` stays on a branch you picked; without one, it moves to releases once there are some.
  if [ -n "$REF" ]; then printf '%s\n' "$REF" > "$DIR/.git/cage-ref"; else rm -f "$DIR/.git/cage-ref"; fi
}

if [ -n "$REF" ]; then
  install_git
elif [ -n "$WANT" ]; then
  valid_tag "$WANT" || die "CAGE_VERSION should name a release, like v0.3.0 (not $WANT)"
  install_release "$WANT"
else
  tag="$(latest_tag)"
  case "$tag" in
    unreachable)
      offline "can't reach $(host_of "$RELEASES"): check your internet connection or company proxy, then try again. Nothing was changed." ;;
    none)
      # Only before the first release: an installed release never turns into an unreviewed checkout of main.
      [ ! -f "$DIR/VERSION" ] || die "no cage release found at $RELEASES, so cage $(cat "$DIR/VERSION") stays as it is"
      warn "no cage release found; installing the development version from git"
      install_git ;;
    *) install_release "$tag" ;;
  esac
fi

mkdir -p "$BIN"
ln -sf "$DIR/cage" "$BIN/cage"
add_line() { # add_line <file> <line>: once (`cage uninstall` takes out the lines marked like this)
  grep -qF "$MARK" "$1" 2>/dev/null && return 0
  mkdir -p "$(dirname "$1")" && printf '\n%s\n' "$2" >> "$1"
}
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    line="export PATH=\"\$HOME/.local/bin:\$PATH\"   # $MARK"
    add_line "$HOME/.bashrc" "$line"
    # zsh reads ~/.zshrc, so it gets one when zsh is your shell, even if there's none yet
    if [ -f "$HOME/.zshrc" ] || [ "${SHELL##*/}" = zsh ]; then add_line "$HOME/.zshrc" "$line"; fi
    # login shells (a desktop session, ssh) read ~/.profile; Ubuntu's own already adds ~/.local/bin
    grep -q '\.local/bin' "$HOME/.profile" 2>/dev/null || add_line "$HOME/.profile" "$line"
    if command -v fish >/dev/null 2>&1; then
      add_line "$HOME/.config/fish/conf.d/cage.fish" "contains -- \$HOME/.local/bin \$PATH; or set -gx PATH \$HOME/.local/bin \$PATH   # $MARK"
    fi
    export PATH="$BIN:$PATH"
    ;;
esac
ok "type ${A}cage${Z} in any new terminal to come back here"

# Linux desktops: "cage" in the app menu opens the web app (on Windows, install.ps1 adds a Start menu shortcut)
if [ -z "${WSL_DISTRO_NAME:-}" ]; then
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/cage.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=cage
Comment=Your AI agents, each in its own little cage
Exec=$BIN/cage ui
Icon=$DIR/host/ui/static/logo.svg
Terminal=false
Categories=Development;Utility;
DESKTOP
fi

if [ -n "${CAGE_NO_START:-}" ]; then exit 0; fi
# With a desktop (or on Windows) the setup carries on in your browser; CAGE_TERMINAL=1 keeps it here.
if [ -z "${CAGE_TERMINAL:-}" ] && { [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; } &&
   command -v python3 >/dev/null 2>&1; then
  exec "$DIR/cage" ui
fi
# Under `curl | bash`, stdin is the download, so the guided setup reads the keyboard from the terminal.
if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
  exec "$DIR/cage" </dev/tty
fi
printf '\n  next: run %scage%s\n\n' "$A" "$Z" >&2
