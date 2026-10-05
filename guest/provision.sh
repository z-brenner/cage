#!/usr/bin/env bash
# Installs ONE agent CLI plus cc-connect into an Ubuntu 24.04 guest. Idempotent. Runs as root.
#   usage: provision.sh <claude|codex|cursor|antigravity> [--refresh | --node | --browser]
#   --refresh (from `cage update`) gets the newest of everything instead of what's cached
#   --node only makes sure Node.js 22 is there (for the WhatsApp adapter, on an already provisioned VM)
#   --browser sets up the browser's part (Playwright MCP, Chromium's libraries). guest/browser.sh runs it in the
#     background once cc-connect is up, so the browser's downloads never keep the agent offline.
# Called by guest/entry.sh at every boot of each microsandbox VM: the system disk is new each time.
# Everything it downloads (Ubuntu packages, Node.js, the agent's CLI, npm packages, cc-connect) is kept in a cache
# volume of this agent's own (/var/cache/cage), so waking up reinstalls from there in seconds, without asking any
# vendor's servers; only the first boot and `cage update` download.
# Every step that downloads has a time limit: a slow or stalled mirror becomes a failure that entry.sh retries (apt
# keeps what it already fetched), never a VM that waits forever. Each line has the time, and while a step runs, a
# line every minute says which one.
# Vendor CLIs install system-wide (/opt/cage/tools, /usr/local/bin) so the agent's persistent home
# volume holds only its login and work, never binaries.
set -Eeuo pipefail   # -E: the ERR trap below fires inside functions too

KIND="${1:?usage: provision.sh <claude|codex|cursor|antigravity> [--refresh | --node | --browser]}"
MODE="${2:-}"
CC_CONNECT_VERSION="${CC_CONNECT_VERSION:-v1.5.0}"
CACHE=/var/cache/cage
TOOLS=/opt/cage/tools
MARK="/opt/cage/provisioned-$KIND"
REFRESH=0
CACHED=0
export DEBIAN_FRONTEND=noninteractive
# dpkg keeps the current version of a changed config file instead of asking (nobody is there to answer)
APT=(apt-get -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
# Time limits for apt's downloads. Short on purpose: apt keeps what it fetched, even half a file, and entry.sh tries
# again soon, which beats waiting on one slow connection. CI once waited 20 minutes on a mirror that was slow but
# never quite stopped (apt's own timeout only notices silence).
APT_UPDATE_LIMIT="${CAGE_APT_UPDATE_LIMIT:-120}"
APT_FETCH_LIMIT="${CAGE_APT_FETCH_LIMIT:-300}"
[[ "$APT_UPDATE_LIMIT" =~ ^[0-9]+$ ]] || APT_UPDATE_LIMIT=120
[[ "$APT_FETCH_LIMIT" =~ ^[0-9]+$ ]] || APT_FETCH_LIMIT=300
SOURCES=/etc/apt/sources.list.d/ubuntu.sources
MIRRORS=/etc/apt/cage-mirrors.txt
STEP_FILE="/run/cage-step.$$"

log() { echo "provision[$KIND]: $* ($(date -u +%H:%M:%SZ))"; }
step() { # step <what>: logs the step; while it runs, the heartbeat repeats it once a minute
  log "$*"
  { printf '%s %s\n' "$(date +%s)" "$*" > "$STEP_FILE"; } 2>/dev/null || true
}
heartbeat() { # in the background: which step is still going, and for how long, so a slow one shows in the log
  local since what
  trap 'kill "$!" 2>/dev/null; exit 0' TERM   # its sleep goes with it
  while kill -0 "$$" 2>/dev/null; do
    sleep 60 & wait "$!"
    [ -r "$STEP_FILE" ] && read -r since what < "$STEP_FILE" || continue
    log "still on $what ($(( ($(date +%s) - since) / 60 )) min)"
  done
}

# cached: there's a cache to install from and this isn't `cage update`
cached() { [ "$CACHED" = 1 ] && [ "$REFRESH" = 0 ]; }
apt_cached() { cached && compgen -G "$CACHE/apt/lists/*_Packages*" >/dev/null; }   # and it has Ubuntu's lists

use_mirror() { # use_mirror <url>: Ubuntu's packages from that mirror (CAGE_APT_MIRROR), its own servers if it fails
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._/-]*$ ]] \
    || { log "CAGE_APT_MIRROR isn't a plain http(s) address; using Ubuntu's own servers"; return 0; }
  printf '%s\nhttp://archive.ubuntu.com/ubuntu/\n' "$1" > "$MIRRORS"
  # Only the main archive: security updates keep coming from security.ubuntu.com
  sed -i "s#^URIs: http://archive.ubuntu.com/ubuntu/\\?\$#URIs: mirror+file:$MIRRORS#" "$SOURCES"
  grep -q "^URIs: mirror+file:$MIRRORS\$" "$SOURCES" \
    || log "CAGE_APT_MIRROR: this system doesn't get its packages from archive.ubuntu.com, so it isn't used"
}

