#!/usr/bin/env bash
# Tests install.sh against local copies of this repo: from git (fresh install, the `cage` command, PATH setup, re-run
# update), and from releases on a local stand-in for GitHub Releases (checksums, in-place updates, a tampered download).
# Then everything that can go wrong on the way: no network, a server that stops answering, GitHub down while git works,
# a failed git download, a disk that fills up halfway, an update that stops halfway, one left by an installer that was
# killed, a release that turns a file into a folder, running as root, an older release, a preview release; plus going
# back (a pinned version, cage rollback) and cage uninstall (it never deletes a backup, or more than cage's own).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
SERVER="" STALL="" HELPER=""
trap '[ -z "$SERVER$STALL$HELPER" ] || kill $SERVER $STALL $HELPER 2>/dev/null; rm -rf "$T"' EXIT
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

# Stand-ins, first on PATH: the internet as `cage update` checks it (test/fake-curl.sh; the release server below is
# reached for real), and the OS tools `cage uninstall` turns start-at-login off with, so no real login item is touched.
mkdir -p "$T/stub"
ln -s "$ROOT/test/fake-curl.sh" "$T/stub/curl"
for tool in systemctl launchctl; do printf '#!/bin/sh\nexit 0\n' > "$T/stub/$tool"; chmod +x "$T/stub/$tool"; done
cat > "$T/stub/msb" <<'EOF'
#!/bin/sh
[ "$1" = --version ] && exit 0
echo "$*" >> "$MSB_LOG"
exit 0
EOF
chmod +x "$T/stub/msb"
REAL_CURL="$(command -v curl)"
# The tests are a normal user even where they run as root (in a container); one test below is root on purpose.
export REAL_CURL MSB_LOG="$T/msb.log" CAGE_TEST_EUID=1000

# --- from git ---------------------------------------------------------------------------------------------------
export HOME="$T/home" CAGE_REPO="$T/src" CAGE_REF=main CAGE_NO_START=1 PATH="$T/stub:/usr/local/bin:/usr/bin:/bin" SHELL=/bin/bash
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
# with a config, an update that went ahead would rebuild the agents (these releases have no cage.env.example)
mkdir -p "$CAGE_HOME" && printf 'CAGE_AGENTS="claude codex"\n' > "$CAGE_HOME/cage.env"
: > "$MSB_LOG"
if CAGE_RELEASES="$DEAD" CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" update 2>"$T/err"; then fail "cage update succeeded without GitHub"; fi
grep -q "can't reach 127.0.0.1:.*check your internet connection or company proxy, then try again. Nothing was changed." "$T/err" || fail "offline update: $(cat "$T/err")"
grep -q 'your agents keep running as they are' "$T/err" && ! grep -q 'updating the agents anyway' "$T/err" || fail "offline update went on: $(cat "$T/err")"
[ "$(version)" = v9.9.10 ] && [ "$("$HOME/.local/bin/cage" --version)" = "cage v9.9.10" ] || fail "an offline update changed cage"
[ ! -s "$MSB_LOG" ] || fail "an offline update rebuilt the agents: $(cat "$MSB_LOG")"
ok "cage update with GitHub unreachable keeps ~/cage as it was and leaves the agents running"

if CAGE_RELEASES="$DEAD" bash "$ROOT/install.sh" 2>"$T/err"; then fail "installed without reaching the releases"; else rc=$?; fi
[ "$rc" = 3 ] || fail "exit code $rc, not 3 (unreachable): $(cat "$T/err")"
[ "$(version)" = v9.9.10 ] && [ ! -e "$HOME/cage/.git" ] || fail "with the releases unreachable, the release install became a git checkout"
mv "$T/www/latest" "$T/latest.off"   # no release at all (a 404), with git working
if bash "$ROOT/install.sh" 2>"$T/err"; then fail "a 404 for the latest release went on"; fi
grep -q 'no cage release found .* so cage v9.9.10 stays as it is' "$T/err" || fail "404 with a release installed: $(cat "$T/err")"
[ "$(version)" = v9.9.10 ] && [ ! -e "$HOME/cage/.git" ] || fail "a release install became a git checkout"
mv "$T/latest.off" "$T/www/latest"
ok "an installed release never turns into a git checkout of main: not with GitHub down, not with no release found"

