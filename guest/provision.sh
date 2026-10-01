#!/usr/bin/env bash
# Installs ONE agent CLI plus cc-connect into an Ubuntu 24.04 guest. Idempotent. Runs as root.
#   usage: provision.sh <claude|codex|cursor|antigravity> [--update | --refresh | --node]
#   --node only makes sure Node.js 22 is there (for the WhatsApp adapter, on an already provisioned VM)
#   --refresh (from `cage update`) gets the newest of everything instead of what's cached
# Called by guest/entry.sh at every boot of each microsandbox VM: the system disk is new each time.
# Everything it downloads (Ubuntu packages, Node.js, the agent's CLI, npm packages, cc-connect) is kept in a cache
# volume of this agent's own (/var/cache/cage), so waking up reinstalls from there in seconds, without asking any
# vendor's servers; only the first boot and `cage update` download.
# Vendor CLIs install system-wide (/opt/cage/tools, /usr/local/bin) so the agent's persistent home
# volume holds only its login and work, never binaries.
set -Eeuo pipefail   # -E: the ERR trap below fires inside functions too

KIND="${1:?usage: provision.sh <claude|codex|cursor|antigravity> [--update]}"
MODE="${2:-}"
CC_CONNECT_VERSION="${CC_CONNECT_VERSION:-v1.5.0}"
CACHE=/var/cache/cage
TOOLS=/opt/cage/tools
MARK="/opt/cage/provisioned-$KIND"
export DEBIAN_FRONTEND=noninteractive
APT=(apt-get -o DPkg::Lock::Timeout=600)
# A stalled connection to a mirror can leave apt waiting for good (seen in CI, stuck at "base packages"): every apt-get
# (ours, NodeSource's, Playwright's) retries and times out reads, and ours fetch under a hard time limit, so a stall
# becomes a failure that entry.sh retries. Installing what was fetched is local and is never cut short.
printf 'Acquire::Retries "3";\nAcquire::http::Timeout "60";\nAcquire::https::Timeout "60";\n' > /etc/apt/apt.conf.d/80cage-net
REFRESH=0
[ "$MODE" = --refresh ] && REFRESH=1
CACHED=0
if [ -d "$CACHE" ] && touch "$CACHE/.w" 2>/dev/null; then   # the cache volume (older cage: none, download as before)
  CACHED=1
  rm -f "$CACHE/.w"
  TOOLS="$CACHE/tools"
  mkdir -p "$CACHE/apt/archives/partial" "$CACHE/apt/lists/partial" "$CACHE/npm" "$CACHE/nodesource" "$TOOLS"
  # every apt-get (ours, NodeSource's, Playwright's) keeps its package lists and downloads in the cache
  printf 'Dir::Cache::archives "%s/apt/archives";\nDir::State::lists "%s/apt/lists";\nAPT::Keep-Downloaded-Packages "true";\n' \
    "$CACHE" "$CACHE" > /etc/apt/apt.conf.d/90cage-cache
  mkdir -p /usr/etc   # npm's global config: /usr/etc/npmrc for NodeSource's npm, /etc/npmrc for others
  printf 'prefix=%s/npm\n' "$CACHE" | tee /etc/npmrc > /usr/etc/npmrc   # global npm packages live in the cache too
fi

log() { echo "provision[$KIND]: $*"; }
trap 'log "failed at line $LINENO: $BASH_COMMAND"' ERR   # so a failure is never silent

[ "$(id -u)" = 0 ] || { echo "provision.sh must run as root" >&2; exit 1; }
case "$KIND" in claude|codex|cursor|antigravity) ;; *) echo "unknown agent kind: $KIND" >&2; exit 2 ;; esac
if [ -e "$MARK" ] && [ "$MODE" != "--update" ] && [ "$MODE" != "--refresh" ] && [ "$MODE" != "--node" ]; then
  log "already provisioned ($(cat "$MARK"))"
  exit 0
fi

# cached: there's a cache to install from and this isn't `cage update`
cached() { [ "$CACHED" = 1 ] && [ "$REFRESH" = 0 ]; }
apt_cached() { cached && compgen -G "$CACHE/apt/lists/*_Packages*" >/dev/null; }   # and it has Ubuntu's lists

