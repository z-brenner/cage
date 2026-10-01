<p align="center"><img src="assets/logo.svg" width="168" alt="cage: a cartoon birdcage with big eyes"></p>

<h1 align="center">cage</h1>

<p align="center"><b>Your AI agents, each in its own little cage.</b><br>
Claude Code, Codex, Cursor and Antigravity on your own subscriptions.<br>
Each one lives in a private microVM and talks to you as a Telegram bot.</p>

<p align="center"><img src="assets/screenshot.png" width="720" alt="The cage home screen: the mascot, then one row per agent showing its state as a little face"></p>

## Get started

**Windows 11:** open PowerShell and paste

```powershell
irm https://raw.githubusercontent.com/z-brenner/cage/main/install.ps1 | iex
```

**Linux:** open a terminal and paste

```bash
curl -fsSL https://raw.githubusercontent.com/z-brenner/cage/main/install.sh | bash
```

That's the whole setup. It walks you through everything in about five minutes:

1. checks your computer and installs what's missing (on Windows: WSL 2 and its own Ubuntu, restarting once if needed)
2. asks which subscriptions you have
3. makes a Telegram bot for each: you make one bot of your own in BotFather, then each agent's bot is **one tap**, with its own face
4. locks the bots to *your* Telegram account
5. starts each agent in its own VM and signs it in with your subscription

After that, type `cage` (on Windows, open **cage** from the Start menu) to see how everyone's doing. Message your bots on Telegram and they work in their cages.

<p align="center"><img src="assets/avatars.png" width="440" alt="The four bot avatars: claude in peach, codex in mint, cursor in sky blue, antigravity in lilac"></p>

## Reading the faces

Every agent is a little creature in a cage, and its eyes tell you how it is.

| | |
|---|---|
| `[•\|•]` | awake and ready |
| `[o\|o]` | needs you to sign in: `cage login <agent>` |
| `[•\|-]` | busy (it blinks while it installs) |
| `[-\|-]` | asleep: `cage up` |
| `[ \| ]` | no cage yet |

## Everyday commands

```text
cage                  set up, or see how your agents are doing
cage up [agents]      wake agents up (a fresh VM; logins and files are kept)
cage down [agents]    put them to sleep
cage login <agent>    sign an agent in to your subscription
cage logs <agent>     watch what an agent's VM is doing
cage doctor           check this computer, the config and the bots
cage autostart on     wake them up whenever you log in
cage help             everything else
```

In Telegram, each chat is a session: `/new` starts fresh, `/stop` interrupts, `/list` and `/switch` move between sessions, `/model` and `/mode` change how the agent works, `/usage` shows your quota.

**Ask several agents at once:** add your bots to one Telegram group, turn **Group Privacy** off for each (BotFather → Bot Settings), then @mention the bots you want in one message. Set `CAGE_TELEGRAM_GROUP_REPLY_ALL=true` to have all of them answer everything there.

## Windows

cage runs inside WSL 2 and behaves just as on Linux. It needs **Windows 11** on an x64 PC with virtualization turned on: WSL 2 only runs VMs inside it on Windows 11, and Windows on ARM can't.

The PowerShell line above does all of this for you: it gives cage its own Ubuntu called **cage** (separate from any Ubuntu you already have), creates your Linux user, and starts the setup. To do it by hand instead: `wsl --install -d Ubuntu-24.04`, open Ubuntu, and run the Linux line. Keep cage in your Linux home (`~/cage`), not under `/mnt/c`.

- **Closing the window is fine.** WSL normally stops Ubuntu about 15 seconds after its last window closes, VMs included. `cage up` keeps one hidden WSL session open so your agents stay up; `cage down` lets it go.
- **Reboots:** `cage autostart on` wakes your agents at every Windows login (no admin needed; a window flashes for a few seconds).
- **Memory:** WSL gets half your RAM, and each agent takes 4 GB of that. With 16 GB or less, put `CAGE_MEMORY=2G` in `~/.cage/cage.env`.
- **No `/dev/kvm`?** Check that `nestedVirtualization` isn't `false` in `%UserProfile%\.wslconfig`, that `wsl -l -v` shows version 2, and that Task Manager → Performance → CPU says *Virtualization: Enabled*. Then `wsl --shutdown` and reopen Ubuntu.

## Good to know

- **Sign-ins happen inside each VM**, with each vendor's own CLI, and stay on that agent's volume. They survive `up`, `update`, reboots and `cage destroy <agent> --keep-login`.
- **Codex:** turn on device-code sign-in first (ChatGPT → Settings → Security).
- **Antigravity** is Google's successor to Gemini CLI for AI Pro/Ultra (since 2026-06-18). Google has suspended accounts over third-party use of its CLI logins, so consider a spare Google account.
- **After a reboot** your agents sleep until `cage up` (or `cage autostart on`, once). Waking reinstalls each CLI in about a minute; logins, sessions and files are kept.
- **Settings** live in `~/.cage/cage.env` (CPU, memory, disk, network rules, `CAGE_MODE=ask` to approve each tool call in chat).
- **Installer error "Could not determine latest release version"?** That's GitHub rate-limiting your IP. `cage` falls back to a pinned microsandbox automatically.

## Security model

- **One microVM per agent.** Agents run in "yolo" mode (no approval prompts) because the VM is the sandbox. A prompt-injected Codex can't touch your computer, your SSH keys or Claude's login. Set `CAGE_MODE=ask` to approve each tool call in chat instead.
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

## Terms of service

**The official CLI with your own login is fine. Extracting its tokens or sharing your subscription is not.** cage never reads or moves tokens: each vendor's own CLI signs in and runs inside your VM.

- **Anthropic** allows "an end user signing in to the unmodified Claude Code binary with their own Claude subscription", and bars routing other people's requests through Pro/Max. **Personal use only.**
- **OpenAI** supports ChatGPT sign-in with `codex exec`; its docs still call API keys the default for automation.
- **Google:** see the Antigravity note above.
- **Cursor:** headless mode is documented; cage uses the normal login.

## How it's built

cage is a few hundred lines of shell around two open-source projects: [cc-connect](https://github.com/chenhg5/cc-connect) (the Telegram bot and drivers for the official agent CLIs) and [microsandbox](https://github.com/superradcompany/microsandbox) (one microVM per agent). The research behind that choice, and what was left out, is in [docs/DESIGN.md](docs/DESIGN.md).

## Development

```bash
shellcheck cage guest/*.sh test/*.sh
test/host.sh                    # cage against a stub msb: config rendering, validation, msb arguments, status, guards
test/setup.sh                   # cage setup / doctor / autostart against a mock Telegram API and stubbed launchctl/systemctl
CAGE_TEST_CC_CONNECT=/path/to/cc-connect test/host.sh   # plus: real cc-connect loads every generated config
test/guest-smoke.sh claude      # Docker stand-in for the VM: same image, mounts and entry script
test/microvm-e2e.sh claude      # REAL microVM via msb (KVM or Apple Silicon): provisioning, cc-connect user,
                                # login probe, egress policy, read-only mounts, persistence, destroy
```

CI (`.github/workflows/ci.yml`) runs:
- shellcheck
- the host and setup tests under bash 5, and under bash 3.2 (what macOS ships), including WSL behavior against stubbed Windows tools
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
- Real Windows. GitHub's Windows runners can't run nested VMs, so the WSL keepalive and login entry are tested against stubbed `powershell.exe`/`reg.exe` only.

Those are the two steps you do once, by hand: `cage login <agent>`, then message the bot.