CAGE_REF=main CAGE_REPO="$T/missing" bash "$ROOT/install.sh" 2>"$T/err" && fail "a failed git download went on"
grep -q "couldn't download cage (main) from $T/missing; nothing was changed" "$T/err" || fail "failed clone: $(cat "$T/err")"
[ "$(version)" = v9.9.10 ] && [ "$(readlink -f "$HOME/.local/bin/cage")" = "$HOME/cage/cage" ] || fail "a failed git download changed cage"
ls -d "$HOME"/cage.* >/dev/null 2>&1 && fail "a failed git download left: $(ls -d "$HOME"/cage.*)"
ok "a failed git download (CAGE_REF) leaves the installed release as it was, and nothing next to it"

# a server that takes the connection and then never answers (a stalled proxy): the installer gives up, it doesn't hang
python3 -c 'import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(16)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
held = []
while True: held.append(s.accept()[0])' "$T/stall.port" & STALL=$!
for _ in $(seq 50); do [ -s "$T/stall.port" ] && break; sleep 0.1; done
start=$SECONDS rc=0
CAGE_TEST_TIMEOUT=1 CAGE_RELEASES="http://127.0.0.1:$(cat "$T/stall.port")/releases" timeout 60 bash "$ROOT/install.sh" 2>"$T/err" || rc=$?
[ "$rc" = 3 ] && [ $((SECONDS - start)) -lt 30 ] || fail "a stalled server: exit $rc after $((SECONDS - start)) s: $(cat "$T/err")"
[ "$(version)" = v9.9.10 ] || fail "a stalled server changed cage"
kill "$STALL" 2>/dev/null; STALL=""
CAGE_RELEASES="http://releases.example.com/cage" bash "$ROOT/install.sh" 2>"$T/err" && fail "downloaded over plain http"
grep -q "CAGE_RELEASES has to be an https:// address" "$T/err" || fail "plain http: $(cat "$T/err")"
ok "gives up on a server that stops answering (exit 3, nothing changed), and downloads over https only"

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

echo "# v9.9.13" >> "$T/src/README.md"
commit commit -qam v9.9.13
release v9.9.13
mkdir -p "$T/mvshim"
cat > "$T/mvshim/mv" <<EOF
#!/bin/sh
# mv, failing (MV_FAIL) or quietly doing nothing (MV_SKIP) for one file going into ~/cage, as a dying disk might
for a; do last="\$a"; done
case "\$last" in
  */cage/"\${MV_FAIL:-//}"|*/cage/./"\${MV_FAIL:-//}") echo "mv: cannot move to '\$last': Input/output error" >&2; exit 1 ;;
  */cage/"\${MV_SKIP:-//}"|*/cage/./"\${MV_SKIP:-//}") exit 0 ;;
esac
exec "$(command -v mv)" "\$@"
EOF
chmod +x "$T/mvshim/mv"
cat > "$T/mvshim/rm" <<EOF
#!/bin/sh
# rm, failing for one file in ~/cage (RM_FAIL)
for a; do last="\$a"; done
case "\$last" in */cage/"\${RM_FAIL:-//}") echo "rm: cannot remove '\$last': Input/output error" >&2; exit 1 ;; esac
exec "$(command -v rm)" "\$@"
EOF
chmod +x "$T/mvshim/rm"
rc=0; MV_FAIL=README.md PATH="$T/mvshim:$PATH" bash "$ROOT/install.sh" 2>"$T/err" || rc=$?
[ "$rc" = 4 ] && grep -q "couldn't replace $HOME/cage/README.md; run this again to finish the update" "$T/err" || fail "stopped halfway: exit $rc: $(cat "$T/err")"
[ "$(version)" = v9.9.12 ] || fail "an update that stopped halfway says it's the new version"
rc=0; MV_SKIP=VERSION PATH="$T/mvshim:$PATH" bash "$ROOT/install.sh" 2>"$T/err" || rc=$?
[ "$rc" = 4 ] && grep -q "cage v9.9.13 didn't end up in $HOME/cage; run this again" "$T/err" && ! grep -q 'installed cage' "$T/err" ||
  fail "VERSION not replaced: exit $rc: $(cat "$T/err")"
