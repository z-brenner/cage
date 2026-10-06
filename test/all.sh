#!/usr/bin/env bash
# Every fast check, one after another: what CI's "lint + host tests" job runs through this script. That job also runs
# the host, setup, sign-in and mask suites under bash 3.2 (what macOS ships) and checks install.ps1 with PowerShell,
# which this doesn't; for bash 3.2 here, run the docker command in .github/workflows/ci.yml's "bash 3.2" step.
# Shows each suite's output as it goes, then a summary with how long each took.
#   test/all.sh                    every suite
#   test/all.sh host ui            only these (names as in the summary)
#   test/all.sh --skip mask unit   all but these
# A suite whose tool isn't installed is skipped and listed as such; CAGE_TEST_NO_SKIP=1 (CI sets it) makes that a
# failure instead. The web app suite needs Playwright: PLAYWRIGHT_MODULE=/path/to/node_modules/playwright, or a
# global install, plus CAGE_TEST_CHROME=/path/to/chrome if Playwright's own Chromium isn't installed.
# CAGE_TEST_CC_CONNECT=/path/to/cc-connect has the host suite check the generated configs with a real cc-connect,
# and chat through it.
# The slow ones need Docker or KVM and run on their own: test/guest-smoke.sh, test/offline-wake.sh, test/microvm-e2e.sh.
set -uo pipefail
shopt -s nullglob
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

SUITES="shellcheck workflows js python pins mask unit provision-unit host setup oauth installer release ui"
ONLY="" SKIP=""
if [ "${1:-}" = --skip ]; then shift; SKIP="$*"; else ONLY="$*"; fi
for s in "$@"; do
  case " $SUITES " in *" $s "*) ;; *) echo "no suite called '$s'; the suites are: $SUITES" >&2; exit 2 ;; esac
done
wanted() {
  case " $SKIP " in *" $1 "*) return 1 ;; esac
  [ -z "$ONLY" ] || case " $ONLY " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

js_parses() { # every script parses: the VM's, the web app's, the tests' (and their fixtures')
  local f rc=0
  for f in guest/*.mjs host/ui/static/*.js test/*.mjs test/*/*.mjs; do node --check "$f" || rc=1; done
  return $rc
}
python_compiles() { # every Python file compiles (the bytecode goes to a temp folder, not next to the sources)
  PYTHONPYCACHEPREFIX="$T/pycache" python3 -m py_compile host/*.py host/ui/*.py guest/*.py test/*.py
}
# node's own test runner on every test/*.test.mjs (the browser test, test/ui.browser.mjs, is the ui suite's), then each
# Python unit test, test/*_test.py
unit_tests() {
  local f rc=0
  node --test test/*.test.mjs || rc=1
  for f in test/*_test.py; do echo "# $f"; PYTHONPYCACHEPREFIX="$T/pycache" python3 "$f" || rc=1; done
  return $rc
}
have_playwright() { [ -n "${PLAYWRIGHT_MODULE:-}" ] || [ -d "$(npm root -g 2>/dev/null)/playwright" ]; }

results=() failed=0 skipped=0 ran_failed=0
now_ms() { # bash 5 has the time to the microsecond (with the locale's decimal mark); older bash, to the second
  local t="${EPOCHREALTIME:-}"
  if [ -n "$t" ]; then t="${t//[.,]/}"; echo $((t / 1000)); else echo $((SECONDS * 1000)); fi
}
took() { printf '%d.%ds' $(($1 / 1000)) $(($1 % 1000 / 100)); }
start="$(now_ms)"

# run <suite> <command...>: runs one suite (if it was asked for) and notes how it went and how long it took
run() {
  local name="$1" t0 ms rc
  shift
  wanted "$name" || return 0
  echo
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$name"; else echo "== $name"; fi
  t0="$(now_ms)"
  "$@" </dev/null
  rc=$?
  ms=$(($(now_ms) - t0))
  [ -z "${GITHUB_ACTIONS:-}" ] || echo "::endgroup::"
  if [ "$rc" -eq 0 ]; then
    results+=("$(printf '  ok       %-15s %8s' "$name" "$(took "$ms")")")
    echo "-- $name: ok ($(took "$ms"))"
  else
    failed=1 ran_failed=1
    results+=("$(printf '  FAILED   %-15s %8s' "$name" "$(took "$ms")")")
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error title=test/all.sh::$name failed"; fi
    echo "-- $name: FAILED ($(took "$ms"))"
  fi
}
# skip <suite> <why>: a suite that can't run here
skip() {
  wanted "$1" || return 0
  if [ -n "${CAGE_TEST_NO_SKIP:-}" ]; then
    failed=1
    results+=("$(printf '  FAILED   %-15s not run: %s' "$1" "$2")")
  else
    skipped=$((skipped + 1))
    results+=("$(printf '  skipped  %-15s %s' "$1" "$2")")
  fi
}

if command -v shellcheck >/dev/null; then run shellcheck shellcheck -S warning cage install.sh guest/*.sh test/*.sh scripts/*.sh
else skip shellcheck "no shellcheck"; fi
# the workflow files: what GitHub would refuse to run, or run wrongly (SC2016: the PowerShell in single quotes is meant)
if command -v actionlint >/dev/null; then run workflows actionlint -ignore SC2016
else skip workflows "no actionlint (https://github.com/rhysd/actionlint)"; fi
run js js_parses
run python python_compiles
run pins test/pins.sh
run mask test/mask.sh
run unit unit_tests
# guest/provision.sh's functions with stubs, where this checkout has that test
if [ -f test/provision-unit.sh ]; then run provision-unit test/provision-unit.sh; fi
if wanted host && [ -z "${CAGE_TEST_CC_CONNECT:-}" ]; then
  echo; echo "(host: set CAGE_TEST_CC_CONNECT to also check the generated configs with a real cc-connect)"
fi
run host test/host.sh
run setup test/setup.sh
run oauth test/oauth.sh
run installer test/installer.sh
if command -v jq >/dev/null; then run release test/release.sh
else skip release "no jq (its stub gh needs it)"; fi
if have_playwright; then run ui test/ui.sh
else skip ui "no playwright (set PLAYWRIGHT_MODULE, or npm install -g playwright)"; fi

[ ${#results[@]} -gt 0 ] || { echo "nothing ran (test/provision-unit.sh isn't in this checkout)"; exit 1; }
echo
echo "== summary"
printf '%s\n' "${results[@]}"
total="$(took $(($(now_ms) - start)))"
if [ "$ran_failed" -ne 0 ]; then echo "FAILED (see above) after $total"
elif [ "$failed" -ne 0 ]; then echo "FAILED after $total: not every suite could run here"
elif [ "$skipped" -gt 0 ]; then echo "the rest passed, $skipped skipped, in $total"
else echo "all passed in $total"; fi
exit "$failed"
