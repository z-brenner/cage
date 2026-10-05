#!/usr/bin/env bash
# Prints a version's release notes: its section of CHANGELOG.md, without the heading. Fails when that section is
# missing, empty or still just CHANGELOG.md's placeholder ("Nothing yet."), so every release says in plain words what
# changed. Used by .github/workflows/release.yml.
#   scripts/release-notes.sh <tag> [changelog]
set -euo pipefail
TAG="${1:?usage: release-notes.sh <tag> [changelog]}"
FILE="${2:-$(cd "$(dirname "$0")/.." && pwd)/CHANGELOG.md}"
[ -f "$FILE" ] || { echo "no changelog at $FILE" >&2; exit 1; }
# The section runs from '## <tag>' (anything after the tag, like a date, is fine) to the next '## ' heading.
# Blank lines around it are dropped.
notes="$(awk -v tag="$TAG" '
  /^## / { if (on) exit; on = ($2 == tag); next }
  on { line[++n] = $0 }
  END {
    s = 1; while (s <= n && line[s] ~ /^[[:space:]]*$/) s++
    e = n; while (e >= s && line[e] ~ /^[[:space:]]*$/) e--
    for (i = s; i <= e; i++) print line[i]
  }' "$FILE")"
# an Unreleased section renamed to the version before anyone wrote its notes
if [ -z "$notes" ] || [ "$notes" = "Nothing yet." ]; then
  echo "CHANGELOG.md has no notes for $TAG. Add a '## $TAG' section that says what's new, what changed and anything" >&2
  echo "to do after updating (see the top of CHANGELOG.md), commit it to main, then release again." >&2
  exit 1
fi
printf '%s\n' "$notes"