apt_install() { # apt_install <packages…>: from the cache if it has them all, else from Ubuntu; fails if that's too slow
  # Each step returns on failure itself: callers use apt_install as an `if` condition, where bash turns off set -e and
  # the ERR trap, so a step that ran out of time would otherwise carry on as if it had worked.
  if apt_cached && "${APT[@]}" install -y -qq --no-install-recommends --no-download "$@" >/dev/null 2>&1; then
    return 0
  fi
  timeout -k 30 "$APT_UPDATE_LIMIT" "${APT[@]}" update -qq \
    || { log "Ubuntu's package lists didn't arrive within ${APT_UPDATE_LIMIT}s"; return 1; }
  timeout -k 30 "$APT_FETCH_LIMIT" "${APT[@]}" install -y -qq --no-install-recommends --download-only "$@" >/dev/null \
    || { log "the downloads didn't finish within ${APT_FETCH_LIMIT}s (what arrived is kept for the next try)"; return 1; }
  # From what was just fetched, never the network, so it needs no time limit of its own
  "${APT[@]}" install -y -qq --no-install-recommends --no-download "$@" >/dev/null \
    || { log "couldn't install what was downloaded"; return 1; }
}

npm_install() { # npm_install <packages…>: global npm packages, under a time limit
  timeout -k 30 600 npm install -g --no-fund --no-audit --fetch-timeout=60000 --fetch-retries=3 "$@" </dev/null
}

