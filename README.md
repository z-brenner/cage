# cage

Your coding agents on your own subscriptions, **each in its own microVM**, each reachable as a **Telegram bot**. The agents are Claude Code, Codex, Cursor and Antigravity (Google's successor to Gemini CLI).

cage builds almost nothing itself. It is about 450 lines of shell (the host CLI is under 300) that wires together two existing, actively maintained open-source projects:

| Need | Solved by | Why this one |
|---|---|---|
| Chat bot + drivers for the official agent CLIs: sessions, `/stop`, permission prompts, streaming progress, file send-back, cron, voice | **[cc-connect](https://github.com/chenhg5/cc-connect)** (MIT, Go, ~15.7k★, releases weekly) | The only project found that drives all four official CLIs headlessly on your own logins **and** speaks Telegram |
| One VM per agent, persistent volumes, egress policy that blocks host/LAN/cloud-metadata | **[microsandbox](https://github.com/superradcompany/microsandbox)** (Apache-2.0, ~8.5k★, released today) | The only open-source microVM runtime found that covers both Apple-Silicon Macs and Linux/KVM with a simple CLI |
| The agents themselves | the vendors' **unmodified official CLIs** | Terms of service (see below) |

What cage adds:
- one cc-connect config per agent, generated from a single env file
- first-boot provisioning inside each VM
- login flows that run inside the VM
- lifecycle commands (`up`, `login`, `status`, `logs`, `shell`, `update`, `down`, `destroy`)

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

## Quick start

Requirements: an Apple-Silicon Mac or a Linux box with KVM, [microsandbox](https://docs.microsandbox.dev), and one Telegram bot per agent.

```bash
curl -fsSL https://install.microsandbox.dev | sh      # macOS: brew install superradcompany/tap/microsandbox
git clone https://github.com/z-brenner/cage && cd cage

./cage init                  # writes ~/.cage/cage.env (0600)
$EDITOR ~/.cage/cage.env     # your Telegram user id + one @BotFather token per agent
./cage doctor
./cage up                    # one microVM per agent; each installs its CLI + cc-connect in the background (a few minutes)
./cage login claude          # then: codex, cursor, antigravity
./cage status
```

Then message the bots. Each chat has its own session. cc-connect's commands:

| Command | What it does |
|---|---|
| `/new` | start a fresh session |
| `/list`, `/switch` | list and switch sessions |
| `/stop` | cancel the current run |
| `/mode` | change permission mode |
| `/model` | switch model |
| `/usage` | quota |
| `/dir` | change work directory |
| `/help` | list commands |

**Fan-out ("ask all"):** put all your bots in one Telegram group and turn **Group Privacy off** for each (BotFather → Bot Settings → Group Privacy). Then @mention the bots you want in a single message. To have every bot answer every message in that group, set `CAGE_TELEGRAM_GROUP_REPLY_ALL=true`.

## Logins (inside each VM, on your subscriptions)

| Agent | `cage login` runs | Notes |
|---|---|---|
| claude | `claude auth login --claudeai` | Open the URL, paste the code back. |
| codex | `codex login --device-auth` | **First** enable device-code login for Codex in ChatGPT → Settings → Security. |
| cursor | `cursor-agent login` | Open the URL on any device; it completes on its own. |
| antigravity | `agy` | Sign in on first launch with your Google AI Pro/Ultra account, then quit. |

Logins live on each VM's named volume (`cage-<agent>-home`). They survive restarts, `cage update` and `cage destroy --keep-login`.

## Security model

- **One microVM per agent.** Agents run in "yolo" mode (no approval prompts) because the VM is the sandbox. A prompt-injected Codex can't touch your Mac, your SSH keys or Claude's login. Set `CAGE_MODE=ask` to approve each tool call in chat instead.
- **Network:** microsandbox's default policy. The public internet is allowed; your host, LAN, loopback and cloud-metadata endpoints are blocked. You can tighten this to a domain allowlist via `CAGE_MSB_EXTRA_ARGS` (`--net-rule`; see the [microsandbox networking docs](https://docs.microsandbox.dev/networking/overview.md)).
- **Only the allowlisted Telegram user ids** in `CAGE_TELEGRAM_ALLOW` can talk to the bots. They are also the only admins for cc-connect's privileged commands (`/shell`, `/dir`, `/restart`…).
- **Mounts:** the only host paths a VM sees, both read-only, are `guest/` (the provisioning scripts) and its own generated config.
- **Known gap: each bot's Telegram token lives inside that agent's VM.** An agent that gets prompt-injected could read it and impersonate its bot.
  - microsandbox's secret substitution can't cover this, because Telegram puts the token in the URL path.
  - cc-connect's `run_as_user` split could, but it supports only Claude Code today.
  - Mitigation: one bot per agent limits the blast radius. If you suspect a leak, rotate the token in BotFather.
- **Telegram is not end-to-end encrypted.** cc-connect also supports Matrix, Slack, Discord and others if you'd rather.

## Terms of service

The rule is the same across vendors: **the official CLI with your own login is fine; extracting its OAuth tokens or offering subscription login to others is not.** cage never reads or moves tokens. Each vendor's own binary logs in and runs inside your VM.

- **Anthropic** allows "an end user signing in to the unmodified Claude Code binary with their own Claude subscription". It bars third parties from offering claude.ai login or routing other users' requests through Pro/Max. Plan limits assume individual use. **Personal use only.**
- **OpenAI** supports ChatGPT sign-in with `codex exec`; its docs still call API keys the default for automation.
- **Google** retired Gemini CLI for AI Pro/Ultra subscribers on **2026-06-18** ([announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)); Antigravity CLI replaced it. Google has suspended accounts for using its CLI OAuth from third-party software. cc-connect runs the official `agy` binary, but if losing that Google account would hurt, use a separate one.
- **Cursor:** headless mode is documented. How API-key billing works is unclear; cage uses the normal login.

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

Compared with the first, hand-built version (branch `claude/cage-agent-vms`):
- **Pre-send PII redaction.** cc-connect has no message hook. The right fix is a small upstream PR adding a `message_filter` command hook, which is also where a Sonomos masker would plug in. I'd rather propose that upstream than maintain a fork.
- **A single `/all` command.** Replaced by group @mentions (above).
- **Lima/Firecracker/local backends.** Replaced by microsandbox.

## Development

```bash
shellcheck cage guest/*.sh test/*.sh
test/host.sh                    # ./cage against a stub msb: config rendering, validation, msb arguments, status, guards
CAGE_TEST_CC_CONNECT=/path/to/cc-connect test/host.sh   # plus: real cc-connect loads every generated config
test/guest-smoke.sh claude      # Docker stand-in for the VM: same image, mounts and entry script
test/microvm-e2e.sh claude      # REAL microVM via msb (KVM or Apple Silicon): provisioning, cc-connect user,
                                # login probe, egress policy, read-only mounts, persistence, destroy
```

CI (`.github/workflows/ci.yml`) runs:
- shellcheck
- the host tests under bash 5, and under bash 3.2 (what macOS ships)
- guest smoke tests for all four agents
- the real-microVM end-to-end test for all four agents, on KVM-enabled GitHub runners

Files:
- `cage`: the host CLI.
- `cage.env.example`: the config template.
- `guest/entry.sh`: each VM's main process. It creates the `agent` user, provisions on first boot with retries, and supervises cc-connect.
- `guest/provision.sh`: installs one agent CLI plus cc-connect, system-wide and idempotently.

**Not covered by automated tests:**
- Real subscription logins. They need your accounts, and tests should never hold them.
- The live Telegram API. It needs your bot tokens.

Those are the two steps you do once, by hand: `cage login <agent>`, then message the bot.
