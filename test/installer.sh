#!/usr/bin/env bash
# Tests install.sh against local copies of this repo: from git (fresh install, the `cage` command, PATH setup, re-run
# update), and from releases on a local stand-in for GitHub Releases (checksums, in-place updates, a tampered download).
# Then everything that can go wrong on the way: no network, GitHub down while git works, a disk that fills up halfway,
# running as root, an older release.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
SERVER=""
trap '[ -z "$SERVER" ] || kill "$SERVER" 2>/dev/null; rm -rf "$T"' EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }
n=0
commit() { # each commit a minute after the last, so releases built from them carry different file times
  n=$((n + 1))
  GIT_COMMITTER_DATE="$((1700000000 + n * 60)) +0000" GIT_AUTHOR_DATE="$((1700000000 + n * 60)) +0000" \
    git -C "$T/src" -c user.name=t -c user.email=t@t.invalid "$@"
}

# a throwaway "remote": the current tree committed on a main branch
mkdir -p "$T/src"
(cd "$ROOT" && tar --exclude=.git -cf - .) | tar -xf - -C "$T/src"
git -C "$T/src" init -q -b main
commit add -A
commit commit -qm snapshot

# The tests are a normal user even where they run as root (in a container); one test below is root on purpose.
export CAGE_TEST_EUID=1000

# --- from git ---------------------------------------------------------------------------------------------------
export HOME="$T/home" CAGE_REPO="$T/src" CAGE_REF=main CAGE_NO_START=1 PATH="/usr/local/bin:/usr/bin:/bin" SHELL=/bin/bash
mkdir -p "$HOME"
bash "$ROOT/install.sh" 2>"$T/err" || fail "install failed: $(cat "$T/err")"
[ -x "$HOME/cage/cage" ] || fail "cage not cloned into ~/cage"
[ "$(readlink -f "$HOME/.local/bin/cage")" = "$HOME/cage/cage" ] || fail "cage command not linked"
[ "$(grep -c 'added by the cage installer' "$HOME/.bashrc")" = 1 ] || fail "PATH line missing from .bashrc"
[ "$(grep -c 'added by the cage installer' "$HOME/.profile")" = 1 ] || fail "PATH line missing from .profile (login shells)"
"$HOME/.local/bin/cage" help >/dev/null || fail "the cage command doesn't run"
grep -qx "Exec=$HOME/.local/bin/cage ui" "$HOME/.local/share/applications/cage.desktop" || fail "no app menu entry"
ls -d "$HOME"/cage.* "$HOME"/cage/.update.* >/dev/null 2>&1 && fail "left temporary folders behind: $(ls -a "$HOME")"
ok "fresh install from git: clones to ~/cage, links ~/.local/bin/cage, puts it on PATH and in the app menu"

echo "# newer" >> "$T/src/README.md"
commit commit -qam newer
bash "$ROOT/install.sh" 2>"$T/err" || fail "re-run failed: $(cat "$T/err")"
grep -q 'updated' "$T/err" || fail "re-run did not update: $(cat "$T/err")"
tail -1 "$HOME/cage/README.md" | grep -q '# newer' || fail "re-run did not fetch the new commit"
[ "$(grep -c 'added by the cage installer' "$HOME/.bashrc")" = 1 ] || fail "PATH line added twice"
ok "re-running updates cage and doesn't duplicate the PATH line"

mv "$HOME/cage" "$T/kept"
mkdir -p "$HOME/cage" && touch "$HOME/cage/notes.txt"
if bash "$ROOT/install.sh" 2>"$T/err"; then fail "overwrote a folder that isn't cage"; fi
grep -q "isn't a cage checkout" "$T/err" || fail "unclear error: $(cat "$T/err")"
rm -rf "$HOME/cage" && mv "$T/kept" "$HOME/cage"
ok "refuses to touch an existing folder that isn't cage"