link_npm_bins() { # global npm commands, from the cache's prefix onto PATH
  local b
  [ "$CACHED" = 1 ] || return 0
  for b in "$CACHE"/npm/bin/*; do [ -e "$b" ] && ln -sf "$b" "/usr/local/bin/$(basename "$b")"; done
  return 0
}

base_packages() {
  step "base packages$(apt_cached && echo ' (cached)')"
  apt_install ca-certificates curl git jq ripgrep unzip xz-utils less procps util-linux sudo \
    python3 python3-venv build-essential openssh-client tzdata
}

node_22() {
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
    return
  fi
  local f
  if cached && [ -s "$CACHE/nodesource/nodesource.sources" ]; then   # NodeSource's apt source, as its setup left it
    step "Node.js 22 (cached)"
    install -D -m 644 "$CACHE/nodesource/nodesource.gpg" /usr/share/keyrings/nodesource.gpg
    install -D -m 644 "$CACHE/nodesource/nodesource.sources" /etc/apt/sources.list.d/nodesource.sources
    for f in nodejs nsolid; do [ ! -f "$CACHE/nodesource/$f" ] || install -D -m 644 "$CACHE/nodesource/$f" "/etc/apt/preferences.d/$f"; done
  else
    step "Node.js 22 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    if [ "$CACHED" = 1 ]; then
      cp /usr/share/keyrings/nodesource.gpg /etc/apt/sources.list.d/nodesource.sources "$CACHE/nodesource/" 2>/dev/null || true
      for f in nodejs nsolid; do [ ! -f "/etc/apt/preferences.d/$f" ] || cp "/etc/apt/preferences.d/$f" "$CACHE/nodesource/"; done
    fi
  fi
  apt_install nodejs
}

# Runs a vendor installer that installs into $HOME, with HOME pointed at a shared, root-owned dir.
vendor_install() { # vendor_install <url> [installer args…]: a vendor's own install script, with its HOME in the tools folder
  local f rc=0
  mkdir -p "$TOOLS"
  f="$(mktemp)"
  # A CDN edge can serve its cached gzip copy whatever was asked for (seen in CI: bash got binary), so: --compressed
  # for a labelled one, gunzip by hand for an unlabelled one. Retries and time limits, so a stall can't hang the VM.
  curl -fsSL --compressed --retry 3 --connect-timeout 20 --max-time 300 -o "$f" "$1" || { rm -f "$f"; return 1; }
  if [ "$(head -c 2 "$f" | od -An -tx1 | tr -d ' \n')" = 1f8b ]; then gunzip -c < "$f" > "$f.sh"; mv "$f.sh" "$f"; fi
  HOME="$TOOLS" timeout -k 30 900 bash "$f" "${@:2}" </dev/null || rc=$?
  rm -f "$f"
  return "$rc"
}

install_claude() {
  if cached && [ -x "$TOOLS/.local/bin/claude" ]; then ln -sf "$(readlink -f "$TOOLS/.local/bin/claude")" /usr/local/bin/claude; return 0; fi
  if cached && [ -x "$CACHE/npm/bin/claude" ]; then node_22; link_npm_bins; return 0; fi
  step "Claude Code (native installer)"
  # Its stable channel: about a week behind the newest, skipping releases with known problems
  if vendor_install https://claude.ai/install.sh stable && [ -x "$TOOLS/.local/bin/claude" ]; then
    ln -sf "$(readlink -f "$TOOLS/.local/bin/claude")" /usr/local/bin/claude
  else
    log "native installer failed; falling back to npm"
    node_22
    npm_install @anthropic-ai/claude-code@latest
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
  v="$(timeout 60 npm view @openai/codex versions --json 2>/dev/null | node -e '
    const vs = JSON.parse(require("fs").readFileSync(0, "utf8")), set = new Set(vs), arch = process.argv[1];
    const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
    const ok = vs.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && set.has(v + "-linux-" + arch)).sort(cmp);
    process.stdout.write(ok[ok.length - 1] || "");' "$arch" || true)"
  step "OpenAI Codex CLI ${v:-latest} (npm)"
  npm_install "@openai/codex@${v:-latest}"
  link_npm_bins
}

install_cursor() {
  if ! { cached && [ -x "$TOOLS/.local/bin/cursor-agent" ]; }; then
    step "Cursor CLI (vendor installer)"
    vendor_install https://cursor.com/install
  fi
  ln -sf "$TOOLS/.local/bin/cursor-agent" /usr/local/bin/cursor-agent
}

# Google retired Gemini CLI for AI Pro/Ultra subscribers on 2026-06-18; Antigravity CLI replaced it.
install_antigravity() {
  if ! { cached && [ -x "$TOOLS/.local/bin/agy" ]; }; then
    step "Antigravity CLI (vendor installer)"
    vendor_install https://antigravity.google/cli/install.sh
  fi
  ln -sf "$TOOLS/.local/bin/agy" /usr/local/bin/agy
}

PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.83}"
BROWSER_WRAPPER=/usr/local/bin/cage-browser
BROWSER_READY=/opt/cage/browser-ready   # guest/browser.sh writes it at each boot, once the browser can start
BROWSER_WAIT=60

browser_wrapper() { # the browser connector's command, written at provisioning so the agent's CLI always finds it
  cat > "$BROWSER_WRAPPER" <<SH
#!/bin/sh
# The agent's web browser: Playwright MCP driving headless Chromium. Its profile (cookies, the sites it's signed
# in to) lives in ~/.cache/cage-browser, so it survives restarts. The VM is the sandbox, hence --no-sandbox.
# --no-webmcp: tools that a web page offers (WebMCP) never reach the agent; any page it visits could offer some.
# guest/browser.sh gets the browser ready after each boot, in the background; until then, the agent is told so.
i=0
until [ -e $BROWSER_READY ]; do
  if [ "\$i" -ge $BROWSER_WAIT ]; then
    echo "cage-browser: the browser is still being set up; try again in a few minutes" >&2
    exit 1
  fi
  i=\$((i + 1))
  sleep 1
done
export PLAYWRIGHT_BROWSERS_PATH=/home/agent/.cache/ms-playwright
exec node "\$(npm root -g)/@playwright/mcp/cli.js" --headless --no-sandbox --no-webmcp --browser chromium \\
  --user-data-dir /home/agent/.cache/cage-browser --output-dir /home/agent/.cache/cage-browser-files "\$@"
SH
  chmod 755 "$BROWSER_WRAPPER"
}

browser_libs() { # browser_libs <Playwright's cli.js>: Chromium's system libraries, plus certutil for guest/browser.sh
  # Playwright says which libraries are missing. It could install them too, but it runs apt with no time limit, so
  # only its --dry-run is used, and apt_install does the rest (from the cache, within its limits).
  local out rc=0 deps
  out="$(timeout 60 node "$1" install-deps --dry-run chromium 2>&1)" || rc=$?
  if grep -q '^All system dependencies are installed' <<<"$out"; then
    deps=""
  elif grep -q '^Missing system dependencies' <<<"$out" &&
      deps="$(sed -n 's/^ \{2,\}\([a-z0-9][a-z0-9.+-]*\)$/\1/p' <<<"$out")" && [ -n "$deps" ]; then
    # The browser always runs headless: no X server, and none of the X server's own fonts
    deps="libnss3-tools $(grep -vxE 'xvfb|xfonts-cyrillic|xfonts-scalable' <<<"$deps" | tr '\n' ' ' || true)"
  elif [ "$rc" = 0 ]; then
    log "Playwright listed none of Chromium's libraries: $(tail -n 3 <<<"$out" | tr '\n' ' ')"
    deps=""
  else
    log "Playwright couldn't say which of Chromium's libraries are missing (exit $rc):"
    tail -n 20 <<<"$out" | sed 's/^/  /'
    return 1
  fi
  if ! command -v certutil >/dev/null 2>&1 && [[ " $deps " != *" libnss3-tools "* ]]; then deps="libnss3-tools $deps"; fi
  [ -n "${deps// /}" ] || return 0
  # shellcheck disable=SC2086  # a list of package names
  apt_install $deps
}

install_browser() { # the browser's part of the system (provision.sh --browser); Chromium itself is guest/browser.sh's
  node_22
  step "browser (Playwright MCP $PLAYWRIGHT_MCP_VERSION, Chromium's libraries)"
  if ! { cached && [ "$(cat "$CACHE/npm/.playwright-mcp" 2>/dev/null)" = "$PLAYWRIGHT_MCP_VERSION" ]; }; then
    npm_install "@playwright/mcp@$PLAYWRIGHT_MCP_VERSION" >/dev/null
    [ "$CACHED" = 0 ] || echo "$PLAYWRIGHT_MCP_VERSION" > "$CACHE/npm/.playwright-mcp"
  fi
  link_npm_bins
  local cli
  cli="$(find "$(npm root -g)/@playwright/mcp" -path '*/node_modules/playwright/cli.js' | head -n 1)"
  [ -n "$cli" ] || { log "Playwright MCP is installed without its playwright/cli.js"; return 1; }
  browser_libs "$cli"
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

if [ "${CAGE_PROVISION_LIB:-}" = 1 ]; then return 0; fi   # test/provision-unit.sh: just the functions above

[ "$(id -u)" = 0 ] || { echo "provision.sh must run as root" >&2; exit 1; }
case "$KIND" in claude|codex|cursor|antigravity) ;; *) echo "unknown agent kind: $KIND" >&2; exit 2 ;; esac
case "$MODE" in ''|--refresh|--node|--browser) ;; *) echo "unknown option: $MODE" >&2; exit 2 ;; esac
exec </dev/null   # nothing here may wait for an answer: no one would see the question
trap 'log "failed at line $LINENO: $BASH_COMMAND"' ERR   # so a failure is never silent
if [ -e "$MARK" ] && [ -z "$MODE" ]; then
  log "already provisioned ($(cat "$MARK"))"
  exit 0
