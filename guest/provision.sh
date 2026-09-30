#!/usr/bin/env bash
# Installs ONE agent CLI into an Ubuntu 24.04 guest. Idempotent. Runs as root.
#   usage: provision.sh <claude|codex|gemini|cursor> [--update]
# Lima: `cage up` pipes this over SSH into `sudo bash -s`.
# Firecracker: baked into the rootfs by images/Dockerfile.
# CLIs are installed system-wide (/usr/local/bin, /opt/cage/tools) so the agent's writable home
# (where its login lives) never has to contain binaries.
set -euo pipefail

KIND="${1:?usage: provision.sh <claude|codex|gemini|cursor> [--update]}"
MODE="${2:-}"
TOOLS=/opt/cage/tools
MARK="/opt/cage/provisioned-$KIND"
export DEBIAN_FRONTEND=noninteractive

log() { echo "provision[$KIND]: $*"; }

[ "$(id -u)" = 0 ] || { echo "provision.sh must run as root" >&2; exit 1; }
case "$KIND" in claude|codex|gemini|cursor) ;; *) echo "unknown agent kind: $KIND" >&2; exit 2 ;; esac
if [ -e "$MARK" ] && [ "$MODE" != "--update" ]; then
  log "already provisioned ($(cat "$MARK")); use --update to reinstall"
  exit 0
fi

APT=(apt-get -o DPkg::Lock::Timeout=600)

base_packages() {
  # First boot of a cloud image: let cloud-init finish so apt isn't locked mid-upgrade.
  if command -v cloud-init >/dev/null 2>&1; then
    log "waiting for cloud-init"
    cloud-init status --wait >/dev/null 2>&1 || true
  fi
  log "base packages"
  "${APT[@]}" update -qq
  "${APT[@]}" install -y -qq --no-install-recommends \
    ca-certificates curl git jq ripgrep unzip xz-utils less procps util-linux \
    python3 python3-venv build-essential openssh-client >/dev/null
}

node_22() {
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
    return
  fi
  log "Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  "${APT[@]}" install -y -qq nodejs >/dev/null
}

# Runs a vendor installer that installs into $HOME, with HOME pointed at a shared, root-owned dir.
vendor_install() {
  mkdir -p "$TOOLS"
  HOME="$TOOLS" bash -c "$1"
}

install_claude() {
  log "Claude Code (native installer)"
  if vendor_install 'curl -fsSL https://claude.ai/install.sh | bash' && [ -x "$TOOLS/.local/bin/claude" ]; then
    ln -sf "$(readlink -f "$TOOLS/.local/bin/claude")" /usr/local/bin/claude
  else
    log "native installer failed; falling back to npm"
    node_22
    npm install -g --no-fund --no-audit @anthropic-ai/claude-code@latest
  fi
}

install_codex() {
  node_22
  log "OpenAI Codex CLI (npm)"
  npm install -g --no-fund --no-audit @openai/codex@latest
}

install_gemini() {
  node_22
  log "Gemini CLI (npm)"
  npm install -g --no-fund --no-audit @google/gemini-cli@latest
  # System settings override user settings: no self-updates, no usage stats.
  # Auth type is chosen via GOOGLE_GENAI_USE_GCA in /etc/cage/env instead, so an API key can still override it.
  mkdir -p /etc/gemini-cli
  cat > /etc/gemini-cli/settings.json <<'JSON'
{
  "general": { "enableAutoUpdate": false, "enableAutoUpdateNotification": false },
  "privacy": { "usageStatisticsEnabled": false }
}
JSON
}

install_cursor() {
  log "Cursor CLI (vendor installer)"
  vendor_install 'curl -fsS https://cursor.com/install | bash'
  ln -sf "$TOOLS/.local/bin/cursor-agent" /usr/local/bin/cursor-agent
}

guest_env() {
  # Sourced by every cage command in the guest (see src/remote.ts). Secrets go in ~/.cagevm/env instead.
  mkdir -p /etc/cage
  cat > /etc/cage/env <<'ENV'
# written by cage provision.sh — non-secret defaults for agent CLIs
DISABLE_AUTOUPDATER=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
GOOGLE_GENAI_USE_GCA=true
GEMINI_CLI_TRUST_WORKSPACE=true
ENV
  chmod 644 /etc/cage/env
  git config --system init.defaultBranch main
  git config --system user.name "$KIND (cage)"
  git config --system user.email "$KIND@cage.invalid"
}

if [ "$MODE" = "--update" ] && [ -e "$MARK" ]; then
  log "updating CLI only"
else
  base_packages
fi
"install_$KIND"
guest_env
BIN="$KIND"
[ "$KIND" = cursor ] && BIN=cursor-agent
command -v "$BIN" >/dev/null || { echo "provision: $BIN is not on PATH after install" >&2; exit 1; }
mkdir -p /opt/cage
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK"
log "done: $(command -v "$BIN") ($("$BIN" --version 2>/dev/null | head -1 || true))"
