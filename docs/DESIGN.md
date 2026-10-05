# How cage is built

cage builds almost nothing itself. It is a few hundred lines of shell that wire together two existing, actively maintained open-source projects:

| Need | Solved by | Why this one |
|---|---|---|
| Chat bot + drivers for the official agent CLIs: sessions, `/stop`, permission prompts, streaming progress, file send-back, cron, voice | **[cc-connect](https://github.com/chenhg5/cc-connect)** (MIT, Go, ~15.7k★, releases weekly) | The only project found that drives all four official CLIs headlessly on your own logins **and** speaks Telegram |
| One VM per agent, persistent volumes, egress policy that blocks host/LAN/cloud-metadata | **[microsandbox](https://github.com/superradcompany/microsandbox)** (Apache-2.0, ~8.5k★, released today) | The only open-source microVM runtime found that covers both Apple-Silicon Macs and Linux/KVM with a simple CLI |
| The agents themselves | the vendors' **unmodified official CLIs** | Terms of service (see the README) |
| Keys the agents can use but never see | **microsandbox secrets** | The VM holds a placeholder; the real key is swapped in outside the VM, only for hosts you allow |
| Website sign-ins | **microsandbox secrets** with a custom placeholder and request-body substitution, plus **[Playwright MCP](https://github.com/microsoft/playwright-mcp)** as the agents' browser | The agent types a placeholder; the real password is swapped in only on the way to that site |
| Apps you sign in to in the browser (Notion, Jira, Sentry…) | the standard MCP sign-in (OAuth 2.1: RFC 9728 discovery, dynamic client registration, PKCE), done **on the host** by host/mcp_oauth.py | The refresh token never leaves your computer; the access token is a microsandbox secret, renewed by `cage _refresh` and swapped into running VMs with `msb modify` |
| Apps (Gmail, Calendar, Slack, GitHub…) | **remote MCP servers**, wired into each CLI's own config; **[Zapier MCP](https://mcp.zapier.com)** for most apps | Every CLI speaks MCP. Zapier handles the browser sign-ins for thousands of apps and gives back one key, which a microsandbox secret protects |

What cage adds:
- one cc-connect config per agent, generated from a single env file
- first-boot provisioning inside each VM
- login flows that run inside the VM
- lifecycle commands (`up`, `login`, `status`, `logs`, `shell`, `update`, `down`, `destroy`)
- releases: a reproducible tarball per tag with `SHA256SUMS` (checked by `install.sh` and `cage update`) and a signed build-provenance attestation, so installers never install an unreviewed `main`
- an optional deny-by-default network per agent (`cage network strict`: msb `network.allow` built from the agent's service, chat apps, installers, connectors, key hosts and `cage allow`; `strict: false` because the chat apps and vendor hosts bypass TLS interception and must match by SNI), and security events collected from msb's runtime log (secret violations, and DNS/egress denials, which msb logs at debug level, so strict VMs run with `--log-level debug`) before each re-create and every minute
- a relay for `/all` and quota stand-ins: cc-connect hooks are notify-only and VMs can't reach each other, so `guest/hook.sh` (a `[[hooks]]` command, data in `CC_HOOK_*` env vars) leaves requests in a per-VM outbox mount, and the host helper asks the other agents' CLIs (`msb exec`, read-only flags) and posts answers with `cc-connect send --stdin`
- voice notes: cc-connect's `[speech]` with its OpenAI provider pointed at `guest/stt.py` (faster-whisper) on the VM's loopback, and the static ffmpeg from `imageio-ffmpeg`, both cached on the home volume; or Groq with the key as a microsandbox secret
- an optional privacy mask: `guest/mask.py` becomes the agent's `cmd` in cc-connect and masks the prompt wherever that CLI takes it (Claude Code's stream-json stdin, `codex exec -` stdin, the argument after `--` or `-p`), unmasking JSON-line or text output; regexes with checksums (Luhn, IBAN mod-97), plus user terms, with one token map per VM
- a local web app (`cage ui`, the Start menu or app menu): `host/ui/server.py` (standard library) serves a vanilla-JS page and runs cage itself in a pseudo-terminal for every action. With `CAGE_PROTO=<a new code for each job>`, cage's messages, links, QR codes and questions are JSON lines marked with that code, so each flow is one code path for terminal and browser, and what a VM prints (it never learns the code) can't pass for one of cage's questions; vendor screens (sign-ins, logs) go to an xterm.js view. 127.0.0.1 only, Host, Origin and Sec-Fetch-Site checks, a token from `~/.cage/ui.token` that the page gets for a one-time pairing code from `cage ui` (so it's never in an address), `cage ui` checking the web app proves it has that token before opening anything, a whitelist of commands and their arguments' shapes, a strict CSP
- fast, vendor-independent wake-ups: each VM gets a second named volume, `/var/cache/cage`, that keeps apt's lists and packages, NodeSource's apt source, the vendor CLI, global npm packages and cc-connect, so a re-created VM reinstalls offline; `cage update` passes `CAGE_REFRESH=1` for fresh downloads. (msb snapshots can't be used: `msb snap restore` takes no env, secrets, TLS settings or command.)
- encrypted backups (`cage backup` / `cage restore`): `~/.cage` plus each agent's home volume, with the in-VM owners and modes microsandbox keeps in `user.*` xattrs

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

Compared with the first, hand-built version (branch `claude/cage-agent-vms`):
- **Pre-send PII redaction.** cc-connect has no message hook. The right fix is a small upstream PR adding a `message_filter` command hook, which is also where a Sonomos masker would plug in. I'd rather propose that upstream than maintain a fork.
- **A single `/all` command.** Replaced by group @mentions (above).
- **Lima/Firecracker/local backends.** Replaced by microsandbox.