# --- from releases ----------------------------------------------------------------------------------------------
# A stand-in for GitHub: /releases/latest redirects to /releases/tag/<newest>, and the files of each release are
# under /releases/download/<tag>/.
mkdir -p "$T/www/releases/download"
cat > "$T/serve.py" <<'PY'
import http.server, os, sys
root = sys.argv[1]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def log_message(self, *a): pass
    def do_HEAD(self): self.route() or super().do_HEAD()
    def do_GET(self): self.route() or super().do_GET()
    def route(self):
        if self.path != "/releases/latest": return False
        latest = os.path.join(root, "latest")
        if not os.path.exists(latest):
            self.send_error(404); return True
        self.send_response(302)
        self.send_header("Location", f"http://{self.headers['Host']}/releases/tag/{open(latest).read().strip()}")
        self.end_headers(); return True
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(os.path.join(root, "port"), "w").write(str(s.server_address[1]))
s.serve_forever()
PY
python3 "$T/serve.py" "$T/www" & SERVER=$!
for _ in $(seq 50); do [ -s "$T/www/port" ] && break; sleep 0.1; done
[ -s "$T/www/port" ] || fail "the stand-in release server didn't start"
CAGE_RELEASES="http://127.0.0.1:$(cat "$T/www/port")/releases"
# where nothing answers: a port that was free a moment ago
DEAD="http://127.0.0.1:$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')/releases"
export CAGE_RELEASES CAGE_HOME="$T/cage-home"
release() { # release <tag>: build the source tree as release <tag> and make it the latest
  "$T/src/scripts/build-release.sh" "$1" "$T/www/releases/download/$1" >/dev/null
  echo "$1" > "$T/www/latest"
}
version() { cat "$HOME/cage/VERSION" 2>/dev/null || echo "(none)"; }
mtime() { stat -c %Y "$HOME/cage/host/ui/server.py"; }

unset CAGE_REF
if bash "$ROOT/install.sh" 2>"$T/err"; then :; else fail "fallback install failed: $(cat "$T/err")"; fi
grep -q 'no cage release found' "$T/err" || fail "no warning about installing from git: $(cat "$T/err")"
[ -d "$HOME/cage/.git" ] || fail "with no release, it should stay on git"
ok "with no release yet, installs the development version from git (and says so)"

release v9.9.8
bash "$ROOT/install.sh" 2>"$T/err" || fail "release install failed: $(cat "$T/err")"
grep -q 'installed cage v9.9.8 (checksum verified)' "$T/err" || fail "release not installed: $(cat "$T/err")"
[ "$(version)" = v9.9.8 ] && [ ! -e "$HOME/cage/.git" ] || fail "$HOME/cage isn't release v9.9.8"
[ "$("$HOME/.local/bin/cage" --version)" = "cage v9.9.8" ] || fail "cage --version: $("$HOME/.local/bin/cage" --version)"
ok "installs the latest release, checked against its SHA256SUMS (a git install becomes a release)"

bash "$ROOT/install.sh" 2>"$T/err" || fail "re-run failed: $(cat "$T/err")"
grep -q 'already the latest' "$T/err" || fail "re-run downloaded again: $(cat "$T/err")"
ok "re-running with the latest release already installed changes nothing"

inode="$(stat -c %i "$HOME/cage/guest")" before="$(mtime)"
echo "# from v9.9.9" >> "$T/src/README.md"
commit rm -q cage.env.example
commit commit -qam v9.9.9
release v9.9.9
bash "$ROOT/install.sh" 2>"$T/err" || fail "update failed: $(cat "$T/err")"
[ "$(version)" = v9.9.9 ] || fail "not updated to v9.9.9: $(cat "$T/err")"
tail -1 "$HOME/cage/README.md" | grep -q 'from v9.9.9' || fail "new files not in place"
[ ! -e "$HOME/cage/cage.env.example" ] || fail "a file the new release dropped is still there"
[ "$(stat -c %i "$HOME/cage/guest")" = "$inode" ] || fail "guest/ was replaced, not updated in place (running VMs mount it)"
ls -d "$HOME"/cage/.update.* >/dev/null 2>&1 && fail "the unpacked release was left in ~/cage"
ok "updates to a newer release in place: same folders, new files, dropped files gone"
[ "$(mtime)" -gt "$before" ] || fail "server.py has the same time in both releases ($before), so a running web app wouldn't restart"
[ "$(mtime)" = "$(git -C "$T/src" log -1 --format=%ct)" ] || fail "server.py isn't dated by its release's commit"
ok "files in a release are dated by its commit, so the running web app sees the update and restarts"

