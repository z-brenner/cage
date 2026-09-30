# cage

Your own multi-agent bot. It drives **Claude Code**, **OpenAI Codex**, **Gemini CLI** and **Cursor Agent** on your existing subscriptions (Claude Pro/Max login, "Sign in with ChatGPT", Login with Google, Cursor account). You talk to it from Telegram or the terminal. **Every agent runs in its own VM.**

```
   Telegram ("Dot")          terminal
          │                     │
          ▼                     ▼
 ┌───────────────── host: cage ─────────────────────┐
 │  router → redactor (opt.) → orchestrator         │
 │  sessions per chat · cancel · timeouts           │
 └─────┬────────────┬─────────────┬────────────┬────┘
       │ ssh        │ ssh         │ ssh        │ ssh      prompt on stdin, never argv
 ┌─────▼─────┐ ┌────▼──────┐ ┌────▼──────┐ ┌───▼───────┐
 │cage-claude│ │cage-codex │ │cage-gemini│ │cage-cursor│  one VM each (Lima or Firecracker)
 │ claude -p │ │codex exec │ │ gemini -p │ │cursor-    │  full autonomy inside the VM
 │ Max login │ │ ChatGPT   │ │ Google AI │ │agent -p   │  each VM holds ONLY its own login
 └───────────┘ └───────────┘ └───────────┘ └───────────┘
```

cage never reads, copies or forwards any provider's OAuth tokens. It runs each vendor's **unmodified official CLI** in headless mode inside a VM you own. That design choice is what keeps it on the right side of the providers' terms (see [Terms of service](#terms-of-service-read-this)).

## Why a VM per agent

- **Blast radius.** Agents run with `--dangerously-skip-permissions` / `--yolo`-equivalents, because approving every shell command defeats the point of a bot. A VM makes that safe for your machine: `rm -rf ~` destroys a disposable guest.
- **Credential isolation.** A prompt-injected Codex can't read your Claude token, your SSH keys or your `~/Documents`. Each guest contains exactly one provider login.
- **Clean state.** Workspaces are per chat (`~/work/<chat>`). Logins live on a persistent disk, so rebuilding a VM image doesn't log you out (Firecracker).

## Quick start (macOS or Linux, Lima backend)

