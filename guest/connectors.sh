#!/bin/bash
# Wires the user's connectors (apps, as remote MCP servers) into this VM's agent CLI. Runs as root at every boot,
# after guest/entry.sh has written /etc/cage/runtime.env.
#   /cage-config/connectors.list   name|url|header|secret name, one per line (from `cage connect`; never a key)
# A connector's key is a microsandbox secret: this VM only holds a placeholder (like $MSB_ZAPIER_MCP_TOKEN), which
# is what goes into the config files. microsandbox swaps in the real key on the way to the app's own host.
# Only servers cage added are ever changed or removed: their names are kept in ~/.config/cage/connectors.
set -euo pipefail

KIND="${1:?usage: connectors.sh <agent>}"
U=agent
H=/home/agent
LIST=/cage-config/connectors.list
STATE="$H/.config/cage/connectors"
log() { echo "cage-connectors[$KIND]: $*"; }

set -a
# shellcheck disable=SC1091
[ -r /etc/cage/runtime.env ] && . /etc/cage/runtime.env
set +a

# servers: {name: {url, headers}} for each connector whose key (if it has one) reached this VM
servers='{}'
names=""
while IFS='|' read -r name url header secret; do
  if ! [[ "$name" =~ ^[a-z][a-z0-9-]*$ && "$url" == https://* ]]; then continue; fi
  headers='{}'
  if [ -n "$secret" ]; then
    if ! [[ "$secret" =~ ^[A-Z][A-Z0-9_]*$ && "$header" =~ ^[A-Za-z][A-Za-z0-9-]*$ ]]; then continue; fi
    ph="${!secret:-}"
    if [ -z "$ph" ]; then log "$name: its key isn't in this VM (cage up again?); skipped"; continue; fi
    [ "$header" = Authorization ] && ph="Bearer $ph"
    headers="$(jq -cn --arg h "$header" --arg v "$ph" '{($h): $v}')"
  fi
  servers="$(jq -c --arg n "$name" --arg u "$url" --argjson h "$headers" '.[$n] = {url: $u, headers: $h}' <<<"$servers")"
  names="$names$name "
done < <(cat "$LIST" 2>/dev/null || true)

old="$(cat "$STATE" 2>/dev/null || true)"
[ -n "$names" ] || [ -n "$old" ] || exit 0
old_json="$(printf '%s\n' "$old" | jq -R . | jq -sc 'map(select(length > 0))')"

drop() { servers="$(jq -c --arg n "$1" 'del(.[$n])' <<<"$servers")"; }   # drop <name>: leave it out

# json_servers <file> <jq: a server as stored above -> as this CLI wants it>: replaces cage's entries in .mcpServers
json_servers() {
  local f="$1" tmp cur n
  if [ -s "$f" ]; then cur="$(jq -c . "$f" 2>/dev/null)" || { log "couldn't read $f as JSON, so left it alone"; return 0; }
  else cur='{}'; fi
  for n in $(jq -r --argjson old "$old_json" '(.mcpServers // {}) | keys[] | select(IN($old[]) | not)' <<<"$cur"); do
    if jq -e --arg n "$n" 'has($n)' <<<"$servers" >/dev/null; then log "$n: you set it up yourself in $f, so cage left it alone"; drop "$n"; fi
  done
  tmp="$(mktemp)"
  jq --argjson s "$servers" --argjson old "$old_json" "
      .mcpServers = ((.mcpServers // {}) | with_entries(select(.key | IN(\$old[]) | not))) + (\$s | map_values($2))" \
    <<<"$cur" > "$tmp"
  install -m 600 -o "$U" -g "$U" "$tmp" "$f"
  rm -f "$tmp"
}

# Codex keeps its settings in TOML: cage's servers live in one marked block at the end of config.toml.
codex_servers() {
  local f="$H/.codex/config.toml" tmp n begin="# >>> cage connectors" end="# <<< cage connectors"
  tmp="$(mktemp)"
  if [ -f "$f" ]; then
    if grep -qxF "$begin" "$f" && ! grep -qxF "$end" "$f"; then
      log "the cage block in $f is damaged, so left it alone"; rm -f "$tmp"; return 0
    fi
    awk -v b="$begin" -v e="$end" '$0 == b {skip = 1} !skip {print} $0 == e {skip = 0}' "$f" > "$tmp"
    if [ -s "$tmp" ] && [ -n "$(tail -c 1 "$tmp")" ]; then echo >> "$tmp"; fi
  fi
  for n in $(jq -r 'keys[]' <<<"$servers"); do   # a server the user defined themselves wins
    if grep -qE "^\[mcp_servers\.(\"?)$n\1\]" "$tmp"; then log "$n: you set it up yourself in $f, so cage left it alone"; drop "$n"; fi
  done
  if [ "$servers" != '{}' ]; then
    { echo "$begin"
      echo "# rewritten at every boot: use \`cage connect\` on your computer instead of editing these"
      jq -r 'to_entries[] | "[mcp_servers.\(.key | @json)]", "url = \(.value.url | @json)",
        (select(.value.headers | length > 0)
          | "http_headers = { " + ([.value.headers | to_entries[] | "\(.key | @json) = \(.value | @json)"] | join(", ")) + " }")' \
        <<<"$servers"
      echo "$end"; } >> "$tmp"
  fi
  install -m 600 -o "$U" -g "$U" "$tmp" "$f"
  rm -f "$tmp"
}
runuser -u "$U" -- mkdir -p "$H/.config/cage" "$H/.codex" "$H/.cursor" "$H/.gemini/config"
case "$KIND" in
  claude) json_servers "$H/.claude.json" '{type: "http", url: .url, headers: .headers}' ;;
  codex) codex_servers ;;
  cursor) json_servers "$H/.cursor/mcp.json" '{url: .url, headers: .headers}' ;;
  antigravity) json_servers "$H/.gemini/config/mcp_config.json" '{serverUrl: .url, headers: .headers}' ;;
esac
# Remember what cage added (not the user's own servers it skipped), so the next boot can take it out again.
added="$(jq -r 'keys_unsorted[]' <<<"$servers")"
printf '%s\n' "$added" > "$STATE"
chown "$U:$U" "$STATE"
log "connected: ${added//$'\n'/ }"
