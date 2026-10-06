#!/usr/bin/env bash
# Installs ONE agent CLI plus cc-connect into an Ubuntu 24.04 guest. Idempotent. Runs as root.
#   usage: provision.sh <claude|codex|cursor|antigravity> [--refresh | --node | --browser]
#   --refresh (from `cage update`) gets the newest versions instead of what's cached (Claude Code: its stable release)
#   --node only makes sure Node.js 22 is there (for the WhatsApp adapter, on an already provisioned VM)
#   --browser sets up the browser's part (Playwright MCP, Chromium's libraries). guest/browser.sh runs it in the
#     background once cc-connect is up, so the browser's downloads never keep the agent offline.
# Called by guest/entry.sh at every boot of each microsandbox VM: the system disk is new each time.
# Everything it downloads (Ubuntu packages, Node.js, the agent's CLI, npm packages, cc-connect) is kept in a cache
# volume of this agent's own (/var/cache/cage), so waking up reinstalls from there in seconds, without asking any
# vendor's servers; only the first boot and `cage update` download.
# Every step that downloads has a time limit: a slow or stalled mirror becomes a failure that entry.sh retries (apt
# keeps what it already fetched), never a VM that waits forever. The limits grow with each try, so a slow connection
# still gets there. Each line has the time, and while a step runs, a line every minute says which one.
# Vendor CLIs install system-wide (/opt/cage/tools, /usr/local/bin) so the agent's persistent home
# volume holds only its login and work, never binaries.
set -Eeuo pipefail   # -E: the ERR trap below fires inside functions too

KIND="${1:?usage: provision.sh <claude|codex|cursor|antigravity> [--refresh | --node | --browser]}"
MODE="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC_CONNECT_VERSION="${CC_CONNECT_VERSION:-v1.5.1-beta.3}"
CACHE=/var/cache/cage
TOOLS=/opt/cage/tools
MARK="/opt/cage/provisioned-$KIND"
CONFIG=/cage-config   # from cage up: which chat apps and connectors this agent has
# Which try this is (entry.sh and guest/browser.sh count them, from 1). Every time limit below grows with it, up to 8
# times as long: a download that can't pick up where it stopped (a vendor's installer, npm, Chromium) then still
# finishes on a slow connection, a few tries in, and one that has stalled is still stopped.
ATTEMPT="${CAGE_PROVISION_ATTEMPT:-1}"
case "$ATTEMPT" in [1-8]) ;; *[!0-9]*|''|0*) ATTEMPT=1 ;; *) ATTEMPT=8 ;; esac
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
limit() { echo $(( $1 * ATTEMPT )); }   # limit <seconds>: a time limit, for this try
step() { # step <what>: logs the step; while it runs, the heartbeat repeats it once a minute
  log "$*"
  { printf '%s %s\n' "$(date +%s)" "$*" > "$STEP_FILE"; } 2>/dev/null || true
}
heartbeat() { # in the background: which step is still going, and for how long, so a slow one shows in the log
  local since what took
  trap 'kill "$!" 2>/dev/null; exit 0' TERM   # its sleep goes with it
  while kill -0 "$$" 2>/dev/null; do
    sleep 60 & wait "$!"
    [ -r "$STEP_FILE" ] && read -r since what < "$STEP_FILE" || continue
    took=$(( $(date +%s) - since ))
    [ "$took" -lt 60 ] || log "still on $what ($((took / 60)) min)"   # a step that just started isn't news
  done
}

# cached: there's a cache to install from and this isn't `cage update`
cached() { [ "$CACHED" = 1 ] && [ "$REFRESH" = 0 ]; }
apt_cached() { cached && compgen -G "$CACHE/apt/lists/*_Packages*" >/dev/null; }   # and it has Ubuntu's lists

