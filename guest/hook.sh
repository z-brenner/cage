#!/bin/bash
# cc-connect's hook inside an agent's VM (runs as the agent user, for every message in and out). Hooks can't change
# messages; this one only leaves requests for cage on your computer, in /cage-outbox:
#   /all <question> (or @all …)  "ask": your other agents answer in this chat too       (cage ask-all on)
#                                (/askall too; cc-connect makes them "@all …", after this hook has seen them)
#   a usage-limit reply          "fallback": another agent answers your last message     (cage fallback <agent> <to>)
# What's on comes as arguments (from the generated config: hook.sh ask fallback). Everything else arrives in
# CC_HOOK_* variables, never through a shell.
# A request is a folder with three files (kind, session, text), moved into place whole.
set -uo pipefail

FEATURES=" $* "
OUT="${CAGE_OUTBOX:-/cage-outbox}"
STATE="${HOME:-/home/agent}/.cage/chats"
on() { [[ "$FEATURES" == *" $1 "* ]]; }

key="${CC_HOOK_SESSION_KEY:-}"
[ -n "$key" ] || exit 0
on ask || on fallback || exit 0

request() { # request <kind> <text>
  local id tmp
  id="$(date +%s)-$$-$RANDOM"
  tmp="$OUT/.tmp-$id"
  mkdir -p "$tmp" || return 0
  printf '%s' "$1" > "$tmp/kind"
  printf '%s' "$key" > "$tmp/session"
  printf '%s' "$2" | head -c 16000 > "$tmp/text"
  mv "$tmp" "$OUT/$id"
}

# The last few turns of each chat, for whoever stands in when this agent is out of quota.
h="$(printf '%s' "$key" | sha1sum | cut -c1-16)"
log="$STATE/$h"
remember() { # remember <who> <text>: one line per turn, the last six kept
  mkdir -p "$STATE" && chmod 700 "$STATE"
  { cat "$log" 2>/dev/null; printf '%s: %s\n' "$1" "$(printf '%s' "$2" | head -c 2000 | tr '\n\r' '  ')"; } | tail -n 6 > "$log.tmp" &&
    mv "$log.tmp" "$log"
}

shopt -s nocasematch
# A question for all your agents, as cc-connect sees one (so this agent and your others answer the same messages): a
# message that starts, once trimmed, with /all and a space (cage's aliases: after a tab, it's cc-connect's /allow),
# /askall and a space or a tab (cage's command too), or @all (plain text, which this agent gets anyway), in any case,
# and has a question after it. /all@YourBot: Telegram leaves your bot's name on when it's written in another case.
all_re=$'^(/all(@[A-Za-z0-9_]+)? |/askall(@[A-Za-z0-9_]+)?[ \t]|@all[[:space:]])[[:space:]]*(.+)$'
# Claude: "5-hour limit reached ∙ resets 3pm", "You've hit your limit", "API Error: 529 Overloaded";
# Codex: "You've hit your usage limit…", "…429 Too Many Requests"
limit_re="limit (reached|exceeded|will reset)|hit (your|the) .{0,20}limit|api error: (429|529)|too many requests|out of (credits|usage)|(quota|credits) (exceeded|reached|exhausted)|exceeded (your|the) .{0,20}quota"

case "${CC_HOOK_EVENT:-}" in
  message.received)
    text="${CC_HOOK_CONTENT:-}"
    # cc-connect trims a message first; what counts here is its start
    [[ "$text" =~ ^[[:space:]]+ ]] && text="${text:${#BASH_REMATCH[0]}}"
    [ -n "$text" ] || exit 0
    if [[ "$text" =~ $all_re ]]; then
      q="${BASH_REMATCH[4]}"
      if [[ "$q" =~ [^[:space:]] ]]; then
        text="$q"
        if on ask; then request ask "$text"; fi
      fi
    fi
    if on fallback; then remember User "$text"; fi
    ;;
  message.sent|error)
    on fallback || exit 0
    msg="${CC_HOOK_CONTENT:-}${CC_HOOK_ERROR:-}"
    # A limit notice is short; a long answer that happens to mention rate limits isn't one.
    if [ "${#msg}" -le 600 ] && [[ "$msg" =~ $limit_re ]]; then
      [ -s "$log" ] && request fallback "$(cat "$log")"
    elif [ "${CC_HOOK_EVENT}" = message.sent ]; then
      remember Agent "$msg"
    fi
    ;;
esac
exit 0
