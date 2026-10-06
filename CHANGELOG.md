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

## v0.4.0 (2026-10-06)

**New:**
- **Home shows an agent waiting for your OK,** in the same words as its chat ("Gmail: send email to bob@acme.com"), with Allow, Deny and Open (just Open and Deny when there's more to the request than that line shows). Each agent's row on Home says what it's doing: waiting for your OK, working, or what it said last.
- **Plan usage on Home:** how much of each plan is left and when it resets, for Claude Code and Codex. Home checks at most every 10 minutes. An agent that has used up its plan is offered a stand-in right there.
- **Stop, Copy and Save in the app's chat.** Stop (or Esc, when you haven't typed anything) stops the agent while it works. Copy puts an answer on the clipboard with its formatting, for Word or an email, and Save as a file downloads it.
- **Recipes:** eight ready-made tasks to start from, in the chat (an empty one shows them; later, Recipes by the message box), and the six that run on a schedule on an agent's Schedule tab too, such as a morning briefing, inbox triage, a first pass on a contract or NDA, and receipts into a spreadsheet. Each says which apps it uses, and marks anything you fill in yourself, like the topic of a news watch.
- **Keyboard shortcuts in the app:** Alt+1 to 4 opens an agent's chat, ready to write in, Ctrl+Shift+O starts a new conversation with the agent you're on, and ? lists them all. What you were writing to one agent waits for you while you look at another.
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
- **Claude Code keeps running between your messages,** so `/compact` and its other slash commands work in chat. When Claude asks you to pick between options, the question now reaches you and your answer goes back to it; before, it was answered with nothing.
- **Claude Code comes from its stable channel,** about a week behind its newest release, skipping releases with known problems. Your first `cage update` may move it back a few versions.
- **Asking your other agents keeps the mask.** What you told a masked agent stays masked when `/all`, a stand-in or `cage ask` passes it on. The question is no longer on a command line, where others on your computer could read it.
- **The app opens with a one-time code,** never with its key in the address bar.
- **Old files in the app's chat folder are cleared** after a week when no chat mentions them, sooner when the folder passes 2 GB.
- **When an agent asks for your OK in the app, it says in words what it would do** ("Gmail: send email", to whom, the subject and the email) instead of showing cc-connect's raw text, which stays one click away. "Allow All (this session)" is now "Allow everything until a new conversation", as that's what it does: the agent stops asking about anything, in any app, and so do scheduled tasks in that chat, until you start a new conversation. The notification says the same as the chat.
- **The app works better with a screen reader and the keyboard:** text that was too faint is darker, every page has a main heading that gets the focus, an answer still being written is read out once, when it's done, and the app asks and tells you things in its own messages instead of the browser's pop-ups.
- **WhatsApp messages you send while the agent is asleep reach it when it wakes,** if they're less than a day old.
- **With `cage approve claude on`,** Claude's newer tools that stay inside its own computer go ahead without asking.
- **The computer check** explains how to turn on nested virtualization when cage runs in a virtual machine, and names only the site that's blocked.
- **Every release now comes with notes like these,** and is published only from a commit that passed all of cage's tests.

**Fixed:**
- In the app's chat, Allow on a request the agent had stopped waiting for (you'd answered it in a message or stopped it, or it had asked something else since) could say yes to what it asked next. An answer now goes only to the request it was for, and a request the agent stopped waiting for says so.
- An offline `cage update` could delete cage and leave the `cage` command pointing at nothing.
- When GitHub's release list didn't answer, an update could quietly install an unreviewed copy of the code.
- The app kept running its old version after an update.
- An agent could stay offline for a long time when Ubuntu's servers were slow.
- The app's chat went quiet after its connection to the agent restarted. Files and scheduled tasks waited behind a message the agent hadn't answered yet. Videos didn't arrive, and downloaded work files lost part of their names.
- WhatsApp lost messages sent while the agent's chat service restarted, and kept asking WhatsApp for new linking codes while nobody was linking.
- A voice note sent while the agent was starting failed instead of waiting for the speech model.
- Questions over 8 KB failed in the app, files with non-Latin names couldn't be downloaded, Esc stopped running jobs, and switches showed your click even when cage didn't do it.
- The app forgot which chats you hadn't read when you reloaded it, and marked a reply as unread while you were looking at that agent's files or settings. A file smaller than 1 kB showed as 1 kB.
- An agent's computer could trick cage: with links in its chat folder or memory inbox, with terminal control codes in a note or in what cage showed while waking it up, by faking one of cage's questions in the app, or (on Windows) with a sign-in link that ran PowerShell commands.
- Two cage commands at once could lose a setting, and a full disk could cut your settings short.
- One agent that couldn't start kept the others asleep.
- `cage approve codex on`, and the app's switch for it, said Codex would ask you in the chat. It can't; both now say Codex works read-only.
- A backup that wouldn't open again could still be reported as saved. Restore now checks the passphrase and free space first.
- `/all` in an agent's chat ran another command, `/allow`: that agent never got your question, and a tool named like its first word could then run without asking first (`/all Write a poem` allowed Write). Now that agent answers too, however you capitalize `/all`, with your question exactly as you wrote it, and `/allow` is turned off. Chat apps' command menus list it as `/askall`.
- When `cage ask`, `/all` or a stand-in had an agent answer behind the privacy mask, your own terms (such as a client's name) could reach that AI company as they were: right after it woke up, for terms you added since, and for as long as it ran if it woke up before you turned on `/all` or a stand-in. Emails, numbers and keys were still masked. Now your current terms are in place before it answers, and if they can't be, it doesn't answer.

**After updating:**
- Nothing to do for most. Your agents are rebuilt with fresh downloads, and keep their logins and files.
- On Linux, if your agents start when you log in, run `cage autostart on` once more: then the app starts at login too.

**Known issues:**
- This one update, from v0.3.0, still runs v0.3.0's updater, which had the problems fixed here. Update while you're online. Updates after this one are safe.
- Right after this update there's no earlier release kept to roll back to. To go back to v0.3.0: `cage update --to v0.3.0`.
- Codex can't ask in chat. With `cage approve codex on` (or `CAGE_MODE=ask`) it works read-only instead, and never asks first. Apps you connected for it may still let it act, so if you want it to check with you, don't connect apps to Codex.
- The privacy mask covers what you type, your answers, your About me and your notes' names. Files and pictures you send, web pages and your apps' results reach the AI company as they are, and anyone who can chat with the agent can ask it about a masked value.
- Each chat app's token lives inside its agent's computer. An agent tricked by a prompt injection could read it.
- macOS isn't supported yet.
- cc-connect, which connects your chats to your agents, is a preview release in this version (1.5.1-beta.3), for the Claude Code fixes above. If your chats misbehave after this update, put `CAGE_CC_CONNECT_VERSION=stable` in `~/.cage/cage.env` and run `cage update`: your agents get cc-connect 1.5.0 again. (A plain `v1.5.0` there doesn't do it: earlier cages wrote that very line, so cage reads it as theirs.)
