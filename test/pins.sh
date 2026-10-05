#!/usr/bin/env bash
# The cc-connect and microsandbox versions cage is tested with are written down in several places: cage's default,
# the VM's fallback, the smoke test, CI (which checks configs with a real cc-connect and runs real microVMs) and
# cage.env.example. This checks they all agree with cage, so a version bump can't leave CI testing one version while
# people get another.
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

msb="$(grep -oE "MSB_VERSION(=|:-)[\"']?$V" cage | grep -oE "$V" | sort -u || true)"
[ -n "$msb" ] || fail "can't find cage's microsandbox version (MSB_VERSION=v...); update test/pins.sh"
[ "$(wc -l <<<"$msb")" = 1 ] || fail "cage pins more than one microsandbox version: $(echo $msb)"
where="$(agree microsandbox "$msb" "(MSB_VERSION(=|:-|: )[\"']?|microsandbox/releases/download/)$V")"
ok "microsandbox $msb everywhere:${where:- (only in cage)}"

echo "all $pass pin tests passed"