: > "$MSB_LOG"
if MV_FAIL=README.md PATH="$T/mvshim:$PATH" CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" update 2>"$T/err"; then fail "cage update went on after stopping halfway"; fi
grep -q 'to finish the update: cage update' "$T/err" && grep -q 'your agents keep running as they are' "$T/err" || fail "cage update, halfway: $(cat "$T/err")"
grep -q 'updating the agents anyway' "$T/err" && fail "cage update rebuilt the agents from a half-updated cage: $(cat "$T/err")"
[ ! -s "$MSB_LOG" ] || fail "cage update touched the agents after stopping halfway: $(cat "$MSB_LOG")"
bash "$ROOT/install.sh" 2>"$T/err" || fail "the next try: $(cat "$T/err")"
[ "$(version)" = v9.9.13 ] && tail -1 "$HOME/cage/README.md" | grep -q 'v9.9.13' || fail "the next try didn't finish the update"
ok "an update that stops halfway exits with 4 and still says the old version; cage update stops too; the next try finishes it"

dead="$(sh -c 'echo $$')"   # a process that has ended
mkdir -p "$HOME/cage/.update.$dead/guest" "$HOME/cage/.update.$$" "$HOME/cage.new.$dead" "$HOME/cage.old.$dead"
bash "$ROOT/install.sh" 2>"$T/err" || fail "with leftovers: $(cat "$T/err")"
[ ! -e "$HOME/cage/.update.$dead" ] && [ ! -e "$HOME/cage.new.$dead" ] && [ ! -e "$HOME/cage.old.$dead" ] ||
  fail "left by a killed installer, still there: $(ls -a "$HOME" "$HOME/cage")"
[ -d "$HOME/cage/.update.$$" ] || fail "removed the folder of an installer that's still running"
rmdir "$HOME/cage/.update.$$"
mv "$HOME/cage" "$HOME/cage.old.$dead"   # killed between moving the old copy aside and putting the new one in
bash "$ROOT/install.sh" 2>"$T/err" || fail "with only the old copy: $(cat "$T/err")"
[ "$(version)" = v9.9.13 ] && [ ! -e "$HOME/cage.old.$dead" ] && grep -q 'already the latest' "$T/err" || fail "the old copy wasn't put back: $(cat "$T/err")"
ok "what a killed installer left goes (an old copy goes back in place); a running installer's folder stays"

# a release that turns a file into a folder, then back, and drops a folder: the tree is the release's, every time
same_as_release() { # same_as_release <tag>: ~/cage holds exactly what the release's tarball does
  diff <(cd "$HOME/cage" && find . -mindepth 1 | sed 's|^\./||' | LC_ALL=C sort) \
       <(tar -tzf "$T/www/releases/download/$1/cage-$1.tar.gz" | sed 's|^cage/||; s|/$||' | grep . | LC_ALL=C sort)
}
echo "a file" > "$T/src/docs/extra"; mkdir -p "$T/src/docs/gone" && echo x > "$T/src/docs/gone/x.md"
commit add -A; commit commit -qm v9.9.14
release v9.9.14
bash "$ROOT/install.sh" 2>"$T/err" || fail "v9.9.14: $(cat "$T/err")"
commit rm -q docs/extra; mkdir -p "$T/src/docs/extra"; echo "in a folder" > "$T/src/docs/extra/a.md"; commit rm -rq docs/gone
commit add -A; commit commit -qm v9.9.15
release v9.9.15
rc=0; RM_FAIL=docs/gone/x.md PATH="$T/mvshim:$PATH" bash "$ROOT/install.sh" 2>"$T/err" || rc=$?
[ "$rc" = 4 ] && [ "$(version)" = v9.9.14 ] || fail "couldn't remove a dropped file: exit $rc, $(version): $(cat "$T/err")"
bash "$ROOT/install.sh" 2>"$T/err" || fail "a file became a folder: $(cat "$T/err")"
[ "$(version)" = v9.9.15 ] && [ -f "$HOME/cage/docs/extra/a.md" ] || fail "a file became a folder: $(cat "$T/err")"
same_as_release v9.9.15 || fail "after a file became a folder, ~/cage isn't the release"
commit rm -rq docs/extra; echo "a file again" > "$T/src/docs/extra"
commit add -A; commit commit -qm v9.9.16
release v9.9.16
bash "$ROOT/install.sh" 2>"$T/err" || fail "a folder became a file: $(cat "$T/err")"
[ "$(version)" = v9.9.16 ] && [ "$(cat "$HOME/cage/docs/extra")" = "a file again" ] || fail "a folder became a file: $(cat "$T/err")"
same_as_release v9.9.16 || fail "after a folder became a file, ~/cage isn't the release"
bash "$ROOT/install.sh" 2>"$T/err" && grep -q 'already the latest' "$T/err" || fail "after a folder became a file: $(cat "$T/err")"
ok "a release that turns a file into a folder (or back) or drops a folder: ~/cage is exactly the new release"

