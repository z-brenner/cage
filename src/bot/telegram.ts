import type { AgentEvent } from '../agents/types.ts';
import type { Cage, RunResult } from '../cage.ts';
import { BusyError } from '../cage.ts';
import { sleep, truncate } from '../util.ts';

/**
 * Telegram front-end (long polling: no public URL, no webhook, works behind NAT).
 * Privacy note: Telegram bot chats are NOT end-to-end encrypted. Prompts and answers transit
 * Telegram's servers. Turn on redaction (`redact.enabled`) or use the CLI for sensitive work.
 */

export type BotCommand =
  | { kind: 'ask'; agents: string[]; prompt: string }
  | { kind: 'use'; agent?: string }
  | { kind: 'new'; agent?: string }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'repo'; url?: string; clear?: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export function parseCommand(text: string, agentNames: string[], defaultAgent: string): BotCommand {
  const t = text.trim();
  if (!t) return { kind: 'help' };
  const m = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(t);
  if (!t.startsWith('/') || !m) return { kind: 'ask', agents: [defaultAgent], prompt: t };
  const cmd = m[1]!.toLowerCase();
  const rest = (m[2] ?? '').trim();
  const known = (a: string) => agentNames.includes(a);
  switch (cmd) {
    case 'start':
    case 'help':
      return { kind: 'help' };
    case 'all':
      return rest ? { kind: 'ask', agents: [...agentNames], prompt: rest } : { kind: 'error', message: 'Usage: /all <prompt>' };
    case 'ask': {
      const a = /^(\S+)\s+([\s\S]+)$/.exec(rest);
      if (!a) return { kind: 'error', message: 'Usage: /ask <agent> <prompt>' };
      return known(a[1]!) ? { kind: 'ask', agents: [a[1]!], prompt: a[2]! } : { kind: 'error', message: `Unknown agent "${a[1]}". Agents: ${agentNames.join(', ')}` };
    }
    case 'use':
      if (!rest) return { kind: 'use' };
      return known(rest) ? { kind: 'use', agent: rest } : { kind: 'error', message: `Unknown agent "${rest}". Agents: ${agentNames.join(', ')}` };
    case 'new':
    case 'reset':
      if (!rest) return { kind: 'new' };
      return known(rest) ? { kind: 'new', agent: rest } : { kind: 'error', message: `Unknown agent "${rest}".` };
    case 'stop':
    case 'cancel':
      return { kind: 'stop' };
    case 'status':
      return { kind: 'status' };
    case 'repo':
      if (!rest) return { kind: 'repo' };
      if (rest === 'off' || rest === 'none') return { kind: 'repo', clear: true };
      return /^(https:\/\/|git@|ssh:\/\/)\S+$/.test(rest) ? { kind: 'repo', url: rest } : { kind: 'error', message: 'Usage: /repo <https://… or git@… URL> | /repo off' };
    default: {
      const agent = agentNames.find((a) => a.replace(/-/g, '_') === cmd);
      if (agent) return rest ? { kind: 'ask', agents: [agent], prompt: rest } : { kind: 'error', message: `Usage: /${cmd} <prompt>` };
      return { kind: 'error', message: `Unknown command /${cmd}. Try /help.` };
    }
  }
}

/** Telegram caps messages at 4096 chars; split on paragraph/line boundaries where possible. */
export function chunkText(text: string, max = 4000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim() || chunks.length === 0) chunks.push(rest);
  return chunks;
}

export function summarize(r: RunResult): string {
  const parts = [`${(r.durationMs / 1000).toFixed(0)}s`];
  if (r.usage?.inputTokens !== undefined || r.usage?.outputTokens !== undefined) {
    parts.push(`${kilo(r.usage.inputTokens)} in / ${kilo(r.usage.outputTokens)} out`);
  }
  if (r.costUsd !== undefined) parts.push(`$${r.costUsd.toFixed(2)} equiv.`);
  if (r.resumed) parts.push('resumed');
  if (r.redactions) parts.push(`${r.redactions} redacted`);
  return parts.join(' · ');
}