"$T/src/scripts/build-release.sh" v9.9.7 "$T/b1" >/dev/null
(umask 077; "$T/src/scripts/build-release.sh" v9.9.7 "$T/b2" >/dev/null)
cmp -s "$T/b1/SHA256SUMS" "$T/b2/SHA256SUMS" || fail "the release depends on who builds it: $(diff "$T/b1/SHA256SUMS" "$T/b2/SHA256SUMS")"
modes="$(tar -tvzf "$T/b1/cage-v9.9.7.tar.gz" | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
[ "$modes" = "-rw-r--r-- -rwxr-xr-x drwxr-xr-x " ] || fail "odd file modes in the release: $modes"
ok "a release is the same bytes whoever builds it (any umask), with plain file modes"

echo "# v9.9.10" >> "$T/src/README.md"
commit commit -qam v9.9.10
release v9.9.10
CAGE_MSB=true "$HOME/.local/bin/cage" update 2>"$T/err" || true
grep -q 'installed cage v9.9.10' "$T/err" || fail "cage update didn't install the new release: $(cat "$T/err")"
[ "$("$HOME/.local/bin/cage" --version)" = "cage v9.9.10" ] || fail "cage update: still $("$HOME/.local/bin/cage" --version)"
ok "cage update installs the latest release first"

echo "# v9.9.11" >> "$T/src/README.md"
commit commit -qam v9.9.11
release v9.9.11
printf 'tampered' >> "$T/www/releases/download/v9.9.11/cage-v9.9.11.tar.gz"
if bash "$ROOT/install.sh" 2>"$T/err"; then fail "installed a download that doesn't match its checksum"; fi
grep -q "the download was incomplete or changed (it doesn't match its checksum); try again (nothing was installed)" "$T/err" || fail "unclear error: $(cat "$T/err")"
[ "$(version)" = v9.9.10 ] || fail "a refused download changed the install"
CAGE_MSB=true "$HOME/.local/bin/cage" update 2>"$T/err" || true
grep -q "couldn't update cage itself (still v9.9.10)" "$T/err" || fail "cage update hid the refusal: $(cat "$T/err")"
ok "refuses a download that doesn't match the release's checksum, and leaves cage as it was"

# --- when things go wrong: nothing is lost, nothing is half-done -----------------------------------------------
if CAGE_RELEASES="$DEAD" bash "$ROOT/install.sh" 2>"$T/err"; then fail "installed without reaching the releases"; else rc=$?; fi
[ "$rc" = 3 ] || fail "exit code $rc, not 3 (unreachable): $(cat "$T/err")"
[ "$(version)" = v9.9.10 ] && [ ! -e "$HOME/cage/.git" ] || fail "with the releases unreachable, the release install became a git checkout"
mv "$T/www/latest" "$T/latest.off"   # no release at all (a 404), with git working
if bash "$ROOT/install.sh" 2>"$T/err"; then fail "a 404 for the latest release went on"; fi
grep -q 'no cage release found .* so cage v9.9.10 stays as it is' "$T/err" || fail "404 with a release installed: $(cat "$T/err")"
[ "$(version)" = v9.9.10 ] && [ ! -e "$HOME/cage/.git" ] || fail "a release install became a git checkout"
mv "$T/latest.off" "$T/www/latest"
ok "an installed release never turns into a git checkout of main: not with GitHub down, not with no release found"