# a download that checks out (its checksum) but holds another version
mkdir -p "$T/odd" && tar -xzf "$T/www/releases/download/v9.9.16/cage-v9.9.16.tar.gz" -C "$T/odd"
echo v9.9.15 > "$T/odd/cage/VERSION"
mkdir -p "$T/www/releases/download/v9.9.17"
tar -czf "$T/www/releases/download/v9.9.17/cage-v9.9.17.tar.gz" -C "$T/odd" cage
(cd "$T/www/releases/download/v9.9.17" && sha256sum cage-v9.9.17.tar.gz > SHA256SUMS)
echo v9.9.17 > "$T/www/latest"
bash "$ROOT/install.sh" 2>"$T/err" && fail "installed a release that says it's another version"
grep -q "the download doesn't contain cage v9.9.17; nothing was changed" "$T/err" && [ "$(version)" = v9.9.16 ] || fail "odd version: $(cat "$T/err")"
echo v9.9.16 > "$T/www/latest"
ok "refuses a download whose VERSION isn't the release it was asked for"

if CAGE_TEST_EUID=0 bash "$ROOT/install.sh" 2>"$T/err"; then fail "installed as root"; fi
grep -q 'install cage as your normal user, not with sudo or as root' "$T/err" || fail "root: $(cat "$T/err")"
CAGE_TEST_EUID=0 CAGE_ALLOW_ROOT=1 bash "$ROOT/install.sh" 2>"$T/err" || fail "CAGE_ALLOW_ROOT=1: $(cat "$T/err")"
ok "as root it stops with a plain message (CAGE_ALLOW_ROOT=1 goes ahead)"

echo v9.9.9 > "$T/www/latest"   # the latest release is older than what's installed
bash "$ROOT/install.sh" 2>"$T/err" || fail "an older latest release is an error: $(cat "$T/err")"
grep -q 'this cage (v9.9.16) is newer than the latest release (v9.9.9), so it stays as it is' "$T/err" || fail "older latest: $(cat "$T/err")"
[ "$(version)" = v9.9.16 ] || fail "moved to an older release on its own"
ok "never moves to an older release on its own"

# a preview (v9.9.18-rc.1) comes before its release (v9.9.18), as in semver; plain sort -V says the opposite
echo "# v9.9.18" >> "$T/src/README.md"
commit commit -qam v9.9.18
release v9.9.18-rc.1
release v9.9.18
echo v9.9.18-rc.1 > "$T/www/latest"
CAGE_VERSION=v9.9.18-rc.1 bash "$ROOT/install.sh" 2>"$T/err" && [ "$(version)" = v9.9.18-rc.1 ] || fail "a preview: $(cat "$T/err")"
echo v9.9.18 > "$T/www/latest"
bash "$ROOT/install.sh" 2>"$T/err" && [ "$(version)" = v9.9.18 ] || fail "the release after its preview wasn't installed: $(cat "$T/err")"
echo v9.9.18-rc.1 > "$T/www/latest"
bash "$ROOT/install.sh" 2>"$T/err" || fail "$(cat "$T/err")"
grep -q 'this cage (v9.9.18) is newer than the latest release (v9.9.18-rc.1)' "$T/err" && [ "$(version)" = v9.9.18 ] || fail "went back to a preview: $(cat "$T/err")"
echo v9.9.18 > "$T/www/latest"
ok "a release replaces its preview (v9.9.18-rc.1, then v9.9.18), and never the other way round"

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