use_mirror() { # use_mirror <url>: Ubuntu's packages from that mirror (CAGE_APT_MIRROR), its own servers if it fails
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._/-]*$ ]] \
    || { log "CAGE_APT_MIRROR isn't a plain http(s) address; using Ubuntu's own servers"; return 0; }
  [ -f "$SOURCES" ] || { log "CAGE_APT_MIRROR: this system doesn't get its packages from archive.ubuntu.com, so it isn't used"; return 0; }
  printf '%s\nhttp://archive.ubuntu.com/ubuntu/\n' "$1" > "$MIRRORS"
  # Only the main archive: security updates keep coming from security.ubuntu.com
  sed -i "s#^URIs: http://archive.ubuntu.com/ubuntu/\\?\$#URIs: mirror+file:$MIRRORS#" "$SOURCES"
  grep -q "^URIs: mirror+file:$MIRRORS\$" "$SOURCES" \
    || log "CAGE_APT_MIRROR: this system doesn't get its packages from archive.ubuntu.com, so it isn't used"
}

apt_install() { # apt_install <packages…>: from the cache if it has them all, else from Ubuntu; fails if that's too slow
  # Each step returns on failure itself: callers use apt_install as an `if` condition, where bash turns off set -e and
  # the ERR trap, so a step that ran out of time would otherwise carry on as if it had worked.
  local lists fetch
  if apt_cached && "${APT[@]}" install -y -qq --no-install-recommends --no-download "$@" >/dev/null 2>&1; then
    return 0
  fi
  lists="$(limit "$APT_UPDATE_LIMIT")" fetch="$(limit "$APT_FETCH_LIMIT")"
  timeout -k 30 "$lists" "${APT[@]}" update -qq \
    || { log "Ubuntu's package lists didn't arrive within ${lists}s"; return 1; }
  timeout -k 30 "$fetch" "${APT[@]}" install -y -qq --no-install-recommends --download-only "$@" >/dev/null \
    || { log "the downloads didn't finish within ${fetch}s (what arrived is kept for the next try)"; return 1; }
  # From what was just fetched, never the network, so it needs no time limit of its own
  "${APT[@]}" install -y -qq --no-install-recommends --no-download "$@" >/dev/null \
    || { log "couldn't install what was downloaded"; return 1; }
}

npm_install() { # npm_install <packages…>: global npm packages, under a time limit
  timeout -k 30 "$(limit 600)" npm install -g --no-fund --no-audit --fetch-timeout=60000 --fetch-retries=3 "$@" </dev/null
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
  step "Node.js 22$(cached && compgen -G "$CACHE/apt/archives/nodejs_*.deb" >/dev/null && echo ' (cached)' || echo ' (NodeSource)')"
  # NodeSource's apt repository, set up the way its setup_22.x script does it, but with NodeSource's signing key kept
  # next to this script (nodesource-repo.asc, fingerprint 6F71F525282841EEDAF851B42F59B5F99B1BE0B4) instead of
  # running a script from the internet as root. A cache from before keeps working: same repository, same lists.
  install -D -m 644 "$HERE/nodesource-repo.asc" /usr/share/keyrings/nodesource-repo.asc
  printf 'Types: deb\nURIs: https://deb.nodesource.com/node_22.x\nSuites: nodistro\nComponents: main\nArchitectures: %s\nSigned-By: /usr/share/keyrings/nodesource-repo.asc\n' \
    "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/nodesource.sources
  for f in nodejs nsolid; do   # NodeSource's packages over Ubuntu's older nodejs
    printf 'Package: %s\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' "$f" > "/etc/apt/preferences.d/$f"
  done
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
  HOME="$TOOLS" timeout -k 30 "$(limit 900)" bash "$f" "${@:2}" </dev/null || rc=$?
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
# Seconds cage-browser waits for it. Only a few: the agents' CLIs wait for their tools before they answer, and give up
# on one that takes longer than theirs to start (Codex: 10 s), and then the agent never sees the message below.
BROWSER_WAIT=5

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

CC_CONNECT_RELEASES=https://github.com/chenhg5/cc-connect/releases/download
CC_CONNECT_BIN=/usr/local/bin/cc-connect
# A new cc-connect version needs both of its lines here, from that release's checksums.txt.
cc_connect_sha256() { # cc_connect_sha256 <version> <arch> [binary]: the SHA-256 of that release's tarball (or of the
  # cc-connect binary inside it, which older cage kept in the cache), as published
  case "$1-$2${3:+-$3}" in
    v1.5.0-amd64) echo 72859035a1ee011b710204fc508de711838f919eb2ae6f104f1ddb3e5cd8ca87 ;;
    v1.5.0-amd64-binary) echo 695afce0c9e1391bd733ce4a05284d568df9b0d74b2c86fa807b566164bd820a ;;
    v1.5.0-arm64) echo 360916e64c81714b4b295905b7aa95a62d3b5bfba0fb306f29a4560224d07ca3 ;;
    v1.5.0-arm64-binary) echo dd0c52a71cac49687f778ddbdafc46bac9c917e900524dad5dffe745745dabf4 ;;
    v1.5.1-beta.3-amd64) echo 4c969474d9e971395f36842646ef42a519557e90e0fee4eba128a4ba786ac21a ;;
    v1.5.1-beta.3-amd64-binary) echo e8ce20b9c1639db477c758d0ce6d96d24bc7a19d55744830a5b3b37a95d7a445 ;;
    v1.5.1-beta.3-arm64) echo bf723db0df33177bfafae4a2e4e91f4f0d17579a0273f358f137913fd680d83c ;;
    v1.5.1-beta.3-arm64-binary) echo dfc1cf17779c3f9fe151502e509b89d96f02abaeeeb341cf3004382bc9bacf6f ;;
    *) return 1 ;;
  esac
}
sha256_is() { [ -n "$1" ] && [ "$(sha256sum "$2" 2>/dev/null | cut -d' ' -f1)" = "$1" ]; }   # sha256_is <hash> <file>

