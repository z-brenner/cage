#!/usr/bin/env bash
# Installs ONE agent CLI plus cc-connect into an Ubuntu 24.04 guest. Idempotent. Runs as root.
#   usage: provision.sh <claude|codex|cursor|antigravity> [--update | --node]
#   --node only makes sure Node.js 22 is there (for the WhatsApp adapter, on an already provisioned VM)
# Called by guest/entry.sh on first boot of each microsandbox VM (and by `cage update`).
# Vendor CLIs install system-wide (/opt/cage/tools, /usr/local/bin) so the agent's persistent home
# volume holds only its login and work, never binaries.
set -euo pipefail

KIND="${1:?usage: provision.sh <claude|codex|cursor|antigravity> [--update]}"
MODE="${2:-}"
CC_CONNECT_VERSION="${CC_CONNECT_VERSION:-v1.5.0}"
TOOLS=/opt/cage/tools
MARK="/opt/cage/provisioned-$KIND"
export DEBIAN_FRONTEND=noninteractive
APT=(apt-get -o DPkg::Lock::Timeout=600)

log() { echo "provision[$KIND]: $*"; }

[ "$(id -u)" = 0 ] || { echo "provision.sh must run as root" >&2; exit 1; }
case "$KIND" in claude|codex|cursor|antigravity) ;; *) echo "unknown agent kind: $KIND" >&2; exit 2 ;; esac
if [ -e "$MARK" ] && [ "$MODE" != "--update" ] && [ "$MODE" != "--node" ]; then
  log "already provisioned ($(cat "$MARK"))"
  exit 0
fi

base_packages() {
  log "base packages"
  "${APT[@]}" update -qq
  "${APT[@]}" install -y -qq --no-install-recommends \
    ca-certificates curl git jq ripgrep unzip xz-utils less procps util-linux sudo \
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
  local arch v
  case "$(uname -m)" in x86_64) arch=x64 ;; *) arch=arm64 ;; esac
  # Right after a Codex release, @latest can point at a version whose -linux-<arch> build isn't published yet;
  # npm then silently skips that optional dependency and `codex` crashes. Install the newest version whose
  # platform build exists instead.
  v="$(npm view @openai/codex versions --json 2>/dev/null | node -e '
    const vs = JSON.parse(require("fs").readFileSync(0, "utf8")), set = new Set(vs), arch = process.argv[1];
    const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
    const ok = vs.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && set.has(v + "-linux-" + arch)).sort(cmp);
    process.stdout.write(ok[ok.length - 1] || "");' "$arch" || true)"
  log "OpenAI Codex CLI ${v:-latest} (npm)"
  npm install -g --no-fund --no-audit "@openai/codex@${v:-latest}"
}

install_cursor() {
  log "Cursor CLI (vendor installer)"
  vendor_install 'curl -fsS https://cursor.com/install | bash'
  ln -sf "$TOOLS/.local/bin/cursor-agent" /usr/local/bin/cursor-agent
}

# Google retired Gemini CLI for AI Pro/Ultra subscribers on 2026-06-18; Antigravity CLI replaced it.
install_antigravity() {
  log "Antigravity CLI (vendor installer)"
  vendor_install 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
  ln -sf "$TOOLS/.local/bin/agy" /usr/local/bin/agy
}

install_cc_connect() {
  local arch os=linux
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; esac
  log "cc-connect $CC_CONNECT_VERSION"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/chenhg5/cc-connect/releases/download/$CC_CONNECT_VERSION/cc-connect-$CC_CONNECT_VERSION-$os-$arch.tar.gz" | tar -xz -C "$tmp"
  install -m 0755 "$(find "$tmp" -type f -name 'cc-connect*' | head -1)" /usr/local/bin/cc-connect
  rm -rf "$tmp"
}

guest_env() {
  # Sourced by guest/entry.sh before starting cc-connect. Non-secret defaults only.
  mkdir -p /etc/cage
  cat > /etc/cage/env <<'ENV'
# written by cage provision.sh
DISABLE_AUTOUPDATER=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV
  chmod 644 /etc/cage/env
  git config --system init.defaultBranch main
  git config --system user.name "$KIND (cage)"
  git config --system user.email "$KIND@cage.invalid"
}

if [ "$MODE" = "--node" ]; then node_22; exit 0; fi
if [ "$MODE" = "--update" ] && [ -e "$MARK" ]; then
  log "updating CLIs only"
else
  base_packages
fi
"install_$KIND"
# Extras some agents run next to their CLI: the WhatsApp adapter needs Node.js.
if [ -r /cage-config/whatsapp.env ]; then node_22; fi
install_cc_connect
guest_env
case "$KIND" in cursor) BIN=cursor-agent ;; antigravity) BIN=agy ;; *) BIN="$KIND" ;; esac
command -v "$BIN" >/dev/null || { echo "provision: $BIN is not on PATH after install" >&2; exit 1; }
# A wrapper on PATH isn't enough (npm can install a launcher without its platform binary): it must run.
"$BIN" --version >/dev/null 2>&1 || { echo "provision: $BIN is installed but does not run; will retry" >&2; exit 1; }
mkdir -p /opt/cage
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK"
log "done: $BIN $("$BIN" --version 2>/dev/null | head -1 || true); $(cc-connect --version 2>/dev/null | head -1)"