# --- a version of your choice, and going back ---------------------------------------------------------------------
: > "$MSB_LOG"
if CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" update --to v9.9.9 nosuch 2>"$T/err"; then fail "update with an unknown agent"; fi
grep -q 'unknown agent "nosuch"' "$T/err" && [ "$(version)" = v9.9.18 ] && [ ! -s "$MSB_LOG" ] || fail "an unknown agent: $(cat "$T/err")"
CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" update claude --to v9.9.9 2>"$T/err" || fail "update claude --to: $(cat "$T/err")"
grep -q 'installed cage v9.9.9 (checksum verified)' "$T/err" && [ "$(version)" = v9.9.9 ] || fail "update claude --to v9.9.9: $(cat "$T/err")"
grep -q 'cage-claude' "$MSB_LOG" && ! grep -q 'cage-codex' "$MSB_LOG" || fail "update claude --to didn't go on to (only) claude: $(cat "$MSB_LOG")"
[ "$(ls "$CAGE_HOME/releases" | tr '\n' ' ')" = "v9.9.18 v9.9.9 " ] || fail "kept releases: $(ls "$CAGE_HOME/releases")"
[ -f "$CAGE_HOME/releases/v9.9.9/SHA256SUMS" ] || fail "a kept release without its checksums"
: > "$MSB_LOG"
CAGE_RELEASES="$DEAD" CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" rollback 2>"$T/err" || fail "rollback: $(cat "$T/err")"
[ "$(version)" = v9.9.18 ] && [ "$("$HOME/.local/bin/cage" --version)" = "cage v9.9.18" ] || fail "rollback didn't go back to v9.9.18: $(cat "$T/err")"
grep -q 'installed cage v9.9.18 (checksum verified)' "$T/err" || fail "rollback: $(cat "$T/err")"
grep -q 'cage-claude' "$MSB_LOG" || fail "rollback didn't wake the agents"
printf 'tampered' >> "$CAGE_HOME/releases/v9.9.9/cage-v9.9.9.tar.gz"
if CAGE_RELEASES="$DEAD" CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" rollback 2>"$T/err"; then fail "rolled back to a changed copy"; fi
grep -q "doesn't match its checksum" "$T/err" && [ "$(version)" = v9.9.18 ] || fail "a changed kept copy: $(cat "$T/err")"
mv "$CAGE_HOME/releases" "$T/releases.kept"
if "$HOME/.local/bin/cage" rollback 2>"$T/err"; then fail "rolled back with nothing kept"; fi
grep -q "there's no earlier release on this computer" "$T/err" && grep -q 'to download one: cage update --to' "$T/err" || fail "nothing kept: $(cat "$T/err")"
mv "$T/releases.kept" "$CAGE_HOME/releases"
ok "a release of your choice (cage update [agents] --to, older ones too; unknown agents stop it first), and cage rollback with no network; the last two are kept"

# --- uninstall ---------------------------------------------------------------------------------------------------
mkdir -p "$HOME/cage-backups" && echo backup > "$HOME/cage-backups/cage-2026-01-01-000000.cagebackup"
echo 'alias ll="ls -l"' >> "$HOME/.bashrc"
if printf 'y\nn\nkeep\n' | CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" uninstall --everything 2>"$T/err"; then fail "--everything without typing delete"; fi
[ -x "$HOME/cage/cage" ] && [ -d "$CAGE_HOME" ] || fail "uninstall removed something without the typed confirmation"
# the backup it offers first doesn't work out: nothing is removed
: > "$MSB_LOG"
if printf 'y\ny\n' | CAGE_BACKUP_PASSPHRASE=short CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" uninstall 2>"$T/err"; then fail "uninstall went on without the backup"; fi
grep -q 'no backup was made, so nothing was removed' "$T/err" && [ -x "$HOME/cage/cage" ] && [ -f "$CAGE_HOME/cage.env" ] && [ ! -s "$MSB_LOG" ] ||
  fail "a backup that didn't work out: $(cat "$T/err")"
# backups where cage.env says (CAGE_BACKUP_DIR): inside ~/cage, or inside cage's settings with --everything
: > "$MSB_LOG"
mkdir -p "$HOME/cage/backups" && echo backup > "$HOME/cage/backups/mine.cagebackup"
echo "CAGE_BACKUP_DIR=\"$HOME/cage/backups\"" >> "$CAGE_HOME/cage.env"
if CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" uninstall --yes 2>"$T/err"; then fail "uninstall deleted the backups in ~/cage"; fi
grep -q "your backups are in $HOME/cage/backups, inside cage's own folder" "$T/err" && [ -f "$HOME/cage/backups/mine.cagebackup" ] ||
  fail "backups in ~/cage (cage.env): $(cat "$T/err")"
