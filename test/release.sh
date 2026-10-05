#!/usr/bin/env bash
# Tests what the release workflow relies on: scripts/wait-for-ci.sh (a release waits for CI on its commit and goes
# ahead only if CI passed), against a stub gh that plays back CI runs, and scripts/release-notes.sh (the notes come
# from CHANGELOG.md, and a release without them stops). Needs jq (the stub applies gh's --jq with it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok - $*"; }

# stub gh: logs its arguments, then answers each call with the next line of $T/runs (the last line repeats):
# "none" is no run at all, "error: ..." a failing API call, anything else "status conclusion" of CI's newest run
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$T/gh.log"
n=$(( $(cat "$T/gh.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$T/gh.n"
[ "$n" -le 50 ] || { echo "stub gh: asked more than 50 times" >&2; exit 1; }   # a test that would spin forever fails
line="$(sed -n "${n}p" "$T/runs")"; [ -n "$line" ] || line="$(tail -n 1 "$T/runs")"
q=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && q="$2"; shift; done
case "$line" in
  none) json='[]' ;;
  error:*) echo "${line#error:}" >&2; exit 1 ;;
  *) set -- $line; json="[{\"status\":\"$1\",\"conclusion\":\"${2:-}\",\"url\":\"https://github.com/o/r/actions/runs/7\"}]" ;;
esac
echo "A new release of gh is available" >&2   # gh's notices go to stderr, and mustn't be read as CI's answer
if [ -n "$q" ]; then jq -r "$q" <<<"$json"; else echo "$json"; fi
EOF
chmod +x "$T/bin/gh"
export T
SHA=0123456789abcdef0123456789abcdef01234567
# wait <runs, one per line>: runs wait-for-ci.sh against them, without real waiting; output in $out, status in $rc
wait_ci() {
  printf '%s\n' "$@" > "$T/runs"; rm -f "$T/gh.n" "$T/gh.log"
  rc=0
  out="$(PATH="$T/bin:$PATH" GITHUB_REPOSITORY=o/r CI_POLL_SECONDS=0 "$ROOT/scripts/wait-for-ci.sh" "$SHA" 2>&1)" || rc=$?
}

wait_ci "queued" "in_progress" "in_progress" "completed success"
[ "$rc" = 0 ] || fail "green CI didn't pass the gate: $out"
[ "$(wc -l < "$T/gh.log")" -eq 4 ] || fail "didn't keep checking until CI finished: $(cat "$T/gh.log")"
grep -q -- "-R o/r -w ci.yml -b main -c $SHA -e push -L 1 " "$T/gh.log" || fail "asked about the wrong runs: $(head -n 1 "$T/gh.log")"
grep -q 'CI on .* is queued' <<<"$out" && grep -q 'is in_progress' <<<"$out" || fail "didn't say what it's waiting for: $out"
[ "$(grep -c 'is in_progress' <<<"$out")" = 1 ] || fail "repeated itself while nothing changed: $out"
ok "a release waits for CI on its commit (only CI's run for the push to main) and goes ahead once it passed"

for bad in failure cancelled timed_out startup_failure; do
  wait_ci "in_progress" "completed $bad"
  [ "$rc" = 1 ] || fail "CI that ended '$bad' let the release through: $out"
  grep -q "it ended: $bad" <<<"$out" && grep -q 'actions/runs/7' <<<"$out" || fail "no reason or link for '$bad': $out"
done
grep -q 're-run' <<<"$out" || fail "doesn't say what to do: $out"
ok "red, cancelled or broken CI stops the release, with a link and what to do"

wait_ci "none" "none" "completed success"
[ "$rc" = 0 ] || fail "a run that showed up late wasn't waited for: $out"
rm -f "$T/gh.n"
rc=0; out="$(PATH="$T/bin:$PATH" GITHUB_REPOSITORY=o/r CI_POLL_SECONDS=0 CI_FIND_MINUTES=0 "$ROOT/scripts/wait-for-ci.sh" "$SHA" 2>&1)" || rc=$?
[ "$rc" = 1 ] && grep -q "CI hasn't run on $SHA" <<<"$out" || fail "a commit CI never ran on was released: $out"
printf 'in_progress\n' > "$T/runs"; rm -f "$T/gh.n"
rc=0; out="$(PATH="$T/bin:$PATH" GITHUB_REPOSITORY=o/r CI_POLL_SECONDS=0 CI_WAIT_MINUTES=0 "$ROOT/scripts/wait-for-ci.sh" "$SHA" 2>&1)" || rc=$?
[ "$rc" = 1 ] && grep -q "didn't finish within 0 minutes: https" <<<"$out" || fail "waited forever, or passed, on unfinished CI: $out"
ok "no CI run for the commit, or CI that doesn't finish in time, stops the release"