echo "# v9.9.12" >> "$T/src/README.md"
commit commit -qam v9.9.12
release v9.9.12
mkdir -p "$T/fulldisk"
cat > "$T/fulldisk/tar" <<EOF
#!/bin/sh
# tar, on a disk that fills up halfway through unpacking a release
case " \$* " in *" --strip-components=1 "*) "$(command -v tar)" "\$@" --exclude='cage/host'; echo "tar: cage/host/ui/server.py: Cannot write: No space left on device" >&2; exit 2 ;; esac
exec "$(command -v tar)" "\$@"
EOF
chmod +x "$T/fulldisk/tar"
if PATH="$T/fulldisk:$PATH" bash "$ROOT/install.sh" 2>"$T/err"; then fail "reported success after a failed unpack"; fi
grep -q "couldn't unpack cage v9.9.12" "$T/err" && ! grep -q 'installed cage' "$T/err" || fail "failed unpack: $(cat "$T/err")"
[ "$(version)" = v9.9.10 ] && tail -1 "$HOME/cage/README.md" | grep -q 'v9.9.10' || fail "a failed unpack changed the install"
ls -d "$HOME"/cage/.update.* >/dev/null 2>&1 && fail "a failed unpack left its files in ~/cage"
bash "$ROOT/install.sh" 2>"$T/err" || fail "the next try failed: $(cat "$T/err")"
[ "$(version)" = v9.9.12 ] || fail "the next try didn't install v9.9.12"
ok "a disk that fills up halfway: an error, cage as it was, and the next try works"

if CAGE_TEST_EUID=0 bash "$ROOT/install.sh" 2>"$T/err"; then fail "installed as root"; fi
grep -q 'install cage as your normal user, not with sudo or as root' "$T/err" || fail "root: $(cat "$T/err")"
CAGE_TEST_EUID=0 CAGE_ALLOW_ROOT=1 bash "$ROOT/install.sh" 2>"$T/err" || fail "CAGE_ALLOW_ROOT=1: $(cat "$T/err")"
ok "as root it stops with a plain message (CAGE_ALLOW_ROOT=1 goes ahead)"

echo v9.9.9 > "$T/www/latest"   # the latest release is older than what's installed
bash "$ROOT/install.sh" 2>"$T/err" || fail "an older latest release is an error: $(cat "$T/err")"
grep -q 'this cage (v9.9.12) is newer than the latest release (v9.9.9), so it stays as it is' "$T/err" || fail "older latest: $(cat "$T/err")"
[ "$(version)" = v9.9.12 ] || fail "moved to an older release on its own"
echo v9.9.12 > "$T/www/latest"
ok "never moves to an older release on its own"

# --- your shell finds cage: zsh even without a .zshrc yet, fish, and login shells -------------------------------
mkdir -p "$T/fish"; printf '#!/bin/sh\n' > "$T/fish/fish"; chmod +x "$T/fish/fish"
rm -f "$HOME/.zshrc"
SHELL=/usr/bin/zsh PATH="$T/fish:$PATH" bash "$ROOT/install.sh" 2>"$T/err" || fail "re-run: $(cat "$T/err")"
# shellcheck disable=SC2016  # the line as it is in the file
[ "$(grep -c 'export PATH="$HOME/.local/bin:$PATH"   # added by the cage installer' "$HOME/.zshrc")" = 1 ] || fail "no PATH line in a new .zshrc"
# shellcheck disable=SC2016
grep -qx 'contains -- $HOME/.local/bin $PATH; or set -gx PATH $HOME/.local/bin $PATH   # added by the cage installer' \
  "$HOME/.config/fish/conf.d/cage.fish" || fail "no PATH line for fish"
SHELL=/usr/bin/zsh PATH="$T/fish:$PATH" bash "$ROOT/install.sh" 2>/dev/null
for f in .bashrc .zshrc .profile .config/fish/conf.d/cage.fish; do
  [ "$(grep -c 'added by the cage installer' "$HOME/$f")" = 1 ] || fail "$f: the PATH line twice"
done
ok "PATH: a new .zshrc when zsh is your shell, fish's conf.d when fish is installed, once each"

echo "all $pass installer tests passed"