apt_install() { # apt_install <packages…>: from the cache if it has them all, else from Ubuntu
  if apt_cached && "${APT[@]}" install -y -qq --no-install-recommends --no-download "$@" >/dev/null 2>&1; then
    return 0
  fi
  timeout -k 30 600 "${APT[@]}" update -qq
  timeout -k 30 1500 "${APT[@]}" install -y -qq --no-install-recommends --download-only "$@" >/dev/null
  "${APT[@]}" install -y -qq --no-install-recommends "$@" >/dev/null
}

link_npm_bins() { # global npm commands, from the cache's prefix onto PATH
  local b
  [ "$CACHED" = 1 ] || return 0
  for b in "$CACHE"/npm/bin/*; do [ -e "$b" ] && ln -sf "$b" "/usr/local/bin/$(basename "$b")"; done
  return 0
}

base_packages() {
  log "base packages$(apt_cached && echo ' (cached)')"
  apt_install ca-certificates curl git jq ripgrep unzip xz-utils less procps util-linux sudo \
    python3 python3-venv build-essential openssh-client tzdata
}

node_22() {
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
    return
  fi
  local f
  if cached && [ -s "$CACHE/nodesource/nodesource.sources" ]; then   # NodeSource's apt source, as its setup left it
    log "Node.js 22 (cached)"
    install -D -m 644 "$CACHE/nodesource/nodesource.gpg" /usr/share/keyrings/nodesource.gpg
    install -D -m 644 "$CACHE/nodesource/nodesource.sources" /etc/apt/sources.list.d/nodesource.sources
    for f in nodejs nsolid; do [ ! -f "$CACHE/nodesource/$f" ] || install -D -m 644 "$CACHE/nodesource/$f" "/etc/apt/preferences.d/$f"; done
  else
    log "Node.js 22 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    if [ "$CACHED" = 1 ]; then
      cp /usr/share/keyrings/nodesource.gpg /etc/apt/sources.list.d/nodesource.sources "$CACHE/nodesource/" 2>/dev/null || true
      for f in nodejs nsolid; do [ ! -f "/etc/apt/preferences.d/$f" ] || cp "/etc/apt/preferences.d/$f" "$CACHE/nodesource/"; done
    fi
  fi
  apt_install nodejs
}

# Runs a vendor installer that installs into $HOME, with HOME pointed at a shared, root-owned dir.
vendor_install() {
  mkdir -p "$TOOLS"
  HOME="$TOOLS" bash -c "$1"
}

install_claude() {
  if cached && [ -x "$TOOLS/.local/bin/claude" ]; then ln -sf "$(readlink -f "$TOOLS/.local/bin/claude")" /usr/local/bin/claude; return 0; fi
  if cached && [ -x "$CACHE/npm/bin/claude" ]; then node_22; link_npm_bins; return 0; fi
  log "Claude Code (native installer)"
  if vendor_install 'curl -fsSL https://claude.ai/install.sh | bash' && [ -x "$TOOLS/.local/bin/claude" ]; then
    ln -sf "$(readlink -f "$TOOLS/.local/bin/claude")" /usr/local/bin/claude
  else
    log "native installer failed; falling back to npm"
    node_22
    npm install -g --no-fund --no-audit @anthropic-ai/claude-code@latest
    link_npm_bins
  fi
}

install_codex() {
  node_22
  if cached && [ -x "$CACHE/npm/bin/codex" ]; then link_npm_bins; return 0; fi
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
  link_npm_bins
}

install_cursor() {
  if ! { cached && [ -x "$TOOLS/.local/bin/cursor-agent" ]; }; then
    log "Cursor CLI (vendor installer)"
    vendor_install 'curl -fsS https://cursor.com/install | bash'
  fi
  ln -sf "$TOOLS/.local/bin/cursor-agent" /usr/local/bin/cursor-agent
}

# Google retired Gemini CLI for AI Pro/Ultra subscribers on 2026-06-18; Antigravity CLI replaced it.
install_antigravity() {
  if ! { cached && [ -x "$TOOLS/.local/bin/agy" ]; }; then
    log "Antigravity CLI (vendor installer)"
    vendor_install 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
  fi
  ln -sf "$TOOLS/.local/bin/agy" /usr/local/bin/agy
}

PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.83}"
install_browser() {
  node_22
  log "browser (Playwright MCP $PLAYWRIGHT_MCP_VERSION, Chromium's libraries)"
  if ! { cached && [ "$(cat "$CACHE/npm/.playwright-mcp" 2>/dev/null)" = "$PLAYWRIGHT_MCP_VERSION" ]; }; then
    npm install -g --no-fund --no-audit "@playwright/mcp@$PLAYWRIGHT_MCP_VERSION" >/dev/null
    [ "$CACHED" = 0 ] || echo "$PLAYWRIGHT_MCP_VERSION" > "$CACHE/npm/.playwright-mcp"
  fi
  link_npm_bins
  local cli deps
  cli="$(find "$(npm root -g)/@playwright/mcp" -path '*/node_modules/playwright/cli.js' | head -n 1)"
  # Chromium's system libraries: the packages Playwright says are missing (it exits 1 when some are), through
  # apt_install, so from the cache. Older Playwrights print the apt-get command instead.
  deps="$( { node "$cli" install-deps --dry-run chromium 2>&1 || true; } |
    sed -n -e 's/^ \{2,\}\([a-z0-9][a-z0-9.+-]*\)$/\1/p' -e 's/.*apt-get install -y --no-install-recommends \([^"]*\).*/\1/p' |
    tr '\n' ' ')"
  # shellcheck disable=SC2086  # a list of package names
  if [ -n "$deps" ] && apt_install libnss3-tools $deps; then
    :
  else
    apt_install libnss3-tools
    node "$cli" install-deps chromium >/dev/null
  fi
  cat > /usr/local/bin/cage-browser <<'SH'
