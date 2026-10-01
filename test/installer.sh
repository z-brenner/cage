#!/usr/bin/env bash
# Tests install.sh against a local copy of this repo: fresh install, the `cage` command, PATH setup, re-run update.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }

# a throwaway "remote": the current tree committed on a main branch
mkdir -p "$T/src"
(cd "$ROOT" && tar --exclude=.git -cf - .) | tar -xf - -C "$T/src"
git -C "$T/src" init -q -b main
git -C "$T/src" -c user.name=t -c user.email=t@t.invalid add -A
git -C "$T/src" -c user.name=t -c user.email=t@t.invalid commit -qm snapshot

export HOME="$T/home" CAGE_REPO="$T/src" CAGE_NO_START=1 PATH="/usr/local/bin:/usr/bin:/bin"
mkdir -p "$HOME"
bash "$ROOT/install.sh" 2>"$T/err" || fail "install failed: $(cat "$T/err")"
[ -x "$HOME/cage/cage" ] || fail "cage not cloned into ~/cage"
[ "$(readlink -f "$HOME/.local/bin/cage")" = "$HOME/cage/cage" ] || fail "cage command not linked"
[ "$(grep -c 'added by the cage installer' "$HOME/.bashrc")" = 1 ] || fail "PATH line missing from .bashrc"
"$HOME/.local/bin/cage" help >/dev/null || fail "the cage command doesn't run"
ok "fresh install: clones to ~/cage, links ~/.local/bin/cage, puts it on PATH"

echo "# newer" >> "$T/src/README.md"
git -C "$T/src" -c user.name=t -c user.email=t@t.invalid commit -qam newer
bash "$ROOT/install.sh" 2>"$T/err" || fail "re-run failed: $(cat "$T/err")"
grep -q 'updated' "$T/err" || fail "re-run did not update: $(cat "$T/err")"
tail -1 "$HOME/cage/README.md" | grep -q '# newer' || fail "re-run did not fetch the new commit"
[ "$(grep -c 'added by the cage installer' "$HOME/.bashrc")" = 1 ] || fail "PATH line added twice"
ok "re-running updates cage and doesn't duplicate the PATH line"

rm -rf "$HOME/cage" && mkdir -p "$HOME/cage" && touch "$HOME/cage/notes.txt"
if bash "$ROOT/install.sh" 2>"$T/err"; then fail "overwrote a folder that isn't cage"; fi
grep -q "isn't a cage checkout" "$T/err" || fail "unclear error: $(cat "$T/err")"
ok "refuses to touch an existing folder that isn't cage"

echo "all $pass installer tests passed"