fi

[ "$MODE" = --refresh ] && REFRESH=1
# Every apt-get retries, and gives up on a connection that has gone silent; our own also have the time limits above,
# so a mirror that is merely slow can't hold things up either.
printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80cage-net
if [ -n "${CAGE_APT_MIRROR:-}" ]; then use_mirror "$CAGE_APT_MIRROR"; fi
if [ -d "$CACHE" ] && touch "$CACHE/.w" 2>/dev/null; then   # the cache volume (older cage: none, download as before)
  CACHED=1
  rm -f "$CACHE/.w"
  TOOLS="$CACHE/tools"
  mkdir -p "$CACHE/apt/archives/partial" "$CACHE/apt/lists/partial" "$CACHE/npm" "$CACHE/nodesource" "$TOOLS"
  # every apt-get (ours, NodeSource's, and Playwright's dry run) keeps its package lists and downloads in the cache
  printf 'Dir::Cache::archives "%s/apt/archives";\nDir::State::lists "%s/apt/lists";\nAPT::Keep-Downloaded-Packages "true";\n' \
    "$CACHE" "$CACHE" > /etc/apt/apt.conf.d/90cage-cache
  mkdir -p /usr/etc   # npm's global config: /usr/etc/npmrc for NodeSource's npm, /etc/npmrc for others
  printf 'prefix=%s/npm\n' "$CACHE" | tee /etc/npmrc > /usr/etc/npmrc   # global npm packages live in the cache too