rm -rf "$HOME/cage/backups"
sed -i '/^CAGE_BACKUP_DIR=/d' "$CAGE_HOME/cage.env"
mkdir -p "$CAGE_HOME/backups" && echo backup > "$CAGE_HOME/backups/mine.cagebackup"
echo "CAGE_BACKUP_DIR=\"$CAGE_HOME/backups/\"" >> "$CAGE_HOME/cage.env"
if CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" uninstall --yes --everything 2>"$T/err"; then fail "uninstall --everything deleted the backups"; fi
grep -q "inside $CAGE_HOME; move them elsewhere first (nothing was removed)" "$T/err" && [ -f "$CAGE_HOME/backups/mine.cagebackup" ] ||
  fail "backups in cage's settings (cage.env): $(cat "$T/err")"
sed -i '/^CAGE_BACKUP_DIR=/d' "$CAGE_HOME/cage.env"
ln -s "$CAGE_HOME/backups" "$HOME/my-backups"   # the same folder, by a link from outside
echo "CAGE_BACKUP_DIR=\"$HOME/my-backups\"" >> "$CAGE_HOME/cage.env"
if CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" uninstall --yes --everything 2>"$T/err"; then fail "uninstall --everything deleted the backups behind a link"; fi
grep -q "inside $CAGE_HOME; move them elsewhere first (nothing was removed)" "$T/err" && [ -f "$CAGE_HOME/backups/mine.cagebackup" ] ||
  fail "backups in cage's settings, through a link: $(cat "$T/err")"
rm -rf "$CAGE_HOME/backups" "$HOME/my-backups"
sed -i '/^CAGE_BACKUP_DIR=/d' "$CAGE_HOME/cage.env"
# cage's settings folder set to your home folder (a trailing slash once got past the check)
if CAGE_HOME="$HOME/" CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" uninstall --yes --everything 2>"$T/err"; then fail "uninstall --everything with CAGE_HOME=~/"; fi
grep -q "won't delete $HOME/: your home folder is in it (nothing was removed)" "$T/err" && [ -x "$HOME/cage/cage" ] && [ -f "$HOME/.bashrc" ] ||
  fail "CAGE_HOME=~/: $(cat "$T/err")"
[ ! -s "$MSB_LOG" ] || fail "a refused uninstall touched the VMs: $(cat "$MSB_LOG")"
ok "cage uninstall never deletes backups (where cage.env puts them too, through a link too) or your home folder (however it's spelled)"

: > "$MSB_LOG"
# the background helper (cage _refresh, found by its pid file) stops with cage, not after its folder is gone; so do
# those of your other CAGE_HOMEs, which run from that folder too
mkdir -p "$HOME/other" && cp "$CAGE_HOME/cage.env" "$HOME/other/"
for h in "$CAGE_HOME" "$HOME/other"; do
  CAGE_HOME="$h" CAGE_MSB="$T/stub/msb" nohup "$HOME/cage/cage" _refresh "$h" </dev/null >/dev/null 2>&1 &
