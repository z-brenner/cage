#!/usr/bin/env bash
# The cc-connect and microsandbox versions cage is tested with are written down in several places: cage's default,
# the VM's fallback, the smoke test, CI (which checks configs with a real cc-connect and runs real microVMs) and
# cage.env.example. This checks they all agree with cage, so a version bump can't leave CI testing one version while
# people get another. It also checks that the workflows run only what they pin: each GitHub Action at a commit, and
# each download against its checksum.
#   test/pins.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# a version, with an optional pre-release part (v1.5.1-beta.3) but not a file name's platform (cc-connect-v1.5.0-linux)
V='v[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc|pre|dev)[0-9A-Za-z.]*)?'
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }

# Where the copies are: the files that decide what gets downloaded and tested for real. The unit tests aren't
# searched (their fixtures may name an older version on purpose, say to test moving people off it), and only a
# setting or a download names a pin (CC_CONNECT_VERSION=v..., .../releases/download/v..., cc-connect-v...), so a
# comment about what changed in some version is fine. Lines with a SHA-256 on them are left out too: checksum tables
# list several versions on purpose.
FILES=(guest/*.sh scripts/*.sh test/guest-smoke.sh test/offline-wake.sh test/microvm-e2e.sh test/install-msb-pinned.sh
  .github/workflows/*.yml cage.env.example)

# copies <setting or download pattern>: prints "file:line:version" for each version a pin pattern names
copies() {
  local f
  for f in "${FILES[@]}"; do
    [ -f "$f" ] || continue
    { grep -nE "$1" "$f" | grep -vE '[0-9a-f]{64}' || true; } | while IFS=: read -r n line; do
      grep -oE "$1" <<<"$line" | grep -oE "$V" | sed "s|^|$f:$n:|"
    done
  done
}
# agree <name> <pin> <pattern>: every copy must be the pin; prints the files that have one
agree() {
  local name="$1" pin="$2" f n v where=""
  while IFS=: read -r f n v; do
    [ "$v" = "$pin" ] || fail "$f:$n has $name $v, but cage pins $pin. Change it to $pin (or change cage's pin): $(sed -n "${n}p" "$f")"
    case " $where " in *" $f "*) ;; *) where="$where $f" ;; esac
  done < <(copies "$3")
  echo "$where"
}

cc="$(sed -nE "s/.*CAGE_CC_CONNECT_VERSION:-($V)\}.*/\1/p" cage | head -n 1)"
[ -n "$cc" ] || fail "can't find cage's cc-connect version (CAGE_CC_CONNECT_VERSION:-v...); update test/pins.sh"
where="$(agree cc-connect "$cc" "(CC_CONNECT_VERSION(=|:-|: )[\"']?|cc-connect/releases/download/|cc-connect-)$V")"
# the VM's own default and CI's real cc-connect always name it; when they don't, this test has gone blind
for f in guest/provision.sh .github/workflows/ci.yml; do
  case " $where " in *" $f "*) ;; *) fail "no cc-connect version found in $f; update test/pins.sh" ;; esac
done
ok "cc-connect $cc everywhere:$where"

# CAGE_CC_CONNECT_VERSION=stable, the way back from a preview cc-connect, must name a release the VM can check fully
stable="$(sed -nE "s/^STABLE_CC_CONNECT=\"($V)\".*/\1/p" cage)"
[ -n "$stable" ] || fail "can't find cage's STABLE_CC_CONNECT=\"v...\"; update test/pins.sh"
case "$stable" in *-*) fail "STABLE_CC_CONNECT is a pre-release ($stable); it has to be a stable release" ;; esac
for arch in amd64 arm64; do
  grep -qE "^ *${stable//./\\.}-$arch\) echo [0-9a-f]{64} ;;" guest/provision.sh ||
    fail "guest/provision.sh keeps no checksum for cc-connect $stable ($arch), the one CAGE_CC_CONNECT_VERSION=stable picks"
done
ok "cc-connect stable is $stable, a release the VM keeps checksums for"

