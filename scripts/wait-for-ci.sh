#!/usr/bin/env bash
# Waits for CI to finish on a commit of main, and passes only if CI passed. release.yml runs this before it builds,
# so nothing is published from a commit CI failed on, or hasn't finished testing.
#   scripts/wait-for-ci.sh <commit>
# Needs gh, GH_TOKEN with read access to Actions, and GITHUB_REPOSITORY (owner/repo). It looks only at CI's run for
# the push to main: a pull request's run tested the branch, not what landed on main.
# CI_WAIT_MINUTES (default 60) is the longest it waits for CI to finish, CI_FIND_MINUTES (default 10) the longest
# for CI's run to show up at all, and CI_POLL_SECONDS (default 30) how often it looks.
set -euo pipefail
SHA="${1:?usage: wait-for-ci.sh <commit>}"
REPO="${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY to owner/repo}"
POLL="${CI_POLL_SECONDS:-30}"
WAIT=$(( ${CI_WAIT_MINUTES:-60} * 60 ))
FIND=$(( ${CI_FIND_MINUTES:-10} * 60 ))
err="$(mktemp)"
trap 'rm -f "$err"' EXIT
errors=0 last=""
while :; do
  # the newest run of ci.yml for this commit pushed to main, as "status|conclusion|url" (no conclusion until it ends)
  if run="$(gh run list -R "$REPO" -w ci.yml -b main -c "$SHA" -e push -L 1 --json status,conclusion,url \
              --jq '.[] | "\(.status)|\(.conclusion)|\(.url)"' 2>"$err")"; then
    errors=0
  else
    # GitHub's API has bad moments; give up only when it keeps failing
    errors=$((errors + 1))
    echo "couldn't ask GitHub about CI ($errors): $(tr '\n' ' ' <"$err")"
    [ "$errors" -lt 5 ] || { echo "giving up: GitHub kept refusing. Start the release again later."; exit 1; }
    run="error"
  fi
  IFS='|' read -r status conclusion url <<<"$run"
  case "$status" in
    completed)
      if [ "$conclusion" = success ]; then echo "CI passed on $SHA: $url"; exit 0; fi
      echo "CI didn't pass on $SHA (it ended: $conclusion): $url"
      echo "Fix what failed and release a newer commit. If a job only failed by chance, re-run it on that page;"
      echo "once CI is green, start the release again."
      exit 1 ;;
    error) ;;
    "")
      if [ "$SECONDS" -ge "$FIND" ]; then
        echo "CI hasn't run on $SHA. It runs on each push to main, for the newest commit pushed;"
        echo "release a commit that CI has tested."
        exit 1
      fi
      [ "$last" = none ] || echo "no CI run for $SHA yet; waiting for it to start"
      last=none ;;
    *)
      [ "$last" = "$status" ] || echo "CI on $SHA is $status; waiting for it to finish: $url"
      last="$status" ;;
  esac
  if [ "$SECONDS" -ge "$WAIT" ]; then
    echo "CI on $SHA didn't finish within $((WAIT / 60)) minutes${url:+: $url}. Start the release again once it has."
    exit 1
  fi
  sleep "$POLL"
done
