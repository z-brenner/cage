import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { AgentEvent } from './agents/types.ts';
import { TelegramBot } from './bot/telegram.ts';
import { BusyError, Cage, type RunResult } from './cage.ts';
import { BACKENDS, type BackendName, configPath, ConfigError, loadConfig, writeStarterConfig } from './config.ts';
import { FirecrackerBackend } from './vm/firecracker.ts';
import { runInteractive } from './vm/proc.ts';
import { truncate } from './util.ts';

const tty = process.stderr.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const bold = c('1');

const err = (s: string) => process.stderr.write(s + '\n');
const log = (s: string) => err(dim(`  ${s}`));

const HELP = `cage: Claude Code, Codex, Gemini CLI and Cursor on your own subscriptions, each agent in its own VM.

Setup
  cage init [--backend lima|firecracker|local-unsafe] [--force]   write ~/.cage/config.json
  cage doctor                          check host prerequisites
  cage up [agent...] [--reprovision]   create/start VMs and install each agent's CLI
  cage login <agent> [--browser|--token]
                                       sign in inside the agent's VM (subscription login)

Use
  cage ask [agent|all] [--new] [--json] <prompt...>   (prompt from stdin if omitted)
  cage bot [--discover] [--allow-unsafe]              Telegram front-end
  cage repo [git-url|off]              make CLI tasks run inside a repo clone
  cage reset [agent]                   forget CLI sessions

Manage
  cage status [--no-auth]              VM state and login state per agent
  cage shell <agent>                   interactive shell inside the VM
  cage update [agent...]               reinstall the latest agent CLI in the VM
  cage down [agent...]                 stop VMs
  cage destroy <agent> --yes           delete the VM and its disk (including the login)

Agents default to every enabled agent in config. Config: ${configPath()}`;

function load(): Cage {
  return new Cage(loadConfig());
}

function pickAgents(cage: Cage, names: string[]): string[] {
  const all = cage.agentNames();
  if (names.length === 0 || (names.length === 1 && names[0] === 'all')) return all;
  for (const n of names) cage.agent(n);
  return names;
}

async function cmdInit(args: string[]) {
  const { values } = parseArgs({ args, options: { backend: { type: 'string' }, force: { type: 'boolean' } } });
  const backend = (values.backend ?? 'lima') as BackendName;
  if (!BACKENDS.includes(backend)) throw new Error(`--backend must be one of ${BACKENDS.join(', ')}`);
  if (existsSync(configPath()) && !values.force) throw new Error(`${configPath()} already exists (use --force to overwrite)`);
  const path = writeStarterConfig(backend);
  err(`${green('✓')} wrote ${path}`);
  err(`next: ${bold('cage doctor')}, then ${bold('cage up')}`);
  if (backend === 'local-unsafe') err(yellow('⚠ local-unsafe runs agents directly on this machine with NO isolation.'));
}

async function cmdDoctor() {
  let ok = true;
  const check = (pass: boolean, msg: string) => {
    err(`${pass ? green('✓') : red('✗')} ${msg}`);
    ok &&= pass;
  };
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  check(maj > 22 || (maj === 22 && min >= 18), `node ${process.versions.node} (need >= 22.18)`);
  let cage: Cage;
  try {
    cage = load();
    check(true, `config ${configPath()}`);
  } catch (e) {
    check(false, (e as Error).message);
    process.exitCode = 1;
    return;
  }
  err(`  backend: ${cage.backend.name}${cage.backend.isolated ? '' : yellow(' (NO isolation)')}`);
  const problems = await cage.backend.doctor();
  problems.forEach((p) => check(false, p));
  if (!problems.length) check(true, `${cage.backend.name} prerequisites`);
  if (cage.backend instanceof FirecrackerBackend) {
    const kinds = [...new Set(cage.agentNames().map((a) => cage.agent(a).kind))];
    const missing = cage.backend.missingImages(kinds);
    check(missing.length === 0, missing.length ? `missing rootfs images: ${missing.join(', ')} (images/build-rootfs.sh <kind>)` : 'rootfs images present');
  }
  const tok = process.env[cage.config.telegram.tokenEnv];
  err(`${tok ? green('✓') : dim('-')} telegram token ${tok ? 'set' : `not set (${cage.config.telegram.tokenEnv}); only needed for \`cage bot\``}`);
  if (tok && cage.config.telegram.allowedUserIds.length === 0) check(false, 'telegram.allowedUserIds is empty (run `cage bot --discover`)');
  if (cage.config.redact.enabled) err(`${green('✓')} redaction on${cage.config.redact.command ? ` (external: ${cage.config.redact.command[0]})` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function cmdUp(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reprovision: { type: 'boolean' } } });
  const cage = load();
  for (const name of pickAgents(cage, positionals)) {
    err(bold(`▸ ${name}`));
    await cage.up(name, log, { reprovision: values.reprovision });
    const auth = await cage.authStatus(name).catch(() => undefined);
    if (auth) err(`${green('✓')} ${name} is up and logged in`);
    else err(`${yellow('→')} ${name} is up. Next: ${bold(`cage login ${name}`)}`);
  }
}