function kilo(n?: number): string {
  if (n === undefined) return '?';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function progressLine(agent: string, ev: AgentEvent): string | undefined {
  switch (ev.type) {
    case 'tool':
      return `⏳ ${agent}: ${ev.name}${ev.detail ? ` — ${truncate(ev.detail, 80)}` : ''}`;
    case 'warning':
      return `⏳ ${agent}: ⚠ ${truncate(ev.message, 100)}`;
    case 'text':
      return `⏳ ${agent}: ✍ ${truncate(ev.text.replace(/\s+/g, ' ').trim(), 100)}`;
    default:
      return undefined;
  }
}

const HELP = (agents: string[], def: string) => `cage: your agents, each caged in its own VM.

Plain text → default agent (now: ${def})
${agents.map((a) => `/${a.replace(/-/g, '_')} <prompt>`).join('\n')}
/ask <agent> <prompt>
/all <prompt> — every agent in parallel
/use <agent> — change default agent
/new [agent] — fresh session(s)
/repo <git url> | /repo off — work inside a repo
/stop — cancel running tasks
/status — VMs and logins

⚠ Telegram chats are not end-to-end encrypted.`;

interface TgUser {
  id: number;
  username?: string;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export class TelegramError extends Error {
  readonly code: number;
  readonly retryAfter?: number;
  constructor(code: number, description: string, retryAfter?: number) {
    super(`Telegram API ${code}: ${description}`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class TelegramBot {
  private readonly cage: Cage;
  private readonly token: string;
  private readonly allowed: Set<number>;
  private readonly log: (s: string) => void;
  private offset = 0;
  private readonly ignoredUsers = new Set<number>();

  constructor(cage: Cage, token: string, allowedUserIds: number[], log: (s: string) => void) {
    this.cage = cage;
    this.token = token;
    this.allowed = new Set(allowedUserIds);
    this.log = log;
  }

  private async api<T>(method: string, body: Record<string, unknown>, attempt = 0): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(75_000),
    });
    const j = (await res.json()) as { ok: boolean; result: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (j.ok) return j.result;
    const err = new TelegramError(j.error_code ?? res.status, j.description ?? 'unknown error', j.parameters?.retry_after);
    if (err.code === 429 && attempt < 3) {
      await sleep(((err.retryAfter ?? 1) + 0.5) * 1000);
      return this.api(method, body, attempt + 1);
    }
    throw err;
  }

  private send(chatId: number, text: string, replyTo?: number): Promise<TgMessage> {
    return this.api<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
  }

  private async edit(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.api('editMessageText', { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true } });
    } catch (err) {
      if (!(err instanceof TelegramError && /not modified/i.test(err.message))) this.log(`edit failed: ${(err as Error).message}`);
    }
  }

  private async poll(): Promise<TgUpdate[]> {
    const updates = await this.api<TgUpdate[]>('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message'] });
    for (const u of updates) this.offset = Math.max(this.offset, u.update_id + 1);
    return updates;
  }

  /** Prints the ids of whoever messages the bot, so you can fill telegram.allowedUserIds. */
  async discover(signal: AbortSignal): Promise<void> {
    const me = await this.api<{ username: string }>('getMe', {});
    this.log(`Send any message to @${me.username} now. Ctrl-C to stop.`);
    while (!signal.aborted) {
      for (const u of await this.poll()) {
        const f = u.message?.from;
        if (f) this.log(`user id ${f.id}${f.username ? ` (@${f.username})` : ''} said: ${truncate(u.message?.text ?? '', 60)}`);
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const me = await this.api<{ username: string }>('getMe', {});
    const commands = [
      ...this.cage.agentNames().map((a) => ({ command: a.replace(/-/g, '_'), description: `Ask ${a}` })),
      { command: 'all', description: 'Ask every agent in parallel' },
      { command: 'use', description: 'Set the default agent' },
      { command: 'new', description: 'Start fresh session(s)' },
      { command: 'repo', description: 'Work inside a git repo' },
      { command: 'stop', description: 'Cancel running tasks' },
      { command: 'status', description: 'VMs and logins' },
      { command: 'help', description: 'Help' },
    ].filter((c) => /^[a-z0-9_]{1,32}$/.test(c.command));
    await this.api('setMyCommands', { commands }).catch((e: Error) => this.log(`setMyCommands: ${e.message}`));
    this.log(`@${me.username} is listening (allowed users: ${[...this.allowed].join(', ')})`);

    let backoff = 1000;
    while (!signal.aborted) {
      let updates: TgUpdate[];
      try {
        updates = await this.poll();
        backoff = 1000;
      } catch (err) {
        if (err instanceof TelegramError && err.code === 401) throw new Error('Telegram rejected the bot token (401).');
        if (err instanceof TelegramError && err.code === 409) throw new Error('Another process is polling this bot (409). Stop it or remove the webhook.');
        this.log(`poll failed: ${(err as Error).message}; retrying in ${backoff / 1000}s`);
        await sleep(backoff, signal).catch(() => undefined);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      for (const u of updates) {
        if (u.message) this.onMessage(u.message).catch((err: Error) => this.log(`handler error: ${err.stack ?? err.message}`));
      }
    }
  }

  private async onMessage(msg: TgMessage): Promise<void> {
    const from = msg.from;
    if (!from || !this.allowed.has(from.id)) {
      // Stay silent to strangers; tell the owner how to allow them.
      if (from && !this.ignoredUsers.has(from.id)) {
        this.ignoredUsers.add(from.id);
        this.log(`ignored message from user ${from.id}${from.username ? ` (@${from.username})` : ''}; add the id to telegram.allowedUserIds to allow`);
      }
      return;
    }
    const chatId = msg.chat.id;
    const text = msg.text ?? msg.caption;
    if (!text) {
      await this.send(chatId, 'Text only for now.', msg.message_id);
      return;
    }
    const conv = `tg-${chatId}`;
    const agents = this.cage.agentNames();
    const state = this.cage.state.conversation(conv);
    const def = state.defaultAgent && agents.includes(state.defaultAgent) ? state.defaultAgent : this.cage.config.defaultAgent;
    const cmd = parseCommand(text, agents, def);

    switch (cmd.kind) {
      case 'help':
        await this.send(chatId, HELP(agents, def));
        return;
      case 'error':
        await this.send(chatId, cmd.message, msg.message_id);
        return;
      case 'use':
        if (cmd.agent) this.cage.state.setDefaultAgent(conv, cmd.agent);
        await this.send(chatId, `Default agent: ${cmd.agent ?? def}`);
        return;
      case 'new':
        this.cage.state.clearSessions(conv, cmd.agent);
        await this.send(chatId, `Fresh session${cmd.agent ? ` for ${cmd.agent}` : 's for all agents'}.`);
        return;
      case 'stop': {
        const n = this.cage.cancel(conv);
        await this.send(chatId, n ? `Cancelling ${n} task(s)…` : 'Nothing running.');
        return;
      }
      case 'repo':
        if (cmd.clear || cmd.url) this.cage.state.setRepo(conv, cmd.url);
        await this.send(
          chatId,
          cmd.url
            ? `Repo set: ${cmd.url}\nEach agent clones it inside its own VM on first use. Sessions were reset.\nPrivate repos need credentials inside each VM (cage shell <agent>).`
            : cmd.clear
              ? 'Repo cleared; sessions were reset.'
              : `Repo: ${state.repo ?? '(none)'}`,
        );
        return;
      case 'status': {
        const rows = await this.cage.statusRows({ auth: true });
        const lines = rows.map(
          (r) =>
            `${r.name} (${r.kind}): ${r.enabled ? r.vm : 'disabled'}` +
            (r.auth === true ? ', logged in' : r.auth === false ? ', NOT logged in' : '') +
            (r.error ? ` — ${truncate(r.error, 120)}` : ''),
        );
        await this.send(chatId, `${lines.join('\n')}\n\nbackend: ${this.cage.backend.name} · default: ${def}${state.repo ? `\nrepo: ${state.repo}` : ''}`);
        return;
      }
      case 'ask':
        await this.ask(chatId, conv, cmd.agents, cmd.prompt, msg.message_id);
        return;
    }
  }

  private async ask(chatId: number, conv: string, agents: string[], prompt: string, replyTo: number): Promise<void> {
    const typing = setInterval(() => void this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined), 4500);
    void this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
    try {
      await Promise.all(agents.map((agent) => this.askOne(chatId, conv, agent, prompt, replyTo, agents.length > 1)));
    } finally {
      clearInterval(typing);
    }
  }

  private async askOne(chatId: number, conv: string, agent: string, prompt: string, replyTo: number, multi: boolean): Promise<void> {
    const status = await this.send(chatId, `⏳ ${agent}: working…`, replyTo);
    let lastEdit = 0;
    let shown = '';
    let pending: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      if (pending && pending !== shown) {
        shown = pending;
        lastEdit = Date.now();
        void this.edit(chatId, status.message_id, pending);
      }
    };
    const onEvent = (ev: AgentEvent) => {
      const line = progressLine(agent, ev);
      if (!line) return;
      pending = line;
      if (!timer) timer = setTimeout(flush, Math.max(0, 2500 - (Date.now() - lastEdit)));
    };

    let result: RunResult;
    try {
      result = await this.cage.run({ conversation: conv, agent, prompt, onEvent });
    } catch (err) {
      if (timer) clearTimeout(timer);
      const busy = err instanceof BusyError;
      await this.edit(chatId, status.message_id, `${busy ? '⏸' : '❌'} ${agent}: ${(err as Error).message}`);
      return;
    }
    if (timer) clearTimeout(timer);
    await this.edit(chatId, status.message_id, `${result.isError ? (result.cancelled ? '⏹' : '❌') : '✅'} ${agent} · ${summarize(result)}`);

    const header = multi ? `— ${agent} —\n` : '';
    const body = result.isError ? `${agent} failed: ${result.errorMessage ?? 'unknown error'}` : result.text || '(empty answer)';
    const notes = result.notes.length ? `\n\nℹ ${result.notes.join('\nℹ ')}` : '';
    for (const chunk of chunkText(header + body + notes)) await this.send(chatId, chunk);
  }
}
