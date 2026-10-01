#!/usr/bin/env bash
# Tests install.sh against local copies of this repo: from git (fresh install, the `cage` command, PATH setup, re-run
# update), and from releases on a local stand-in for GitHub Releases (checksums, in-place updates, a tampered download).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
SERVER=""
trap '[ -z "$SERVER" ] || kill "$SERVER" 2>/dev/null; rm -rf "$T"' EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }
commit() { git -C "$T/src" -c user.name=t -c user.email=t@t.invalid "$@"; }

# a throwaway "remote": the current tree committed on a main branch
mkdir -p "$T/src"
(cd "$ROOT" && tar --exclude=.git -cf - .) | tar -xf - -C "$T/src"
git -C "$T/src" init -q -b main
commit add -A
commit commit -qm snapshot

# --- from git ---------------------------------------------------------------------------------------------------
export HOME="$T/home" CAGE_REPO="$T/src" CAGE_REF=main CAGE_NO_START=1 PATH="/usr/local/bin:/usr/bin:/bin"
mkdir -p "$HOME"
bash "$ROOT/install.sh" 2>"$T/err" || fail "install failed: $(cat "$T/err")"
[ -x "$HOME/cage/cage" ] || fail "cage not cloned into ~/cage"
[ "$(readlink -f "$HOME/.local/bin/cage")" = "$HOME/cage/cage" ] || fail "cage command not linked"
[ "$(grep -c 'added by the cage installer' "$HOME/.bashrc")" = 1 ] || fail "PATH line missing from .bashrc"
"$HOME/.local/bin/cage" help >/dev/null || fail "the cage command doesn't run"
ok "fresh install from git: clones to ~/cage, links ~/.local/bin/cage, puts it on PATH"

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
export CAGE_RELEASES
release() { # release <tag>: build the source tree as release <tag> and make it the latest
  "$T/src/scripts/build-release.sh" "$1" "$T/www/releases/download/$1" >/dev/null
  echo "$1" > "$T/www/latest"
}

unset CAGE_REF
if bash "$ROOT/install.sh" 2>"$T/err"; then :; else fail "fallback install failed: $(cat "$T/err")"; fi
grep -q 'no cage release found' "$T/err" || fail "no warning about installing from git: $(cat "$T/err")"
[ -d "$HOME/cage/.git" ] || fail "with no release, it should stay on git"
ok "with no release yet, installs the development version from git (and says so)"

release v9.9.8
bash "$ROOT/install.sh" 2>"$T/err" || fail "release install failed: $(cat "$T/err")"
grep -q 'installed cage v9.9.8 (checksum verified)' "$T/err" || fail "release not installed: $(cat "$T/err")"
[ "$(cat "$HOME/cage/VERSION")" = v9.9.8 ] && [ ! -e "$HOME/cage/.git" ] || fail "$HOME/cage isn't release v9.9.8"
[ "$("$HOME/.local/bin/cage" --version)" = "cage v9.9.8" ] || fail "cage --version: $("$HOME/.local/bin/cage" --version)"
ok "installs the latest release, checked against its SHA256SUMS (a git install becomes a release)"

bash "$ROOT/install.sh" 2>"$T/err" || fail "re-run failed: $(cat "$T/err")"
grep -q 'already the latest' "$T/err" || fail "re-run downloaded again: $(cat "$T/err")"
ok "re-running with the latest release already installed changes nothing"

inode="$(stat -c %i "$HOME/cage/guest")"
echo "# from v9.9.9" >> "$T/src/README.md"
commit rm -q cage.env.example
commit commit -qam v9.9.9
release v9.9.9
bash "$ROOT/install.sh" 2>"$T/err" || fail "update failed: $(cat "$T/err")"
[ "$(cat "$HOME/cage/VERSION")" = v9.9.9 ] || fail "not updated to v9.9.9: $(cat "$T/err")"
tail -1 "$HOME/cage/README.md" | grep -q 'from v9.9.9' || fail "new files not in place"
[ ! -e "$HOME/cage/cage.env.example" ] || fail "a file the new release dropped is still there"
[ "$(stat -c %i "$HOME/cage/guest")" = "$inode" ] || fail "guest/ was replaced, not updated in place (running VMs mount it)"
ok "updates to a newer release in place: same folders, new files, dropped files gone"

echo "# v9.9.10" >> "$T/src/README.md"
commit commit -qam v9.9.10
release v9.9.10
CAGE_HOME="$T/cage-home" CAGE_MSB=true "$HOME/.local/bin/cage" update 2>"$T/err" || true
grep -q 'installed cage v9.9.10' "$T/err" || fail "cage update didn't install the new release: $(cat "$T/err")"
[ "$("$HOME/.local/bin/cage" --version)" = "cage v9.9.10" ] || fail "cage update: still $("$HOME/.local/bin/cage" --version)"
ok "cage update installs the latest release first"

echo "# v9.9.11" >> "$T/src/README.md"
commit commit -qam v9.9.11
release v9.9.11
printf 'tampered' >> "$T/www/releases/download/v9.9.11/cage-v9.9.11.tar.gz"
if bash "$ROOT/install.sh" 2>"$T/err"; then fail "installed a download that doesn't match its checksum"; fi
grep -q "doesn't match its checksum" "$T/err" || fail "unclear error: $(cat "$T/err")"
[ "$(cat "$HOME/cage/VERSION")" = v9.9.10 ] || fail "a refused download changed the install"
CAGE_HOME="$T/cage-home" CAGE_MSB=true "$HOME/.local/bin/cage" update 2>"$T/err" || true
grep -q "couldn't update cage itself (still v9.9.10)" "$T/err" || fail "cage update hid the refusal: $(cat "$T/err")"
ok "refuses a download that doesn't match the release's checksum, and leaves cage as it was"

echo "all $pass installer tests passed"