#!/bin/sh
# The agent's web browser: Playwright MCP driving headless Chromium. Its profile (cookies, the sites it's signed
# in to) lives in ~/.cache/cage-browser, so it survives restarts. The VM is the sandbox, hence --no-sandbox.
export PLAYWRIGHT_BROWSERS_PATH=/home/agent/.cache/ms-playwright
exec node "$(npm root -g)/@playwright/mcp/cli.js" --headless --no-sandbox --browser chromium \
  --user-data-dir /home/agent/.cache/cage-browser --output-dir /home/agent/.cache/cage-browser-files "$@"
SH
  chmod 755 /usr/local/bin/cage-browser
}

install_cc_connect() {
  local arch os=linux
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; esac
  local bin="$CACHE/cc-connect-$CC_CONNECT_VERSION-$os-$arch"
  if [ "$CACHED" = 1 ] && [ -x "$bin" ]; then install -m 0755 "$bin" /usr/local/bin/cc-connect; return 0; fi
  log "cc-connect $CC_CONNECT_VERSION"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/chenhg5/cc-connect/releases/download/$CC_CONNECT_VERSION/cc-connect-$CC_CONNECT_VERSION-$os-$arch.tar.gz" | tar -xz -C "$tmp"
  install -m 0755 "$(find "$tmp" -type f -name 'cc-connect*' | head -1)" /usr/local/bin/cc-connect
  [ "$CACHED" = 0 ] || install -m 0755 /usr/local/bin/cc-connect "$bin"
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
if [ "$REFRESH" = 1 ]; then log "cage update: the newest of everything"; fi
"install_$KIND"
# Extras some agents run next to their CLI: the WhatsApp adapter needs Node.js; the browser, Node.js and Chromium's
# system libraries (the browser itself downloads once into the home volume: guest/browser.sh).
if [ -r /cage-config/whatsapp.env ]; then node_22; fi
if grep -q '^browser|local:browser|' /cage-config/connectors.list 2>/dev/null; then install_browser; fi
install_cc_connect
guest_env
case "$KIND" in cursor) BIN=cursor-agent ;; antigravity) BIN=agy ;; *) BIN="$KIND" ;; esac
command -v "$BIN" >/dev/null || { echo "provision: $BIN is not on PATH after install" >&2; exit 1; }
# A wrapper on PATH isn't enough (npm can install a launcher without its platform binary): it must run.
"$BIN" --version >/dev/null 2>&1 || { echo "provision: $BIN is installed but does not run; will retry" >&2; exit 1; }
mkdir -p /opt/cage
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK"
log "done: $BIN $("$BIN" --version 2>/dev/null | head -1 || true); $(cc-connect --version 2>/dev/null | head -1)"
