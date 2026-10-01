<p align="center"><img src="assets/logo.svg" width="168" alt="cage: a cartoon birdcage with big eyes"></p>

<h1 align="center">cage</h1>

<p align="center"><b>Your AI agents, each in its own little cage.</b><br>
Claude Code, Codex, Cursor and Antigravity on your own subscriptions.<br>
Each one lives in a private microVM and talks to you on Telegram, Slack, Discord or WhatsApp.</p>

<p align="center"><img src="assets/app.png" width="720" alt="cage in the browser: one card per agent with its state, chat apps and buttons to wake it, sign it in or see its logs"></p>

## Get started

**Windows 11:** download [Install-cage.cmd](https://github.com/z-brenner/cage/releases/latest/download/Install-cage.cmd) and double-click it, or open PowerShell and paste

```powershell
irm https://github.com/z-brenner/cage/releases/latest/download/install.ps1 | iex
```

**Linux:** open a terminal and paste

```bash
curl -fsSL https://github.com/z-brenner/cage/releases/latest/download/install.sh | bash
```

That's the whole setup. cage then opens in your browser and walks you through everything in about five minutes. No terminal needed:

1. checks your computer and installs what's missing (on Windows: WSL 2 and its own Ubuntu, restarting once if needed)
2. asks which subscriptions you have
3. makes a Telegram bot for each: you make one bot of your own in BotFather, then each agent's bot is **one tap**, with its own face
4. locks the bots to *your* Telegram account
5. starts each agent in its own VM and signs it in with your subscription

After that, open **Cage** from your Start menu (Windows) or app menu (Linux) to see how everyone's doing. Message your bots on Telegram and they work in their cages.

The app does everything:
- signs agents in;
- adds chats, apps, website sign-ins and keys;
- reviews memory, security events and backups;
- holds every setting.

Each action runs cage itself and shows its questions as a conversation. Vendor sign-ins open in a terminal view right in the page. The app only listens on your own computer and needs the private link it opened with.

Prefer a terminal? Type `cage` instead; every command below works there too (`cage ui` opens the app).

<p align="center"><img src="assets/screenshot.png" width="600" alt="cage in a terminal: the mascot, then one row per agent showing its state as a little face"></p>

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
cage ui               the same, and everything else, in your browser
cage up [agents]      wake agents up (a fresh VM; logins and files are kept)
cage down [agents]    put them to sleep
cage login <agent>    sign an agent in to your subscription
cage logs <agent>     watch what an agent's VM is doing
cage memory           review what your agents want to remember
cage connect          let your agents use Gmail, Calendar, GitHub, Linear…
cage password add …   a website sign-in they can use but never see
cage chat add slack   talk to an agent in Slack too (or discord, whatsapp)
cage secret add …     give agents a key they can use but never see
cage backup           everything in one encrypted file (cage restore puts it back)
cage security         what was blocked: keys sent to the wrong place, hosts (strict network)
cage ask "…"          every awake agent answers (cage ask-all on: /all in chat too)
cage fallback a b     when agent a is out of quota, b answers in its chat
cage voice on         voice notes, turned into text on each agent's own VM
cage mask on          emails, numbers and keys reach the AI vendor as tokens
cage network strict   each agent reaches only what it needs (cage allow <host> for more)
cage doctor           check this computer, the config and the bots
cage autostart on     wake them up whenever you log in
cage help             everything else
```

In Telegram, each chat is a session: `/new` starts fresh, `/stop` interrupts, `/list` and `/switch` move between sessions, `/model` and `/mode` change how the agent works, `/usage` shows your quota.

**Ask all your agents:** turn it on once with `cage ask-all on`. Then, in any agent's chat (Telegram, Slack, Discord or WhatsApp), start a message with `/all` or `@all` (in Slack, `@all`: Slack keeps `/` for its own commands). That agent answers as usual, and your other awake agents' answers arrive in the same chat. From the terminal, `cage ask "…"` asks all of them at once.

You can also add the bots to one Telegram group, turn **Group Privacy** off for each (BotFather → Bot Settings), and @mention the bots you want. Set `CAGE_TELEGRAM_GROUP_REPLY_ALL=true` to have all of them answer everything there.

**When one runs out of quota:** with `cage fallback claude codex`, a usage-limit reply from Claude is followed by Codex's answer to your message, in the same chat. Codex sees the last few messages. It works for any pair, and `cage fallback claude off` turns it off.

Answers from `/all` and stand-ins are read-only and don't use your connected apps. Both features are off until you turn them on, because they let one agent's VM put questions to another (see the security model).

**Voice notes:** run `cage voice on` and send voice messages on Telegram, Slack, Discord or WhatsApp.
- Each agent's VM turns them into text itself with Whisper, so nothing you say leaves your computer. The first time, it downloads about 300 MB.
- `CAGE_VOICE_MODEL=small` in `~/.cage/cage.env` is more accurate but slower. `CAGE_VOICE_LANGUAGE=en` skips language detection.
- `cage voice on groq` uses Groq's Whisper API instead: faster, with your key, which the VMs never see.

## Slack, Discord and WhatsApp

Telegram is where setup starts, and you can add an agent to Slack, Discord or WhatsApp as well. Each one is that agent's own bot there, run by the same VM, with the same login and files.

```bash
cage chat add slack claude      # opens a Slack app for claude, already filled in; you paste two tokens
cage chat add discord codex     # you make an app in Discord's portal and paste its token; cage does the rest
cage chat add whatsapp claude   # scan a QR code with WhatsApp, like WhatsApp Web
cage chat                       # who's where
```

- **Slack:** the link creates the app with everything set (Socket Mode, so nothing on your computer is exposed to the internet). You click Install, then copy two tokens. DM it, or invite it to a channel and @mention it.
- **Discord:** cage turns on the permission it needs to read your messages, gives it its face, and shows an invite link (and a QR code) for your server. DM it, or @mention it in a channel.
- **Only you can talk to it** unless you say otherwise: cage finds your Slack account from your email, and your Discord account from the app's owner.
- **Letting coworkers use it** is possible (`everyone`, or a list of emails in Slack), but think twice. Each agent runs on *your* personal subscription. Those plans are for one person, so sharing one with a team likely breaks their terms (see below). Everyone you let in can also reach what you connected it to: your email, files and keys. For a team bot, use the vendor's team plan or API key instead.
- **WhatsApp:** your agent links as a device of a WhatsApp number, through [Baileys](https://github.com/WhiskeySockets/Baileys) (an open-source, unofficial WhatsApp Web client) plugged into cc-connect's bridge. WhatsApp doesn't allow unofficial clients and has banned numbers for it, so **use a spare number** if you can (a prepaid SIM, or a second number in the WhatsApp Business app), then message it from your own phone. Linking your own number works too: the agent then answers only in your "Message yourself" chat, but its VM holds a key to your whole WhatsApp. It comes on top of Telegram, Slack or Discord. If the link drops: `cage chat link whatsapp <agent>`.

## Privacy mask

```bash
cage mask on [agents]          # on for all agents, or the ones you name
cage mask add "Acme Corp"      # your own sensitive terms: clients, projects, people
cage mask try "mail bob@acme.com about Acme Corp"   # see what the model would get
cage mask off
```

With the mask on, sensitive values in your messages become tokens like `[EMAIL_1]` before they reach the AI vendor, and turn back into the real values in the replies you read. Covered:
- email addresses and phone numbers;
- card numbers (Luhn-checked), IBANs (checksum-verified) and US social security numbers;
- API keys and tokens;
- your own terms.

It runs inside each agent's VM, between the chat bot and the agent's CLI, so it covers Telegram, Slack, Discord and WhatsApp alike. The same value always gets the same token, so the agent can still tell them apart.

The trade-off is that the agent can't use a masked value itself. It knows this, and asks when a task needs one.

## Memory

Your agents share one memory, and it's yours: a folder of plain notes on your computer (`cage memory open`; it works as an Obsidian vault too).

- **`about-me.md`** is read by every agent before every conversation. Setup asks three quick questions to start it.
- **Agents suggest; you decide.** When an agent learns something worth keeping, it drops a note in its own inbox. `cage memory` shows you each one: keep it and every agent knows it, or forget it. The home screen tells you when there's something to review.
- **Why the extra step:** a note one agent writes can't quietly become instructions for the others. Agents can read your approved notes but never change them, and they can't see each other's inboxes.

## Connect your apps

```bash
cage connect                                   # what you can connect, and what's connected
cage connect add zapier                        # Gmail, Calendar, Drive, Slack, Notion and thousands more
cage connect add github                        # repositories, issues and pull requests
cage connect add linear                        # issues and projects
cage connect add notion                        # Notion: you sign in in the browser
cage connect add crm https://example.com/mcp   # any other app with an MCP address
```

Each one shows you where to get a key, then wires the app into every agent's own CLI as an MCP server. The key is kept like the ones [below](#keys-your-agents-can-use-but-never-see): it stays on your computer, and only that app's own servers ever see it.

- **Zapier is the shortcut.** You sign in to Gmail, Google Calendar, Slack and the rest on Zapier's site and choose what your agents may do there; one key covers all of it.
- **Claude** also gets the connectors on your claude.ai account (Settings → Connectors), because it signs in with that account.
- **Apps you sign in to in the browser:** `cage connect add notion` (or `atlassian` for Jira and Confluence, `sentry`, or any MCP address that asks for a sign-in). Your browser opens on the app's own sign-in page. The sign-in stays on your computer, in `~/.cage/oauth`. Its short-lived access token becomes a secret like the keys below, so the VMs hold only a placeholder for it. While your agents are awake, cage renews the token before it expires and swaps the new one in without a restart. This needs `python3`, which Ubuntu has.
- Adding or removing an app restarts the agents that are awake, which takes a minute or two.

## Keys your agents can use but never see

```bash
cage secret add GITHUB_TOKEN api.github.com          # asks for the value; it stays on your computer
cage secret add LINEAR_KEY api.linear.app claude      # only for claude
cage secret list
```

The agent gets a stand-in for the key. When it calls `api.github.com` with it, microsandbox swaps in the real key on its way out of the VM; sent anywhere else, it's blocked. So even a tricked agent can't leak the key itself, though it can still use it at that host, so prefer narrow, read-only tokens. It covers keys sent in request headers, which is how most APIs work (not Telegram tokens or website passwords). To do the swap, microsandbox inspects that VM's HTTPS on your computer, except for the agent's own service and Telegram. Agents without keys aren't inspected.

## Website passwords your agents can use but never see

```bash
cage password add example.com          # asks for the username and the password (hidden)
cage password add app.example.com codex
cage password                          # what's saved
cage password rm example.com
```

Your agents get a web browser (headless Chromium, through Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp)) and, for each site, a placeholder like `cagepw-example-com-x7k2…`. They type it into the site's own password field. When the sign-in form is sent to that site, microsandbox swaps in your real password; sent anywhere else, it's blocked. The password never enters the VM, so a tricked agent can't leak it. It can still use the account while it's signed in, though, so prefer accounts with limited rights.

- **Passwords with symbols** (`&`, `%`, `+`, spaces…) get a second placeholder holding the password already encoded for classic HTML forms. Agents are told to try that one if the site says the first one is wrong. Quotes and backslashes may not get through sign-ins that send JSON.
- **Some sign-ins can't work this way:** sites that encrypt or hash the password in the page before sending it, and big providers that block automated browsers (Google, Microsoft, Apple). For Gmail and friends use Zapier ([above](#connect-your-apps)) instead.
- The browser's profile lives in the agent's home, so it stays signed in across restarts. `cage connect add browser` gives an agent the browser without any passwords.

## Backups

```bash
cage backup            # everything, in one encrypted file
cage restore           # list your backups
cage restore <file>    # put one back: on this computer, or on a new one after installing cage
```

A backup holds your settings, bots, keys, app sign-ins and memory (`~/.cage`), plus each agent's home volume: its login, sessions and work. Caches it can download again are left out. It's encrypted with a passphrase you pick (AES-256, PBKDF2 with 600,000 rounds, via openssl), so it's fine to keep in cloud storage. Nobody can recover a forgotten passphrase.

- Backups go to `~/cage-backups`. On Windows they go to `Documents\cage backups` instead, so they survive even if the WSL distro is removed. Set `CAGE_BACKUP_DIR` to change this.
- The newest 10 are kept (`CAGE_BACKUP_KEEP`).
- Agents can keep running during a backup.
- `restore` puts your agents to sleep, sets aside what's there now (in `~/.cage.before-restore-…`), then wakes them up with the restored logins and files.

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
- **After a reboot** your agents sleep until you wake them (or turn on autostart, once). Each VM's system disk is new every time, but everything it downloaded (Ubuntu packages, Node.js, its CLI, cc-connect) is kept in a cache of its own. So waking reinstalls from there in seconds, without any vendor's servers, and logins, sessions and files are kept. `cage update` (the **Update** button) gets the newest of everything.
- **Settings** live in `~/.cage/cage.env` (CPU, memory, disk, network rules, `CAGE_MODE=ask` to approve each tool call in chat).
- **Updates:** `cage update` installs the newest cage release, then rebuilds the agents with the newest CLIs. Each release's download is checked against its `SHA256SUMS` before anything is replaced, and every file carries a signed build-provenance attestation: `gh attestation verify cage-v0.1.0.tar.gz --repo z-brenner/cage` shows it was built by this repo's release workflow from that tag. `cage --version` says which one you have. To follow the development version instead, install with `CAGE_REF=main`.
- **Installer error "Could not determine latest release version"?** That's GitHub rate-limiting your IP. `cage` falls back to a pinned microsandbox automatically.

## Security model

- **One microVM per agent.** Agents run in "yolo" mode (no approval prompts) because the VM is the sandbox. A prompt-injected Codex can't touch your computer, your SSH keys or Claude's login. Set `CAGE_MODE=ask` to approve each tool call in chat instead.
- **Network:** by default, microsandbox's policy applies: the public internet is allowed, and your computer, LAN, loopback and cloud-metadata endpoints are blocked. **`cage network strict`** switches each agent to deny-by-default. It may then reach only:
  - its own service and its chat apps;
  - where it installs from;
  - the apps and sites you connected, and the hosts its keys are for;
  - whatever you add with `cage allow <host> [agents]`.

  Anything else fails to resolve, and the agent is told to ask you. `cage network hosts <agent>` shows the full list, and `cage network open` switches back.
- **Security events:** cage collects what microsandbox blocks from each VM's log:
  - a key or password placeholder sent anywhere other than its own hosts (usually a prompt injection; the real value never left);
  - in strict mode, each host an agent couldn't reach.

  Your home screen flags new ones, and `cage security` lists them, with the `cage allow` line for each blocked host.
- **Only you can talk to the bots:** the Telegram ids in `CAGE_TELEGRAM_ALLOW`, and in Slack or Discord your own account unless you allowed others. Only your own accounts are admins for cc-connect's privileged commands (`/shell`, `/dir`, `/restart`…).
- **Mounts:** the only host paths a VM sees are `guest/` (the provisioning scripts), its own generated config (which names its keys and apps, never the keys themselves) and your approved memory, all read-only, plus its own memory inbox.
- **`/all` and stand-ins cross VMs, so they're opt-in.**
  - The VMs can't reach each other. cage relays on your computer instead: an agent's cc-connect hook leaves a request in a folder only that VM can write, and cage asks the others through `msb exec`.
  - cage treats everything in that folder as untrusted: no links or FIFOs, size limits, strict session keys, rate limits. Request text is only ever passed as an argument, never run.
  - Asked agents answer read-only and without your connected apps. Still, a compromised agent could use this to put questions to your others.
- **Known gap: each bot's token (Telegram, Slack, Discord, the WhatsApp link) lives inside that agent's VM.** An agent that gets prompt-injected could read it and impersonate its bot.
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

## How it's built

cage is a few hundred lines of shell around two open-source projects: [cc-connect](https://github.com/chenhg5/cc-connect) (the Telegram bot and drivers for the official agent CLIs) and [microsandbox](https://github.com/superradcompany/microsandbox) (one microVM per agent). The research behind that choice, and what was left out, is in [docs/DESIGN.md](docs/DESIGN.md).

## Development

```bash
shellcheck cage install.sh guest/*.sh test/*.sh scripts/*.sh
test/installer.sh               # install.sh from git and from releases (checksums, in-place updates, cage update)
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

Releases: push a tag like `v0.2.0` on main, or run the release workflow on main with that version. `.github/workflows/release.yml` runs the quick checks, builds the release with `scripts/build-release.sh` (reproducible: the same commit gives the same tarball), attests it, and publishes it. The installers always take the latest release.

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