msb="$(grep -oE "MSB_VERSION(=|:-)[\"']?$V" cage | grep -oE "$V" | sort -u || true)"
[ -n "$msb" ] || fail "can't find cage's microsandbox version (MSB_VERSION=v...); update test/pins.sh"
[ "$(wc -l <<<"$msb")" = 1 ] || fail "cage pins more than one microsandbox version: $(echo $msb)"
where="$(agree microsandbox "$msb" "(MSB_VERSION(=|:-|: )[\"']?|microsandbox/releases/download/)$V")"
ok "microsandbox $msb everywhere:${where:- (only in cage)}"

# The workflows. A tag like @v4 can be moved to other code at any time, so each action is pinned to a commit, with
# its version in a comment for people and Dependabot. actions/checkout leaves the job's token in .git/config
# for every later step unless told not to. And whatever curl downloads is checked with sha256sum -c in the same step.
# (A merge that brings back an older side of a workflow would lose any of these without failing anything else.)
problems="$(awk '
  function indent() { match($0, /^ */); return RLENGTH }
  function end_step() {
    if (checkout && !nocred) print FILENAME ":" checkout ": actions/checkout without persist-credentials: false (the token would stay in .git/config for the steps after it)"
    if (download && !summed) print FILENAME ":" download ": a curl download with no sha256sum -c after it in the same step"
    checkout = nocred = download = summed = 0; step = -1
  }
  FNR == 1 { end_step(); more = "" }
  # a shell line continued with a backslash is read as one line, numbered by its first
  { ln = FNR; if (more != "") { ln = from; $0 = more " " $0; more = "" } }
  /\\$/ { from = ln; more = substr($0, 1, length($0) - 1); next }
  /^[[:space:]]*(#|$)/ { next }
  # a step (or any list item) runs from its "- " to the next line indented no deeper than that dash
  step >= 0 && indent() <= step { end_step() }
  step < 0 && /^ *- / { step = indent() }
  /^[ -]*uses:/ {
    uses++; v = $0; sub(/^[ -]*uses:[[:space:]]*/, "", v)
    at = v; sub(/^[^@]*@/, "", at); commit = at; sub(/[[:space:]].*/, "", commit)
    if (v !~ /^\.\// && !(v ~ /^[^@[:space:]]+@/ && commit ~ /^[0-9a-f]+$/ && length(commit) == 40 && at ~ / # v[0-9]/))
      print FILENAME ":" ln ": " v " isn'"'"'t pinned to a commit. Write it as <action>@<commit> # vX.Y.Z, with the commit from git ls-remote https://github.com/<action> vX.Y.Z"
  }
  /uses:[[:space:]]*actions\/checkout@/ { checkouts++; checkout = ln }
  /persist-credentials:[[:space:]]*false/ { nocred = 1 }
  /(^|[^[:alnum:]_-])curl[[:space:]].*https?:\/\// { downloads++; download = ln; summed = 0 }
  /sha256sum (-c|--check)/ && download { summed = 1 }
  END { end_step(); print "counts " uses + 0 " " checkouts + 0 " " downloads + 0 }
' .github/workflows/*.yml)"
counts="$(sed -n 's/^counts //p' <<<"$problems")"
problems="$(grep -v '^counts ' <<<"$problems" || true)"
[ -z "$problems" ] || fail "$problems"
read -r uses checkouts downloads <<<"$counts"
[ "$uses" -gt 0 ] && [ "$checkouts" -gt 0 ] && [ "$downloads" -gt 0 ] || fail "found no actions, checkouts or downloads in .github/workflows; update test/pins.sh"
ok "the workflows: $uses actions pinned to commits, $checkouts checkouts that keep no token, $downloads downloads checked"
# Dependabot proposes new versions of those actions, but only once they're a week old (a compromised release, like
# tj-actions/changed-files in 2025, was found and pulled within days)
days="$(sed -nE 's/^ +default-days: *([0-9]+) *$/\1/p' .github/dependabot.yml)"
[ -n "$days" ] && [ "$days" -ge 7 ] || fail ".github/dependabot.yml should wait at least 7 days for new versions (cooldown: default-days: 7), not '${days:-none}'"
ok "Dependabot waits $days days before it proposes a new version"

echo "all $pass pin tests passed"
