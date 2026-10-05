# Changelog

What changed in each cage release, in plain words. The newest release comes first.

Each release has a section headed `## v1.2.3 (2026-01-31)`. A release can't be published without one: the release page shows that section, followed by the list of merged pull requests. Use the parts that apply:

- **New:** what you can do now that you couldn't before.
- **Changed:** what works differently.
- **Fixed:** what was broken and works now.
- **After updating:** anything you need to do once, such as signing an agent in again.
- **Known issues:** what still doesn't work, and how to get around it.

Write for the people who use cage, not for its developers: short sentences, no internal names, and say what to do. Changes on main that aren't released yet go under Unreleased; a release renames that heading to its version and date.

## Unreleased

Nothing yet.

## v0.4.0 (2026-10-05)

**New:**
<!-- web app home and approvals: added when that PR merges -->
- **Go back a release.** `cage rollback` puts back the release you had before, without a download. `cage update --to v0.3.0` installs any release you name, older ones too.
- **Take cage off your computer.** On Linux: `cage uninstall`. On Windows: run the install line with `$env:CAGE_UNINSTALL='1'` set first. Your backups always stay.
- **New commands:** `cage restart`, `cage remove <agent>`, `cage logs <agent> --tail 500` (or `-f` to follow along), `cage status --json` and `cage chat rm telegram <agent>`.
- **`cage mask forget`:** each awake agent drops the real values behind its placeholders.
- **The privacy mask finds much more:** phone numbers in local and international formats, many more kinds of keys and passwords, and card numbers followed by their expiry date. It's checked on hundreds of labeled examples. More kinds you can turn on with `CAGE_MASK_TYPES`: IP and MAC addresses, crypto wallets, dates of birth, passport, ID and bank account numbers, and street addresses.
- **With the mask on, your About me and your notes' names and titles are masked too.**
- **Setting up in the terminal asks where you want to chat:** in the app (recommended) or in Telegram. It starts your agents at login only if you say yes.
- **`CAGE_APT_MIRROR`** in `~/.cage/cage.env`: your agents get Ubuntu's packages from that mirror first, such as your company's.

**Changed:**
- **Updates are safe.** With no internet, `cage update` changes nothing and says so, and your agents keep running. It never moves you to an older release by itself, and never swaps a release for an unreviewed copy of the code. An update cut off halfway is finished by the next `cage update`.
- **cage installs the microsandbox version it's tested with (0.7.5),** and `cage update` updates an older one. If yours is too old, cage asks you to run `cage fix` before it wakes your agents.
- **Your agent is ready to chat first; its browser gets ready in the background,** usually within a minute of waking up. If the agent asks for the browser before that, it's told to try again in a few minutes.
- **Claude Code comes from its stable channel,** about a week behind its newest release, skipping releases with known problems. Your first `cage update` may move it back a few versions.
- **Asking your other agents keeps the mask.** What you told a masked agent stays masked when `/all`, a stand-in or `cage ask` passes it on. The question is no longer on a command line, where others on your computer could read it.
- **The app opens with a one-time code,** never with its key in the address bar.
- **Old files in the app's chat folder are cleared** after a week when no chat mentions them, sooner when the folder passes 2 GB.
- **WhatsApp messages you send while the agent is asleep reach it when it wakes,** if they're less than a day old.
- **With `cage approve claude on`,** Claude's newer tools that stay inside its own computer go ahead without asking.
- **The computer check** explains how to turn on nested virtualization when cage runs in a virtual machine, and names only the site that's blocked.
- **Every release now comes with notes like these,** and is published only from a commit that passed all of cage's tests.

**Fixed:**
- An offline `cage update` could delete cage and leave the `cage` command pointing at nothing.
- When GitHub's release list didn't answer, an update could quietly install an unreviewed copy of the code.
- The app kept running its old version after an update.
- An agent could stay offline for a long time when Ubuntu's servers were slow.
- The app's chat went quiet after its connection to the agent restarted. Files and scheduled tasks waited behind a message the agent hadn't answered yet. Videos didn't arrive, and downloaded work files lost part of their names.
- WhatsApp lost messages sent while the agent's chat service restarted, and kept asking WhatsApp for new linking codes while nobody was linking.
- A voice note sent while the agent was starting failed instead of waiting for the speech model.
- Questions over 8 KB failed in the app, files with non-Latin names couldn't be downloaded, Esc stopped running jobs, and switches showed your click even when cage didn't do it.
- An agent's computer could trick cage: with links in its chat folder or memory inbox, with text that controls your terminal, by faking one of cage's questions in the app, or (on Windows) with a sign-in link that ran PowerShell commands.
- Two cage commands at once could lose a setting, and a full disk could cut your settings short.
- One agent that couldn't start kept the others asleep.
- A backup that wouldn't open again could still be reported as saved. Restore now checks the passphrase and free space first.

**After updating:**
- Nothing to do for most. Your agents are rebuilt with fresh downloads, and keep their logins and files.
- On Linux, if your agents start when you log in, run `cage autostart on` once more: then the app starts at login too.

**Known issues:**
- This one update, from v0.3.0, still runs v0.3.0's updater, which had the problems fixed here. Update while you're online. Updates after this one are safe.
- Right after this update there's no earlier release kept to roll back to. To go back to v0.3.0: `cage update --to v0.3.0`.
- Codex can't ask in chat. With `cage approve codex on` (or `CAGE_MODE=ask`) it works read-only instead.
- The privacy mask covers what you type, your answers, your About me and your notes' names. Files and pictures you send, web pages and your apps' results reach the AI company as they are, and anyone who can chat with the agent can ask it about a masked value.
- Each chat app's token lives inside its agent's computer. An agent tricked by a prompt injection could read it.
- macOS isn't supported yet.