# cc-connect holds the chat apps' tokens and runs every turn, so its download is checked against the SHA-256 kept
# above. The copy in the cache is checked again before each use, since the cache is the VM's to write; nothing in the
# VM can change the SHA-256 above. A version that isn't listed there is checked against its release's checksums.txt,
# which the cache keeps too, so that only catches a damaged copy; `cage update` asks the release again.
install_cc_connect() {
  local arch name want pinned=1 tmp f old
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) log "unsupported arch $(uname -m)"; return 1 ;; esac
  name="cc-connect-$CC_CONNECT_VERSION-linux-$arch.tar.gz"
  old="$CACHE/cc-connect-$CC_CONNECT_VERSION-linux-$arch"   # what older cage kept: the binary
  tmp="$(mktemp -d)"
  f="$tmp/$name"
  [ "$CACHED" = 0 ] || f="$CACHE/$name"
  if ! want="$(cc_connect_sha256 "$CC_CONNECT_VERSION" "$arch")"; then
    pinned=0
    want=""
    if cached; then want="$(cat "$f.sha256" 2>/dev/null || true)"; fi
  fi
  if ! { [ -s "$f" ] && sha256_is "$want" "$f"; }; then
    # The binary an older cage kept is just as good when it's the published one: waking up still needs no network
    if [ "$CACHED" = 1 ] && sha256_is "$(cc_connect_sha256 "$CC_CONNECT_VERSION" "$arch" binary || true)" "$old"; then
      install -m 0755 "$old" "$CC_CONNECT_BIN"
      rm -rf "$tmp"
      return 0
    fi
    step "cc-connect $CC_CONNECT_VERSION"
    if [ "$pinned" = 0 ]; then
      # A version cage hasn't checked itself: the release's own list catches a broken download, but not a changed
      # release, since it comes from the same place.
      log "no checksum kept for cc-connect $CC_CONNECT_VERSION; checking it against the release's checksums.txt (a weaker check)"
      want="$(curl -fsSL --retry 3 --retry-all-errors --connect-timeout 20 --max-time 60 \
        "$CC_CONNECT_RELEASES/$CC_CONNECT_VERSION/checksums.txt" | awk -v n="$name" '$2 == n { print $1; exit }')" || want=""
      [ -n "$want" ] || { log "couldn't get cc-connect $CC_CONNECT_VERSION's checksums.txt"; rm -rf "$tmp"; return 1; }
    fi
    curl -fsSL --retry 3 --retry-all-errors --connect-timeout 20 --max-time "$(limit 300)" -o "$f.part" \
      "$CC_CONNECT_RELEASES/$CC_CONNECT_VERSION/$name" || { log "couldn't download cc-connect"; rm -rf "$f.part" "$tmp"; return 1; }
    if ! sha256_is "$want" "$f.part"; then
      log "cc-connect's download doesn't match its checksum; not using it"
      rm -rf "$f.part" "$tmp"
      return 1
    fi
    mv "$f.part" "$f"
    if [ "$CACHED" = 1 ]; then
      if [ "$pinned" = 0 ]; then echo "$want" > "$f.sha256"; fi
      rm -f "$old"
    fi
  fi
  mkdir "$tmp/x"
  tar -xzf "$f" -C "$tmp/x" && install -m 0755 "$(find "$tmp/x" -type f -name 'cc-connect*' | head -n 1)" "$CC_CONNECT_BIN" \
    || { log "couldn't unpack cc-connect"; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

# Node.js for WhatsApp and the app's chat (guest/app.sh, always there), installed here, where entry.sh retries until it
# works. Only WhatsApp waits for it, as it always has: an agent whose CLI doesn't need Node.js still starts when
# NodeSource can't be reached, and guest/app.sh keeps trying on its own.
adapters_node() {
  if [ -r "$CONFIG/whatsapp.env" ]; then
    node_22
  elif [ -r "$CONFIG/app.env" ]; then
    node_22 || log "the app's chat needs Node.js; it starts once Node.js can be installed"
  fi
}

DPKG_UPDATES=/var/lib/dpkg/updates
finish_dpkg() { # entry.sh's time limit can stop provisioning in the middle of dpkg; apt won't go on until that's finished
  [ -n "$(ls -A "$DPKG_UPDATES" 2>/dev/null)" ] || return 0
  step "finishing an install that was cut short"
  dpkg --force-confdef --force-confold --configure -a >/dev/null
}

mark_provisioned() { # the CLI must run; then "done", and last of all the mark that says provisioning has finished
  local bin v
  case "$KIND" in cursor) bin=cursor-agent ;; antigravity) bin=agy ;; *) bin="$KIND" ;; esac
  command -v "$bin" >/dev/null || { echo "provision: $bin is not on PATH after install" >&2; exit 1; }
  # A wrapper on PATH isn't enough (npm can install a launcher without its platform binary): it must run.
  v="$(timeout 60 "$bin" --version 2>/dev/null)" || { echo "provision: $bin is installed but does not run; will retry" >&2; exit 1; }
  log "done: $bin $(head -n 1 <<<"$v"); $(cc-connect --version 2>/dev/null | head -n 1 || true)"
  # Nothing after this: `cage status` and the tests take the mark to mean provisioning has finished
  mkdir -p "$(dirname "$MARK")"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARK"
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
  mkdir -p "$CACHE/apt/archives/partial" "$CACHE/apt/lists/partial" "$CACHE/npm" "$TOOLS"
  # every apt-get (ours, and Playwright's dry run) keeps its package lists and downloads in the cache
  printf 'Dir::Cache::archives "%s/apt/archives";\nDir::State::lists "%s/apt/lists";\nAPT::Keep-Downloaded-Packages "true";\n' \
    "$CACHE" "$CACHE" > /etc/apt/apt.conf.d/90cage-cache
  mkdir -p /usr/etc   # npm's global config: /usr/etc/npmrc for NodeSource's npm, /etc/npmrc for others
  printf 'prefix=%s/npm\n' "$CACHE" | tee /etc/npmrc > /usr/etc/npmrc   # global npm packages live in the cache too
fi

heartbeat &
HEARTBEAT=$!
trap 'kill "$HEARTBEAT" 2>/dev/null; rm -f "$STEP_FILE"' EXIT
finish_dpkg

case "$MODE" in
  --node) node_22; exit 0 ;;
  --browser) install_browser; log "browser: done"; exit 0 ;;
esac
base_packages
if [ "$REFRESH" = 1 ]; then
  log "cage update: the newest versions$([ "$KIND" != claude ] || echo " (Claude Code's stable release, about a week behind its newest)")"
fi
"install_$KIND"
adapters_node
# The browser itself is set up after cc-connect starts (guest/browser.sh); its command is here from the start
if grep -q '^browser|local:browser|' "$CONFIG/connectors.list" 2>/dev/null; then browser_wrapper; fi
install_cc_connect
guest_env
mark_provisioned