fi

heartbeat &
HEARTBEAT=$!
trap 'kill "$HEARTBEAT" 2>/dev/null; rm -f "$STEP_FILE"' EXIT
# entry.sh's time limit can stop provisioning in the middle of dpkg; apt won't go on until that's finished
if [ -n "$(ls -A /var/lib/dpkg/updates 2>/dev/null)" ]; then
  step "finishing an install that was cut short"
  dpkg --force-confdef --force-confold --configure -a >/dev/null
fi

case "$MODE" in
  --node) node_22; exit 0 ;;
  --browser) install_browser; log "browser: done"; exit 0 ;;
esac
base_packages
if [ "$REFRESH" = 1 ]; then log "cage update: the newest of everything"; fi
"install_$KIND"
# Node.js for the app's chat (guest/app.sh, always there) and WhatsApp: installed here, where entry.sh retries until it
# works, so the adapters never depend on a single try of their own.
if [ -r /cage-config/app.env ] || [ -r /cage-config/whatsapp.env ]; then node_22; fi
# The browser itself is set up after cc-connect starts (guest/browser.sh); its command is here from the start
if grep -q '^browser|local:browser|' /cage-config/connectors.list 2>/dev/null; then browser_wrapper; fi
install_cc_connect
guest_env
case "$KIND" in cursor) BIN=cursor-agent ;; antigravity) BIN=agy ;; *) BIN="$KIND" ;; esac
command -v "$BIN" >/dev/null || { echo "provision: $BIN is not on PATH after install" >&2; exit 1; }
# A wrapper on PATH isn't enough (npm can install a launcher without its platform binary): it must run.
timeout 60 "$BIN" --version >/dev/null 2>&1 || { echo "provision: $BIN is installed but does not run; will retry" >&2; exit 1; }
mkdir -p /opt/cage
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK"
log "done: $BIN $(timeout 60 "$BIN" --version 2>/dev/null | head -1 || true); $(cc-connect --version 2>/dev/null | head -1)"