async function cmdUpdate(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const cage = load();
  for (const name of pickAgents(cage, positionals)) {
    err(bold(`▸ updating ${name}`));
    await cage.provision(name, log, 'update');
  }
}

async function cmdDown(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const cage = load();
  await Promise.all(pickAgents(cage, positionals).map((n) => cage.down(n, log)));
}

async function cmdDestroy(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { yes: { type: 'boolean' } } });
  const cage = load();
  const name = positionals[0];
  if (!name || positionals.length > 1) throw new Error('usage: cage destroy <agent> --yes');
  cage.agent(name);
  if (!values.yes) throw new Error(`This deletes ${name}'s VM, its files and its login. Re-run with --yes.`);
  await cage.destroy(name, log);
  err(`${green('✓')} destroyed ${name}`);
}

async function cmdStatus(args: string[]) {
  const { values } = parseArgs({ args, options: { 'no-auth': { type: 'boolean' } } });
  const cage = load();
  const rows = await cage.statusRows({ auth: !values['no-auth'] });
  const pad = (s: string, n: number) => s.padEnd(n);
  process.stdout.write(`${pad('AGENT', 14)}${pad('KIND', 8)}${pad('VM', 10)}${pad('LOGIN', 8)}MODEL\n`);
  for (const r of rows) {
    const auth = r.auth === undefined ? '-' : r.auth ? 'yes' : 'NO';
    process.stdout.write(`${pad(r.name, 14)}${pad(r.kind, 8)}${pad(r.enabled ? r.vm : 'disabled', 10)}${pad(auth, 8)}${r.model ?? 'default'}\n`);
    if (r.error) process.stdout.write(`  ${truncate(r.error, 200)}\n`);
  }
  process.stdout.write(`\nbackend: ${cage.backend.name}${cage.backend.isolated ? '' : ' (NO isolation)'}\n`);
}

async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (s: string) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          done();
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          done();
          return reject(new Error('aborted'));
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    stdin.on('data', onData);
  });
}

async function cmdLogin(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { browser: { type: 'boolean' }, token: { type: 'boolean' } } });
  const cage = load();
  const name = positionals[0];
  if (!name) throw new Error('usage: cage login <agent> [--browser|--token]');
  const adapter = cage.adapter(name);
  if ((await cage.backend.status(cage.vm(name))) !== 'running') throw new Error(`${name}'s VM is not running. Run: cage up ${name}`);
  if (values.token) {
    if (!adapter.token) throw new Error(`${adapter.label} has no token login; run \`cage login ${name}\``);
    err(adapter.token.how);
    const value = await readSecret(`${adapter.token.env}: `);
    if (!value) throw new Error('empty token');
    await cage.setToken(name, value);
    err(`${green('✓')} stored ${adapter.token.env} in ${cage.vm(name).name} (0600, never on a command line)`);
  } else {
    const { spec, instructions } = await cage.loginExec(name, { browser: values.browser });
    err(bold(`${adapter.label} login inside ${cage.vm(name).name}`));
    err(instructions + '\n');
    const code = await runInteractive(spec);
    if (code !== 0) err(yellow(`login command exited with ${code}`));
  }
  const ok = await cage.authStatus(name);
  if (ok) err(`${green('✓')} ${name} is logged in`);
  else {
    err(`${red('✗')} ${name} still reports not logged in`);
    process.exitCode = 1;
  }
}

async function cmdShell(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const cage = load();
  const name = positionals[0];
  if (!name) throw new Error('usage: cage shell <agent>');
  process.exitCode = await runInteractive(await cage.shellExec(name));
}

async function cmdRepo(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const cage = load();
  const arg = positionals[0];
  if (!arg) {
    process.stdout.write(`${cage.state.conversation('cli').repo ?? '(none)'}\n`);
    return;
  }
  cage.state.setRepo('cli', arg === 'off' ? undefined : arg);
  err(`${green('✓')} ${arg === 'off' ? 'repo cleared' : `repo set to ${arg}`} (CLI sessions reset)`);
}

async function cmdReset(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const cage = load();
  if (positionals[0]) cage.agent(positionals[0]);
  cage.state.clearSessions('cli', positionals[0]);
  err(`${green('✓')} cleared CLI session${positionals[0] ? ` for ${positionals[0]}` : 's'}`);
}