wait_ci "error: HTTP 502" "error: HTTP 502" "completed success"
[ "$rc" = 0 ] || fail "a passing hiccup of GitHub's API stopped the release: $out"
wait_ci "error: HTTP 403: Resource not accessible by integration"
[ "$rc" = 1 ] && grep -q 'HTTP 403' <<<"$out" && [ "$(wc -l < "$T/gh.log")" -eq 5 ] || fail "kept going on a GitHub that keeps refusing: $out"
ok "rides out a few failed API calls, and stops with GitHub's answer when they keep failing"

# --- release notes from CHANGELOG.md
cat > "$T/CHANGELOG.md" <<'EOF'
# Changelog

Header text, with a ## that isn't at the start of the line.

## Unreleased

- something not released yet

## v1.3.0 (2026-10-05)

Nothing yet.

## v1.2.0 (2026-10-01)

**New:** one.

### Details
- two

## v1.1.0

Older.
## v1.0.0-beta.1
EOF
notes="$("$ROOT/scripts/release-notes.sh" v1.2.0 "$T/CHANGELOG.md")" || fail "no notes for v1.2.0"
[ "$notes" = "$(printf '**New:** one.\n\n### Details\n- two')" ] || fail "wrong notes for v1.2.0: $notes"
[ "$("$ROOT/scripts/release-notes.sh" v1.1.0 "$T/CHANGELOG.md")" = "Older." ] || fail "a section with no date or no blank line"
for missing in v1.0.0 v1.2 v1.3.0 v1.0.0-beta.1; do
  if out="$("$ROOT/scripts/release-notes.sh" "$missing" "$T/CHANGELOG.md" 2>&1)"; then
    fail "release notes for '$missing', which has no section (or an empty one, or just the placeholder): $out"
  fi
done
grep -q "## v1.0.0-beta.1' section" <<<"$out" && grep -q 'release again' <<<"$out" || fail "doesn't say what to do: $out"
# The repository's own CHANGELOG.md: each version in it has notes. That holds before a release (only Unreleased),
# after one (the heading renamed, with or without a new Unreleased above it), and whatever Unreleased says meanwhile.
[ -f "$ROOT/CHANGELOG.md" ] || fail "there's no CHANGELOG.md, so no release can be published"
for v in $(sed -nE 's/^## (v[0-9][^ ]*).*/\1/p' "$ROOT/CHANGELOG.md"); do
  out="$("$ROOT/scripts/release-notes.sh" "$v" "$ROOT/CHANGELOG.md" 2>&1)" || fail "$out"
done
ok "release notes: the version's CHANGELOG.md section; none, an empty one or just 'Nothing yet.' stops the release"