Requirements: Node ≥ 22.18, [Lima](https://lima-vm.io) ≥ 1.0 (`brew install lima`), about 4 GB of RAM per running agent (tunable).

```bash
git clone <this repo> cage && cd cage
npm install && npm link          # puts `cage` on your PATH (runs the TS sources directly)

cage init                        # writes ~/.cage/config.json (backend: lima, all four agents)
cage doctor
cage up                          # creates cage-claude, cage-codex, cage-gemini, cage-cursor and installs each CLI
cage login claude                # repeat for codex, gemini, cursor (see Logins below)
cage status

cage ask "why is my build slow?"            # default agent
cage ask codex "write a failing test for the parser bug"
cage ask all "review this approach: …"      # all four in parallel, answers side by side
git diff | cage ask claude                  # prompt from stdin
```

Only want some agents? Set `"enabled": false` in the config, or `cage up claude codex`.

## Logins (subscription auth, inside each VM)

`cage login <agent>` opens an interactive session in that agent's VM and runs the vendor's own login flow. None of the flows need a browser inside the VM.

| Agent | What `cage login` runs | Notes |
|---|---|---|
| claude | `claude auth login --claudeai` | Open the URL, paste the code back. Alternative: run `claude setup-token` anywhere with a browser, then `cage login claude --token` (stores `CLAUDE_CODE_OAUTH_TOKEN`, a 1-year token). Never set `ANTHROPIC_API_KEY` in a VM: it outranks the subscription. |
| codex | `codex login --device-auth` | Device code. **First enable device-code login for Codex in ChatGPT → Settings → Security.** Or use `cage login codex --browser`, which forwards the `localhost:1455` OAuth callback into the VM over SSH. |
| gemini | `NO_BROWSER=true gemini` | Pick Login with Google, open the URL, paste the code, then `/quit`. Use the Google account that has AI Pro/Ultra. Read the Google warning [below](#terms-of-service-read-this). |
| cursor | `NO_OPEN_BROWSER=1 cursor-agent login` | Open the URL on any device; the CLI polls and finishes by itself. Alternative: `cage login cursor --token` with a User API key. How API-key usage is billed is not documented. |

Tokens passed with `--token` travel over SSH stdin into a `0600` file in the guest. They never appear on a command line on either side.

## Telegram bot

1. In Telegram, message **@BotFather** → `/newbot` and name it (e.g. "Dot"). Copy the token. Also send `/setjoingroups` → **Disable**, so nobody can add your bot to a group.
2. `export CAGE_TELEGRAM_TOKEN=123:abc…`
3. `cage bot --discover`, send your bot any message, and copy the user id it prints into `telegram.allowedUserIds` in `~/.cage/config.json`.
4. `cage bot`. Run it under tmux, launchd or systemd (example below).

The bot refuses to start with an empty allowlist. It stays silent to strangers and logs their ids for you.

| Command | |
|---|---|
| plain text | goes to the default agent |
| `/claude …` `/codex …` `/gemini …` `/cursor …` | a specific agent (`/ask <agent> …` for names with dashes) |
| `/all …` | every agent in parallel, one answer each |
| `/use <agent>` | change this chat's default agent |
| `/new [agent]` | start fresh session(s) |
| `/repo <git url>` / `/repo off` | agents clone the repo in their own VM and work inside it |
| `/stop` | cancel running tasks (kills the agent's whole process tree in the guest) |
| `/status` | VM state and login state per agent |

While an agent works, the status message updates with its current tool call, e.g. `⏳ codex: shell — npm test`.

> **Privacy:** Telegram bot chats are **not end-to-end encrypted**. Prompts and answers pass through Telegram's servers. For sensitive work, use the CLI or turn on redaction.

systemd user unit (Linux):

```ini
# ~/.config/systemd/user/cage-bot.service
[Service]
Environment=CAGE_TELEGRAM_TOKEN=123:abc
ExecStart=/usr/bin/env cage bot
Restart=on-failure
[Install]
WantedBy=default.target
```

Enable it with `systemctl --user enable --now cage-bot`, and run `loginctl enable-linger $USER` so it survives logout.

## Firecracker backend (Linux server with KVM)

Stronger and lighter than Lima: microVMs, a firewall that blocks the host, LAN, cloud metadata and other VMs, and a persistent home disk separate from a replaceable rootfs.

```bash
images/fetch-firecracker.sh              # firecracker v1.15 + 6.1 guest kernel → ~/.cage/fc
images/build-rootfs.sh all               # needs Docker; ~1 GB per agent image (sparse)
cage init --backend firecracker
sudo usermod -aG kvm $USER               # then log in again
cage up claude                           # first run prints the exact sudo command for its network device:
sudo scripts/fc-net.sh up 1 $USER        # TAP cage1 + NAT + firewall (repeat per VM index; lost on reboot)
cage up                                  # boots the rest, printing each sudo command it needs
```

The build is behind a TLS-intercepting corporate proxy? Use `CAGE_EXTRA_CA=/path/ca.crt CAGE_DOCKER_NET=host images/build-rootfs.sh all`.

Per VM: `~/.cage/vms/cage-<agent>/{rootfs.ext4, data.ext4, id_ed25519, firecracker.log}`. To pick up new CLI versions, run `cage update` (in place) or rebuild the image and `cage destroy` + `cage up`. Destroy deletes the data disk, including the login.

## Config

`~/.cage/config.json` (override with `CAGE_HOME` / `CAGE_CONFIG`):

```jsonc
{
  "backend": "lima",                    // "lima" | "firecracker" | "local-unsafe"
  "defaultAgent": "claude",
  "agents": {
    "claude":  { "kind": "claude", "model": "opus" },
    "codex":   { "kind": "codex" },
    "gemini":  { "kind": "gemini", "memoryMiB": 3072 },
    "cursor":  { "kind": "cursor", "enabled": false },
    // several VMs of one kind are fine: each has its own VM, login and sessions
    "claude-research": { "kind": "claude", "autonomy": "safe", "timeoutSec": 7200 }
  },
  "telegram": { "tokenEnv": "CAGE_TELEGRAM_TOKEN", "allowedUserIds": [123456789] },
  "redact": { "enabled": false, "builtin": true, "command": ["sonomos-mask", "--json"] }
}
```

Per-agent keys: `kind`, `enabled`, `model`, `autonomy` (`full` = anything goes inside the VM; `safe` = edits only, no shell), `cpus` (2), `memoryMiB` (4096), `diskGiB` (30), `timeoutSec` (3600), `extraArgs` (appended to the CLI invocation). Resource changes apply when a VM is created.

**Laptop sizing:** four VMs at 4 GiB each is 16 GiB. On a 16 GB Mac, use `memoryMiB: 3072` or enable only the agents you use.

## Redaction (pre-send masking)

When `redact.enabled` is on, emails, API keys and tokens, private keys, JWTs, credit cards (Luhn-checked), SSNs, US phone numbers and IPv4 addresses are replaced with placeholders like `[[EMAIL_1]]` **before the prompt leaves the host**. The same placeholders in the agent's answer are swapped back locally, so the model never sees the value but you do.

`redact.command` plugs in an external masker (e.g. Sonomos's local engine). Protocol: stdin `{"text": "…"}` → stdout `{"text": "<masked>", "replacements": [{"placeholder": "…", "original": "…"}]}`. It **fails closed**: if the masker errors, the prompt is not sent. The builtin rules then run on top unless `builtin: false`.

Limits, by design:
- Restoration covers the chat reply only. Files the agent writes in its VM contain placeholders.
- A task that needs the real value ("ssh to 10.0.0.5") won't work while it's masked.
- The placeholder↔value map lives in memory only.

## Terms of service (read this)

The line every provider draws is the same: **running their official client with your own account is fine; extracting its OAuth credentials, or offering their login to other people, is not.** cage stays on the right side of that line: it spawns the unmodified CLIs and never touches their tokens. It is still automation on consumer plans, so here is the state of play as of September 2026. This is research, not legal advice; the sources are vendor docs and forums, and the terms change often.

| Provider | Documented as allowed | Prohibited | Grey |
|---|---|---|---|
| Anthropic | The unmodified Claude Code binary with your own subscription. `claude -p` and `setup-token` for scripts and CI; headless usage draws from your plan's limits. | Third parties offering claude.ai login or routing other people's traffic through Pro/Max credentials. Pulling the OAuth token out to call the API directly. | Consumer terms bar automated access "except where we otherwise explicitly permit it". Plan limits assume "ordinary, individual usage". |
| OpenAI | ChatGPT sign-in with `codex exec`, including a CI/CD guide for trusted private runners. | Not stated explicitly for personal use. | Docs still call API keys "the right default for automation". |
| Google | Headless Gemini CLI with cached credentials. | Using Gemini CLI OAuth **from third-party software**. The FAQ names tools like OpenClaw and OpenCode and threatens suspension. Google suspended accounts in Feb–Mar 2026 and later reversed some bans. | Whether an orchestrator that spawns the official binary counts as "third-party software" is untested. |
| Cursor | Headless `-p` mode. | Reverse engineering, scraping, reselling. | How API-key usage is billed. |

What that means in practice:
1. **Personal use only.** Don't turn cage into a service that drives *other people's* subscriptions. That is exactly what Anthropic and Google prohibit.
2. **Google is the risk.** If losing that Google account would hurt (Gmail, Drive), run the Gemini agent on a separate Google account, or use `cage login gemini --token` with an AI Studio API key (bills the API, not your plan).
3. **Mind the usage windows.** 24/7 bot traffic eats subscription limits fast. Rate-limit errors come back as normal agent errors in chat.

## Security model

- **Guests see nothing of the host.** Lima runs in `plain` mode (no mounts, no port forwarding, no containerd). SSH agent forwarding is disabled everywhere, so agents can't borrow your GitHub keys.
- **Firecracker firewall** (`scripts/fc-net.sh`): VMs reach the internet via NAT. They cannot reach the host (except replies to cage's own SSH), each other, RFC1918/LAN, CGNAT/Tailscale ranges, or `169.254.169.254` cloud metadata. Each VM has its own SSH host keys (regenerated on first boot) and key-only SSH as an unprivileged user.
- **Prompts** never appear in any argv. They travel on SSH stdin into a `0600` file that is deleted when the run ends. Every static argument is shell-quoted, and agent/workspace names are validated.
- **Cancel and timeouts** kill the agent's whole process group in the guest (`setsid`), not just the SSH connection.

What it does **not** protect against: an agent has internet access, so it can exfiltrate anything you give it. That includes the repo you point it at and its own subscription token. On Lima, guests can also reach your LAN. For private repos, give each VM a **scoped** credential (a fine-grained PAT or deploy key for that one repo, via `cage shell <agent>`), never your personal key.

`local-unsafe` backend: no isolation at all. Agents run on your machine with your logins, and autonomy is forced to `safe`. It exists for trying cage out and for tests. `cage bot` refuses it unless you pass `--allow-unsafe`.

## When things break

| Symptom | Likely cause → fix |
|---|---|
| `limactl create` rejects `plain` | Lima < 1.0 → upgrade Lima |
| `cage up` sits at "waiting for cloud-init" | First boot of the Ubuntu image is still upgrading packages; it continues by itself |
| Answer is "Not logged in" + hint | That VM's login expired or never happened → `cage login <agent>` |
| Codex device login refused | Device-code login not enabled in ChatGPT security settings → enable it, or `cage login codex --browser` |
| Gemini: "Please set an Auth method" / exit 41 | Not logged in → `cage login gemini` |
| "…is not installed in cage-x" | CLI missing or broken → `cage update <agent>` |
| Agent errors mention usage/rate limits | Subscription window exhausted; nothing to fix but time or plan |
| Parsing looks wrong after a CLI update | A vendor changed its stream-json format. Parsers are tolerant, but check `src/agents/<kind>.ts`. `cage ask --json` shows the raw result |
| Firecracker: "Network device cageN is missing" | TAPs don't survive reboot → run the printed `sudo scripts/fc-net.sh up N $USER` |
| Firecracker: VM exits during boot | Check `~/.cage/vms/<vm>/firecracker.log`; usually a kernel/rootfs mismatch or a KVM permission problem |
| Telegram 409 | Another `cage bot` (or a webhook) is polling the same token |
| "still working on the previous message" | One task per agent per chat → wait, or `/stop` |

A resumed session that has disappeared (VM rebuilt, CLI state wiped) is detected, and the run is retried once as a fresh session; the reply notes it.

## Development

```bash
npm test          # 44 tests: parsers, quoting, redaction, bot commands, and end-to-end runs
                  # through the real guest run script with fake agent CLIs (cancel, timeout, resume)
npm run typecheck
npm run build     # optional: emits dist/ (needed only for a non-linked global install)
```

Code map: `src/agents/*` (one adapter per CLI: argv, stream parser, login, auth check), `src/remote.ts` (guest scripts), `src/vm/*` (Lima, Firecracker, local backends; SSH transport), `src/cage.ts` (orchestrator), `src/bot/telegram.ts`, `src/cli.ts`, `guest/` (provisioning and Firecracker init), `images/` (rootfs build, kernel fetch), `scripts/fc-net.sh`.

Adding an agent (Copilot CLI, Amp, OpenCode…) means writing one adapter file: how to invoke it headlessly, how to parse its output stream, and how it logs in.

### What has and hasn't been exercised

Verified while building this (Sept 30, 2026):
- CLI flags and output formats against the real binaries: Claude Code 2.1.286, Codex 0.159.2, Gemini CLI 0.62.0 (stream-json event types read from its source), Cursor Agent 2026.09.28. That includes the Cursor quirk where `cursor-agent -p status` runs the `status` subcommand even after `--`; cage defuses it.
- `images/build-rootfs.sh` building real images (claude, cursor, codex), with each CLI running as the unprivileged guest user. The claude image was booted under systemd: `cage-init` ran, sshd came up with fresh host keys, key-only login worked and root login was refused. cage's SSH transport ran the real `claude` binary in it and surfaced "Not logged in" with the login hint. Over the same SSH path: a hostile prompt arrived byte-exact with no shell evaluation, and `/stop` killed the agent's whole process tree and cleaned up.

Not exercised here (the sandbox had no KVM, no macOS, and no accounts):
- Lima end to end.
- An actual Firecracker boot and `fc-net.sh` on a real host.
- The real subscription logins.
- Telegram against the live API.

Expect the first run on your machine to find something; the error messages point at the fix.

## Roadmap

- Egress allowlists per agent (host-side CONNECT proxy), so a prompt-injected agent can reach only its provider and your git host.
- Firecracker `jailer` (chroot, seccomp, cgroups, uid drop) and snapshot/restore for sub-second boots.
- Ephemeral per-task VMs: clone the rootfs per task, keep the login disk.
- A Signal front-end (end-to-end encrypted) as an alternative to Telegram.
- `/all` → pick the best answer → open a PR from that agent's VM.