done
for _ in $(seq 50); do [ -s "$CAGE_HOME/refresh.pid" ] && [ -s "$HOME/other/refresh.pid" ] && break; sleep 0.1; done
HELPER="$(cat "$CAGE_HOME/refresh.pid" "$HOME/other/refresh.pid" 2>/dev/null | tr '\n' ' ' || true)"
up=0; for p in $HELPER; do if kill -0 "$p" 2>/dev/null; then up=$((up + 1)); fi; done
[ $up = 2 ] || fail "the background helpers didn't start: $HELPER"
CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" uninstall --yes 2>"$T/err" || fail "uninstall: $(cat "$T/err")"
for p in $HELPER; do
  for _ in $(seq 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$p" 2>/dev/null; then fail "a background helper outlived cage uninstall: $(ps -o args= -p "$p")"; fi
done
[ ! -e "$CAGE_HOME/refresh.pid" ] || fail "uninstall left the helper's pid file"
HELPER=""
rm -rf "$HOME/other"
[ ! -e "$HOME/cage" ] && [ ! -e "$HOME/.local/bin/cage" ] && [ ! -e "$HOME/.local/share/applications/cage.desktop" ] || fail "cage is still here"
[ -f "$CAGE_HOME/cage.env" ] || fail "uninstall without --everything deleted the settings"
grep -q '^rm --force cage-claude$' "$MSB_LOG" && ! grep -q 'volume rm' "$MSB_LOG" || fail "VMs and volumes: $(cat "$MSB_LOG")"
grep -q 'added by the cage installer' "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshrc" 2>/dev/null && fail "PATH lines left"
grep -qx 'alias ll="ls -l"' "$HOME/.bashrc" || fail "uninstall took the user's own line from .bashrc"
grep -q "rm -rf $CAGE_HOME, and for each agent: msb volume rm" "$T/err" || fail "how to delete the rest: $(cat "$T/err")"
grep -q 'It also holds your agents.* logins and files, so removing it .* deletes those too' "$T/err" || fail "microsandbox holds what was kept: $(cat "$T/err")"

# volumes msb can't delete (still in use) aren't reported as deleted; a cage command that isn't this cage's stays
cat > "$T/stub/msb-busy" <<'EOF'
#!/bin/sh
[ "$1" = --version ] && exit 0
echo "$*" >> "$MSB_LOG"
case "$*" in "volume rm "*) echo "error: volume is in use" >&2; exit 1 ;; esac
exit 0
EOF
chmod +x "$T/stub/msb-busy"
bash "$ROOT/install.sh" 2>"$T/err" || fail "reinstall: $(cat "$T/err")"
ln -sf "$T/src/cage" "$HOME/.local/bin/cage"   # another cage's command
if CAGE_MSB="$T/stub/msb-busy" "$HOME/cage/cage" uninstall --yes --everything 2>"$T/err"; then fail "uninstall said all went well with volumes left"; fi
grep -q "couldn't delete these, which hold your agents' logins and files: cage-claude-home cage-claude-cache" "$T/err" &&
  grep -q 'run: msb volume rm cage-claude-home' "$T/err" && ! grep -q "deleted your agents' logins and files" "$T/err" ||
  fail "volumes msb couldn't delete: $(cat "$T/err")"
[ "$(readlink "$HOME/.local/bin/cage")" = "$T/src/cage" ] || fail "uninstall removed a cage command that isn't this cage's"
rm -f "$HOME/.local/bin/cage"
mkdir -p "$T/nomsb" && cp "$T/stub/systemctl" "$T/stub/launchctl" "$T/nomsb/"
ln -s "$(command -v bash)" "$T/nomsb/bash"   # bash may live outside /usr/bin and /bin (Homebrew, the bash:3.2 image)
bash "$ROOT/install.sh" 2>"$T/err" || fail "reinstall: $(cat "$T/err")"
mkdir -p "$CAGE_HOME" && printf 'CAGE_AGENTS="claude codex"\n' > "$CAGE_HOME/cage.env"
PATH="$T/nomsb:/usr/bin:/bin" "$HOME/cage/cage" uninstall --yes --everything 2>"$T/err" || fail "uninstall without msb: $(cat "$T/err")"
grep -q "microsandbox wasn't found, so your agents' logins and files weren't checked" "$T/err" && ! grep -q "deleted your agents' logins" "$T/err" ||
  fail "uninstall --everything without msb: $(cat "$T/err")"
ok "uninstall --everything says which agents' files are left when msb can't delete them (or isn't there), and exits 1"

bash "$ROOT/install.sh" 2>"$T/err" || fail "reinstall: $(cat "$T/err")"
mkdir -p "$CAGE_HOME" && printf 'CAGE_AGENTS="claude codex"\n' > "$CAGE_HOME/cage.env"
rm -f "$HOME/.bashrc"
: > "$MSB_LOG"
CAGE_MSB="$T/stub/msb" "$HOME/.local/bin/cage" uninstall --yes --everything 2>"$T/err" || fail "uninstall --everything: $(cat "$T/err")"
grep -q '^volume rm cage-claude-home$' "$MSB_LOG" && grep -q '^volume rm cage-antigravity-cache$' "$MSB_LOG" || fail "volumes: $(cat "$MSB_LOG")"
[ ! -e "$CAGE_HOME" ] || fail "uninstall --everything kept $CAGE_HOME"
left="$(cd "$HOME" && find . \( -type f -o -type l \) ! -path './cage-backups/*' | sort)"
[ -z "$left" ] || fail "uninstall --everything left: $left"
[ -f "$HOME/cage-backups/cage-2026-01-01-000000.cagebackup" ] || fail "uninstall deleted a backup"
grep -q 'microsandbox stays installed' "$T/err" || fail "no word on removing microsandbox: $(cat "$T/err")"
ok "cage uninstall: VMs, helpers, command, PATH lines and ~/cage go; settings and volumes only with --everything; backups stay"

echo "all $pass installer tests passed"