# --- release.yml itself
W="$ROOT/.github/workflows/release.yml"
run_of() { # run_of <step name>: that step's script, as written in release.yml
  awk -v name="- name: $1" 'index($0, name) { on = 1; next }
    on && /run: \|/ { body = 1; next }
    body && /^$/ { print; next }
    body && /^          / { print substr($0, 11); next }
    body { exit }' "$W"
}
# its first check, run as written there: a version, a commit on main, and an existing tag must be that commit
step="$(run_of 'a version, on main')"
[ -n "$step" ] || fail "can't find the version check in release.yml"
g() { git -C "$T/repo" -c user.name=t -c user.email=t@t.invalid -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
git init -q "$T/repo"
g commit -q --allow-empty -m one; one="$(g rev-parse HEAD)"; g tag -a v0.9.0 -m v0.9.0
g commit -q --allow-empty -m two; two="$(g rev-parse HEAD)"; g update-ref refs/remotes/origin/main "$two"
g commit -q --allow-empty -m side; side="$(g rev-parse HEAD)"
check() { (cd "$T/repo" && TAG="$1" GITHUB_SHA="$2" bash --noprofile --norc -eo pipefail -c "$step" 2>&1); }
out="$(check v1.0.0 "$two")" || fail "a new version on main was refused: $out"
out="$(check v0.9.0 "$one")" || fail "a pushed (annotated) tag on main was refused: $out"
out="$(check v1.0.0 "$side")" && fail "released a commit that isn't on main"
grep -q "isn't on main" <<<"$out" || fail "doesn't say why: $out"
out="$(check v0.9.0 "$two")" && fail "released over an existing tag at another commit"
grep -q "already exists, at another commit ($one)" <<<"$out" || fail "doesn't say why: $out"
out="$(check 1.0 "$two")" && fail "released a tag that isn't a version"
# The publish step, run as written there against a stub gh: by then someone may have pushed the tag at another commit
step="$(run_of publish)"
[ -n "$step" ] || fail "can't find the publish step in release.yml"
mkdir -p "$T/pub/bin" "$T/pub/dist"
cat > "$T/pub/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$T/pub/gh.log"
[ "$1" = api ] || exit 0
case "$(cat "$T/pub/tag")" in
  none) echo '{"message":"No commit found for SHA: tags/v1.0.0"}'; echo "gh: No commit found for SHA: tags/v1.0.0 (HTTP 422)" >&2; exit 1 ;;
  down) echo "gh: HTTP 502: Bad Gateway" >&2; exit 1 ;;
  *) cat "$T/pub/tag" ;;
esac
EOF
chmod +x "$T/pub/bin/gh"
publish() { # publish <where GitHub has the tag: a commit, none or down>: output in $out, status in $rc
  echo "$1" > "$T/pub/tag"; rm -f "$T/pub/gh.log"
  rc=0
  out="$(cd "$T/pub" && PATH="$T/pub/bin:$PATH" TAG=v1.0.0 GITHUB_SHA="$two" GH_REPO=o/r RUNNER_TEMP="$T/pub" \
    bash --noprofile --norc -eo pipefail -c "$step" 2>&1)" || rc=$?
}
publish none
[ "$rc" = 0 ] && grep -q "^release create v1.0.0 .*--target $two" "$T/pub/gh.log" || fail "a new tag wasn't published: $out"
grep -q '^api repos/o/r/commits/tags/v1.0.0 ' "$T/pub/gh.log" || fail "didn't ask where the tag is: $(cat "$T/pub/gh.log")"
publish "$two"
[ "$rc" = 0 ] && grep -q '^release create' "$T/pub/gh.log" || fail "a tag at the built commit wasn't published: $out"
for at in "$one" down; do
  publish "$at"
  [ "$rc" = 1 ] && ! grep -q '^release create' "$T/pub/gh.log" || fail "published with the tag at '$at': $out"
  grep -q 'Nothing was published' <<<"$out" || fail "doesn't say what happened: $out"
done
publish "$one"; grep -q "now points at $one, not at $two" <<<"$out" || fail "doesn't say why: $out"
ok "release.yml publishes only while the tag is missing or still at the commit it built"

# and the order: notes and CI's verdict before the build, and nothing before the publish job can write
at() { grep -n -m 1 -F -- "$1" "$W" | cut -d: -f1; }
notes="$(at 'scripts/release-notes.sh "$TAG" > out/notes.md')" gate="$(at 'scripts/wait-for-ci.sh "$GITHUB_SHA"')"
build="$(at 'scripts/build-release.sh')" publish="$(at '  publish:')"
[ -n "$notes" ] && [ -n "$gate" ] && [ -n "$build" ] && [ "$notes" -lt "$build" ] && [ "$gate" -lt "$build" ] \
  || fail "release.yml doesn't get the notes and wait for CI before it builds"
grep -qF -- '--notes-file notes.md' "$W" || fail "release.yml doesn't publish the notes from CHANGELOG.md"
awk -v p="$publish" 'NR < p && /: *write/ { bad = 1 } END { exit bad }' "$W" || fail "something before the publish job can write"
ok "release.yml: only a version on main, at its own tag; notes and green CI before the build; only publish writes"

echo "all $pass release tests passed"