function printEvent(agent: string, multi: boolean, ev: AgentEvent) {
  const who = multi ? `${agent}: ` : '';
  if (ev.type === 'tool') err(dim(`  · ${who}${ev.name}${ev.detail ? ` — ${truncate(ev.detail, 100)}` : ''}`));
  else if (ev.type === 'warning') err(yellow(`  ! ${who}${truncate(ev.message, 200)}`));
}

function footer(r: RunResult): string {
  const bits = [`${(r.durationMs / 1000).toFixed(1)}s`];
  if (r.usage?.inputTokens !== undefined) bits.push(`${r.usage.inputTokens} in / ${r.usage.outputTokens ?? '?'} out tokens`);
  if (r.costUsd !== undefined) bits.push(`$${r.costUsd.toFixed(3)} API-equivalent`);
  if (r.resumed) bits.push('resumed session');
  if (r.redactions) bits.push(`${r.redactions} value(s) redacted`);
  return bits.join(' · ');
}

async function cmdAsk(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { new: { type: 'boolean' }, json: { type: 'boolean' }, conversation: { type: 'string', short: 'c' } },
  });
  const cage = load();
  let agents: string[];
  let words = positionals;
  if (words[0] === 'all') {
    agents = cage.agentNames();
    words = words.slice(1);
  } else if (words[0] && cage.agentNames({ includeDisabled: true }).includes(words[0])) {
    agents = [words[0]];
    words = words.slice(1);
  } else {
    agents = [cage.config.defaultAgent];
  }
  let prompt = words.join(' ');
  if (!prompt && !process.stdin.isTTY) {
    for await (const chunk of process.stdin) prompt += chunk;
  }
  prompt = prompt.trim();
  if (!prompt) throw new Error('usage: cage ask [agent|all] <prompt>   (or pipe the prompt on stdin)');

  const conversation = values.conversation ?? 'cli';
  let interrupts = 0;
  process.on('SIGINT', () => {
    if (++interrupts > 1) process.exit(130);
    err(yellow('\ncancelling… (Ctrl-C again to quit immediately)'));
    cage.cancel(conversation);
  });

  const multi = agents.length > 1;
  const results = await cage.runMany(agents, {
    conversation,
    prompt,
    newSession: values.new,
    onEvent: (agent, ev) => printEvent(agent, multi, ev),
  });

  if (values.json) {
    process.stdout.write(JSON.stringify(multi ? results : results[0], null, 2) + '\n');
  } else {
    for (const r of results) {
      if (multi) process.stdout.write(`\n${bold(`=== ${r.agent} ===`)}\n`);
      if (r.isError) err(red(`✗ ${r.agent}: ${r.errorMessage}`));
      else process.stdout.write(r.text.endsWith('\n') ? r.text : r.text + '\n');
      r.notes.forEach((n) => err(yellow(`ℹ ${n}`)));
      err(dim(`${r.agent} · ${footer(r)}`));
    }
  }
  if (results.some((r) => r.isError)) process.exitCode = 1;
}

async function cmdBot(args: string[]) {
  const { values } = parseArgs({ args, options: { discover: { type: 'boolean' }, 'allow-unsafe': { type: 'boolean' } } });
  const cage = load();
  const tg = cage.config.telegram;
  const token = process.env[tg.tokenEnv];
  if (!token) throw new Error(`Set ${tg.tokenEnv} to your bot token (from @BotFather).`);
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());
  const bot = new TelegramBot(cage, token, tg.allowedUserIds, (s) => err(`${dim(new Date().toISOString())} ${s}`));
  if (values.discover) return bot.discover(ac.signal);
  if (tg.allowedUserIds.length === 0) {
    throw new Error('telegram.allowedUserIds is empty; refusing to run a bot anyone can drive.\nRun `cage bot --discover`, message the bot, and put your id in the config.');
  }
  if (!cage.backend.isolated && !values['allow-unsafe']) {
    throw new Error('Backend is local-unsafe: the bot would give Telegram remote control of this machine. Pass --allow-unsafe if you really mean it.');
  }
  err(yellow('⚠ Telegram chats are not end-to-end encrypted; turn on redaction for sensitive data.'));
  await bot.run(ac.signal);
}

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  init: cmdInit,
  doctor: cmdDoctor,
  up: cmdUp,
  update: cmdUpdate,
  down: cmdDown,
  destroy: cmdDestroy,
  status: cmdStatus,
  login: cmdLogin,
  shell: cmdShell,
  ask: cmdAsk,
  repo: cmdRepo,
  reset: cmdReset,
  bot: cmdBot,
};

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP + '\n');
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  await fn(rest);
}

main(process.argv.slice(2)).catch((e: Error) => {
  if (e instanceof BusyError || e instanceof ConfigError) err(red(e.message));
  else err(red(`error: ${e.message}`));
  if (process.env.CAGE_DEBUG && e.stack) err(dim(e.stack));
  process.exitCode = process.exitCode || 1;
});
