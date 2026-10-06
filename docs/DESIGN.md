# How cage is built

cage builds as little as it can itself. It is a bash command (`cage`), a small web app (Python's standard library and plain JavaScript) and the scripts that set up each VM, and they wire together two existing, actively maintained open-source projects:

| Need | Solved by | Why this one |
|---|---|---|
| Chat bot + drivers for the official agent CLIs: sessions, `/stop`, permission prompts, streaming progress, file send-back, cron, voice | **[cc-connect](https://github.com/chenhg5/cc-connect)** (MIT, Go, ~15.7k★, releases weekly) | The only project found that drives all four official CLIs headlessly on your own logins **and** speaks Telegram |
| One VM per agent, persistent volumes, egress policy that blocks host/LAN/cloud-metadata | **[microsandbox](https://github.com/superradcompany/microsandbox)** (Apache-2.0, ~8.5k★, a new release every few days) | The only open-source microVM runtime found that covers both Apple-Silicon Macs and Linux/KVM with a simple CLI |
| The agents themselves | the vendors' **unmodified official CLIs** | Terms of service (see the README) |
| Keys the agents can use but never see | **microsandbox secrets** | The VM holds a placeholder; the real key is swapped in outside the VM, only for hosts you allow |
| Website sign-ins | **microsandbox secrets** with a custom placeholder and request-body substitution, plus **[Playwright MCP](https://github.com/microsoft/playwright-mcp)** as the agents' browser | The agent types a placeholder; the real password is swapped in only on the way to that site |
| Apps you sign in to in the browser (Notion, Jira, Sentry…) | the standard MCP sign-in (OAuth 2.1: RFC 9728 discovery, dynamic client registration, PKCE), done **on the host** by host/mcp_oauth.py | The refresh token never leaves your computer; the access token is a microsandbox secret, renewed by `cage _refresh` and swapped into running VMs with `msb modify` |
| Apps (Gmail, Calendar, Slack, GitHub…) | **remote MCP servers**, wired into each CLI's own config; **[Zapier MCP](https://mcp.zapier.com)** for most apps | Every CLI speaks MCP. Zapier handles the browser sign-ins for thousands of apps and gives back one key, which a microsandbox secret protects |

cage pins one release of each (`CAGE_MSB_VERSION` and load_env's `CAGE_CC_CONNECT_VERSION` in `cage`), and moves a pin only with green real-microVM tests (see [Releasing](#releasing)).

What cage adds:
- one cc-connect config per agent, generated from a single env file (with `reset_on_idle_mins = 0`, so a chat never resets on its own)
- first-boot provisioning inside each VM, where every download has a time limit that grows with each try, and cc-connect is checked against its pinned SHA-256 before every use (a cached copy too)
- login flows that run inside the VM
- lifecycle commands (`up`, `restart`, `login`, `status`, `logs`, `shell`, `update`, `rollback`, `down`, `remove`, `destroy`, `uninstall`)
- releases: a reproducible tarball per tag (file modes and dates fixed, built twice and compared) with `SHA256SUMS` and a signed build-provenance attestation. A release waits for CI to pass on its commit and takes its notes from `CHANGELOG.md`.
- safe updates: `install.sh` checks a release against its `SHA256SUMS`, unpacks it next to the installed one and moves the files in, `VERSION` last. Offline it changes nothing (exit 3), an update cut off halfway is finished by the next run (exit 4), it never moves to an older release unless asked (`cage update --to`) and never swaps a release for a git checkout of main. It keeps the last two releases in `~/.cage/releases`, for `cage rollback` (checked again, no download).
- microsandbox at the version cage is tested with: `scripts/install-msb.sh` runs microsandbox's own installer with its version lookup replaced by the pin (no anonymous GitHub API call), and `cage up` refuses one older than `MSB_MIN`
- an optional deny-by-default network per agent (`cage network strict`: msb `network.allow` built from the agent's service, chat apps, installers, connectors, key hosts and `cage allow`; `strict: false` because the chat apps and vendor hosts bypass TLS interception and must match by SNI), and security events collected from msb's runtime log (secret violations, and DNS/egress denials, which msb logs at debug level, so strict VMs run with `--log-level debug`) before each re-create and every minute
- a relay for `/all` and quota stand-ins: cc-connect hooks are notify-only and VMs can't reach each other, so `guest/hook.sh` (a `[[hooks]]` command, data in `CC_HOOK_*` env vars) leaves requests in a per-VM outbox mount, and the host helper asks the other agents' CLIs (`msb exec`, read-only flags, the question in a file in the VM's read-only `/cage-config` rather than on a command line) and posts answers with `cc-connect send --stdin`
- voice notes: cc-connect's `[speech]` with its OpenAI provider pointed at `guest/stt.py` (faster-whisper) on the VM's loopback, and the static ffmpeg from `imageio-ffmpeg`, both cached on the home volume; or Groq with the key as a microsandbox secret
- an optional privacy mask, as the agent's `cmd` in cc-connect. cc-connect has no hook that can change a message (its hooks only notify), so `guest/mask.py` runs the CLI itself: it masks the prompt wherever that CLI takes it (Claude Code's stream-json stdin, your answers to its questions included, while tools you approve run with the placeholders the model wrote; `codex exec -` stdin; the argument after `--` or `-p`), refuses to run a CLI whose prompt it can't find, and unmasks JSON-line or text output, holding back a placeholder split across chunks. Detection is a span engine with validated detectors (Luhn and card networks, IBAN mod-97, many key formats) plus your terms; placeholders typed into the chat are made inert, so they can't call up a real value; one token map per VM, its tokens allocated under a lock and forgotten after 90 days unused or on `cage mask forget`. `guest/memory.sh` masks About me and the notes' names with the same map, and `/all`, stand-ins and `cage ask` run the asked CLI behind the mask when either side has it on, after putting your terms as they are now in that VM's copy (as root; if that fails, the CLI doesn't run), since the VM's own setup puts them there only after provisioning, and only when it wakes. What the CLI reads with its tools (files, pages, app results) never passes through it.
- a local web app (`cage ui`, the Start menu or app menu): `host/ui/server.py` (standard library) serves a vanilla-JS page and runs cage itself in a pseudo-terminal for every setting and command. Chats, scheduled tasks (cc-connect's cron API), the work folder (listing, downloads, uploads) and plan usage (`/usage`, in a conversation of its own) go through each agent's chat folder instead, to `guest/app.mjs` in the VM, and from there to cc-connect's bridge or its API: Home reads the end of each chat log (read like the rest of that folder: no links, plain files only) for an agent waiting for your OK and what each one is doing. An answer to one, from Home or from its card in the chat, goes with the approval it answers, and only while the agent still waits for that one; Home offers Allow only when its one line shows every field of the request. With `CAGE_PROTO=<a new code for each job>`, cage's messages, links, QR codes and questions are JSON lines marked with that code, so each flow is one code path for terminal and browser, and what a VM prints (it never learns the code) can't pass for one of cage's questions; vendor screens (sign-ins, logs) go to an xterm.js view. 127.0.0.1 only, Host, Origin and Sec-Fetch-Site checks, a token from `~/.cage/ui.token` that the page gets for a one-time pairing code from `cage ui` (so it's never in an address), `cage ui` checking the web app proves it has that token before opening anything, a whitelist of commands and their arguments' shapes, a strict CSP
- host folders a VM can write (its chat folder, memory inbox and outbox) treated as hostile: links in them are never followed, text from them reaches the terminal without control codes, and each has a size limit (msb's `quota=`, with `nosuid,nodev`)
- fast, vendor-independent wake-ups: each VM gets a second named volume, `/var/cache/cage`, that keeps apt's lists and packages, NodeSource's apt source (rebuilt by `guest/provision.sh` from the signing key in `guest/nodesource-repo.asc`, instead of running NodeSource's setup script as root), the vendor CLI (Claude Code from its stable channel), global npm packages and cc-connect, so a re-created VM reinstalls offline; `cage update` passes `CAGE_REFRESH=1` for fresh downloads, and still wakes the agent from the cache if those fail. The optional browser is set up in the background after cc-connect starts (`guest/browser.sh`). (msb snapshots can't be used: `msb snap restore` takes no env, secrets, TLS settings or command.)
- encrypted backups (`cage backup` / `cage restore`): `~/.cage` plus each agent's home volume, with the in-VM owners and modes microsandbox keeps in `user.*` xattrs, each checked right after it's written

```
 Telegram (you)                                  host: ./cage → msb (microsandbox CLI)
   @dot_claude  ─────long-poll────▶  ┌─ microVM cage-claude ─────────────────────────┐
   @dot_codex                        │  cc-connect ──▶ claude   (your Claude login)   │
   @dot_cursor                       │  /home/agent = named volume: login, sessions,  │
   @dot_antigravity                  │                work; survives restarts         │
   group: @mention several bots      └────────────────────────────────────────────────┘
          → fan-out                  … the same shape once per agent
                                     egress: public internet only (host, LAN, loopback,
                                             cloud metadata blocked)
```


## Alternatives considered

The research behind this design, as of 2026-09-30:

| Project | Verdict |
|---|---|
| **OpenClaw** (+ acpx) | Massive and fast-moving; Telegram/Signal/WhatsApp. But its ACP agents "run on the host runtime, not inside the sandbox", and Anthropic singled out its harness in its April 2026 billing change. |
| **Happy / Happier** | Excellent end-to-end-encrypted mobile/web clients for Claude/Codex/Cursor over your own logins, with multi-machine support. No Telegram and no fan-out. The best choice if you prefer an app over a bot: run its daemon inside each microVM instead of cc-connect. |
| **takopi / Untether** | Clean Python Telegram bridge, but no Cursor, and takopi is quiet since May. |
| **vibe-kanban**, **coder/agentapi**, **Crystal**, **Terragon**, **vibekit** | Sunsetting, archived, deprecated or stale. |
| **Kimaki**, **sandbox-agent** | ToS-risky auth: OpenCode advertising itself as Claude Code, and pulling credentials out of local configs. |
| **Docker Sandboxes (`sbx`)** | Polished microVMs for agents, but proprietary and needs a Docker account. |
| **Apple `container`** | macOS 26 only; no egress allowlist and no automation API beyond its CLI. |
| **smolvm** | A close second to microsandbox (also libkrun). |
| **matchlock** | Uses Firecracker on Linux, but it's young and built for ephemeral sandboxes. |
| **E2B self-host**, **Kata**, **flintlock** | Linux-only or heavy infrastructure. |
| **Lima** | Full VMs, no egress policy, SSH-only. |
| **Raw Firecracker** | What the first version of this repo hand-rolled (rootfs builds, TAP/iptables, guest init, SSH). microsandbox replaces all of it. |
| **ACP** (Agent Client Protocol, v1 stable; native in Cursor, Gemini, Copilot; adapters for Claude, Codex) | The right protocol for normalizing agents. cc-connect already speaks it, so cage doesn't have to. |

## Not in this version

- **Masking what the agent reads.** The mask sees only what reaches the CLI as a prompt: files and pictures you send, web pages, notes the agent opens and your apps' results reach the vendor as they are. Claude Code's hooks can now rewrite tool output (PostToolUse), which could cover that for Claude.
- **A separate user for the mask.** Its token map and your terms are in the agent's own VM, readable by the agent, so a prompt injection that tells it to look can find the real values. Placeholders that last one conversation, instead of one map per VM, would also stop someone in the chat from asking for a value back.
- **Codex asking first.** cc-connect's `codex exec` backend has no way to ask, so with approve on Codex runs read-only. Its `app_server` backend can ask, but speaks JSON-RPC, which the mask doesn't handle yet.
- **Keeping the agent out of its own chat.** The chat relay in each VM (`guest/app.mjs`) runs as the agent's own user, so an agent that can run commands can also write to its chat folder, and so to what the app shows. Asking first is a check for mistakes, not a wall.
- **Bot tokens outside the VM.** Each chat app's token lives in its agent's VM. cc-connect's `run_as_user` could keep it from the agent, but supports only Claude Code.
- **An end-to-end-encrypted phone channel.** Telegram, Slack and Discord aren't. cc-connect supports Matrix, which cage doesn't set up yet.
- **macOS.** microsandbox runs on Apple Silicon and cage has its launchd and GNU tar parts, but the installer is Linux-only and nothing runs on a Mac in CI.

## Releasing

1. **CHANGELOG.md first.** On main, add the release's section, `## v0.5.0 (2026-11-02)`, in the product's plain voice: New, Changed, Fixed, After updating, Known issues (see the top of CHANGELOG.md). The release stops without it.
2. **Recheck what Anthropic says about headless use** ([Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)), and update the README's Terms of service and its date if it changed.
3. **Move the microsandbox and cc-connect pins only in a pull request whose real-microVM e2e is green for all four agents**, and in a commit of their own, so it can be reverted alone. microsandbox: `CAGE_MSB_VERSION` and `MSB_MIN` in `cage`. cc-connect: load_env's default in `cage`, `guest/provision.sh`'s default and its checksums (tarball and binary, amd64 and arm64), and the download and checksum in `.github/workflows/ci.yml`. `test/pins.sh` checks they all agree. (`SHIPPED_CC_CONNECT` lists only versions earlier cages wrote into cage.env; a new pin doesn't go there. `STABLE_CC_CONNECT` is what `CAGE_CC_CONNECT_VERSION=stable` picks, the way back from a preview: when a newer stable cc-connect gets its checksums in `guest/provision.sh`, move it there too. `test/pins.sh` checks it's a stable release with both checksums.)
4. **CI green on main's commit.** If a job failed only by chance, re-run it.
5. **Release:** push the tag `v0.5.0` on main, or run the release workflow on main with that version. It waits for CI on that commit, builds twice and compares, attests, and publishes with the notes from CHANGELOG.md.
6. **Afterwards:** `gh attestation verify cage-v0.5.0.tar.gz --repo z-brenner/cage`, and a `cage update` from the release before.
