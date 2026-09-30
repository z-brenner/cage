import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS, type AgentAdapter, type AgentEvent, type AgentKind, type Usage } from './agents/index.ts';
import type { AgentConfig, CageConfig } from './config.ts';
import { Redactor } from './redact.ts';
import { buildCancelScript, buildCommandScript, buildRunScript, buildSetEnvScript, envLine } from './remote.ts';
import { StateStore } from './state.ts';
import { PKG_ROOT, randomId, shq, slug, TailBuffer, truncate } from './util.ts';
import { createBackend, type ExecSpec, type Logger, type VmBackend, type VmSpec, type VmStatus } from './vm/index.ts';
import { runCapture, runStreaming } from './vm/proc.ts';

export interface RunRequest {
  /** Conversation key: "cli", "tg-<chatId>", … Sessions and workspaces are per conversation. */
  conversation: string;
  agent: string;
  prompt: string;
  newSession?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

export interface RunResult {
  agent: string;
  kind: AgentKind;
  text: string;
  isError: boolean;
  errorMessage?: string;
  sessionId?: string;
  resumed: boolean;
  usage?: Usage;
  costUsd?: number;
  durationMs: number;
  exitCode: number;
  cancelled: boolean;
  timedOut: boolean;
  redactions: number;
  notes: string[];
}

export interface StatusRow {
  name: string;
  kind: AgentKind;
  enabled: boolean;
  vm: VmStatus | 'error';
  auth?: boolean;
  model?: string;
  error?: string;
}

export class BusyError extends Error {}

// Messages the CLIs print when a resume target is gone (VM rebuilt, state wiped). Kept specific on
// purpose: a usage-limit error that merely mentions a "session" must not throw away your context.
//   claude: "No conversation found with session ID: …"
//   codex:  "thread/resume failed: no rollout found for thread id …"
//   gemini: "Error resuming session: No previous sessions found for this project."
export const LOST_SESSION =
  /no conversation found|no rollout found|thread\/resume failed|error resuming session|no previous sessions found|invalid session identifier|\b(session|chat|conversation|thread)( id)?\b[^\n]{0,40}\bnot found|could not (find|resume|load) (the )?(session|chat|conversation)/i;
const AUTH_PROBLEM = /\blog ?in\b|login|auth|unauthori[sz]ed|\b401\b|\b403\b|credential|expired token|invalid token|oauth/i;

export function repoName(url: string): string {
  const last = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? 'repo';
  return slug(last.replace(/\.git$/, '')).replace(/^\.+/, '') || 'repo';
}

export function workspaceFor(conversation: string, repo?: string): string {
  const base = slug(conversation).replace(/^\.+/, '') || 'default';
  return repo ? `${base}/${repoName(repo)}` : base;
}

export class Cage {
  readonly config: CageConfig;
  readonly backend: VmBackend;
  readonly state: StateStore;
  readonly redactor: Redactor;
  private readonly running = new Map<string, AbortController>();

  constructor(config: CageConfig, opts: { backend?: VmBackend; state?: StateStore } = {}) {
    this.config = config;
    this.backend = opts.backend ?? createBackend(config);
    this.state = opts.state ?? new StateStore();
    this.redactor = new Redactor(config.redact);
  }

  agentNames(opts: { includeDisabled?: boolean } = {}): string[] {
    return Object.values(this.config.agents)
      .filter((a) => opts.includeDisabled || a.enabled)
      .map((a) => a.name);
  }

  agent(name: string): AgentConfig {
    const a = this.config.agents[name];
    if (!a) throw new Error(`Unknown agent "${name}". Configured: ${this.agentNames({ includeDisabled: true }).join(', ')}`);
    if (!a.enabled) throw new Error(`Agent "${name}" is disabled in config.`);
    return a;
  }

  adapter(name: string): AgentAdapter {
    return ADAPTERS[this.agent(name).kind];
  }

  vm(name: string): VmSpec {
    return { name: `cage-${name}`, agent: this.agent(name) };
  }

  // ---------------------------------------------------------------- lifecycle

  async up(name: string, log: Logger, opts: { reprovision?: boolean } = {}): Promise<void> {
    const vm = this.vm(name);
    await this.backend.up(vm, log);
    if (this.backend.needsProvision) await this.provision(name, log, opts.reprovision ? 'update' : 'install');
  }

  /** Pipes guest/provision.sh into `sudo bash -s` in the guest. Idempotent; 'update' reinstalls the CLI. */
  async provision(name: string, log: Logger, mode: 'install' | 'update'): Promise<void> {
    if (!this.backend.isolated) {
      log('local-unsafe backend: nothing to provision (uses the CLIs installed on this machine)');
      return;
    }
    const vm = this.vm(name);
    const script = readFileSync(join(PKG_ROOT, 'guest', 'provision.sh'), 'utf8');
    const cmd = `sudo -n bash -s -- ${shq(vm.agent.kind)}${mode === 'update' ? ' --update' : ''}`;
    const spec = await this.backend.exec(vm, buildCommandScript(cmd));
    const tail = new TailBuffer(4000);
    const info = await runStreaming(spec, {
      stdin: script,
      onStdoutLine: (l) => {
        tail.push(l + '\n');
        log(l);
      },
      onStderr: (c) => {
        tail.push(c);
        c.split('\n').filter((l) => l.trim()).forEach(log);
      },
    });
    if (info.exitCode !== 0) throw new Error(`provisioning ${vm.name} failed (exit ${info.exitCode}):\n${tail.toString().trim()}`);
  }

  async down(name: string, log: Logger): Promise<void> {
    await this.backend.down(this.vm(name), log);
  }

  async destroy(name: string, log: Logger): Promise<void> {
    await this.backend.destroy(this.vm(name), log);
    for (const conv of this.state.conversationKeys()) this.state.clearSessions(conv, name);
  }

  // ---------------------------------------------------------------- auth

  async authStatus(name: string): Promise<boolean | undefined> {
    const vm = this.vm(name);
    if ((await this.backend.status(vm)) !== 'running') return undefined;
    const adapter = ADAPTERS[vm.agent.kind];
    const r = await runCapture(await this.backend.exec(vm, buildCommandScript(adapter.authCheck.command)), { timeoutMs: 60_000 });
    return adapter.authCheck.parse(r.stdout, r.exitCode);
  }

  async loginExec(name: string, opts: { browser?: boolean }): Promise<{ spec: ExecSpec; instructions: string }> {
    const vm = this.vm(name);
    const flow = ADAPTERS[vm.agent.kind].login(opts);
    const spec = await this.backend.exec(vm, buildCommandScript(flow.command, { cwd: 'work' }), { tty: true, forwardPorts: flow.forwardPorts });
    return { spec, instructions: flow.instructions };
  }

  async shellExec(name: string): Promise<ExecSpec> {
    return this.backend.exec(this.vm(name), buildCommandScript('exec bash -l', { cwd: 'work' }), { tty: true });
  }

  /** Stores a token in the guest's 0600 env file; the value travels on stdin only. */
  async setToken(name: string, value: string): Promise<string> {
    const vm = this.vm(name);
    const token = ADAPTERS[vm.agent.kind].token;
    if (!token) throw new Error(`${vm.agent.kind} has no token-based login; use \`cage login ${name}\``);
    const lines: [string, string][] = [[token.env, value.trim()], ...Object.entries(token.extra ?? {})];
    for (const [k, v] of lines) {
      const r = await runCapture(await this.backend.exec(vm, buildSetEnvScript(k)), { stdin: envLine(k, v), timeoutMs: 30_000 });
      if (r.exitCode !== 0) throw new Error(`failed to store ${k} in ${vm.name}: ${r.stderr.trim()}`);
    }
    return token.env;
  }

  // ---------------------------------------------------------------- status

  async statusRows(opts: { auth?: boolean } = {}): Promise<StatusRow[]> {
    return Promise.all(
      Object.values(this.config.agents).map(async (a): Promise<StatusRow> => {
        const row: StatusRow = { name: a.name, kind: a.kind, enabled: a.enabled, vm: 'absent', model: a.model };
        if (!a.enabled) return row;
        try {
          row.vm = await this.backend.status(this.vm(a.name));
          if (opts.auth && row.vm === 'running') row.auth = await this.authStatus(a.name);
        } catch (err) {
          row.vm = 'error';
          row.error = (err as Error).message;
        }
        return row;
      }),
    );
  }

  // ---------------------------------------------------------------- tasks

  isBusy(conversation: string, agent: string): boolean {
    return this.running.has(`${conversation}\u0000${agent}`);
  }

  /** Cancels running tasks in a conversation (optionally one agent). Returns how many were cancelled. */
  cancel(conversation: string, agent?: string): number {
    let n = 0;
    for (const [key, ctl] of this.running) {
      const [conv, name] = key.split('\u0000');
      if (conv === conversation && (!agent || agent === name)) {
        ctl.abort(new Error('cancelled'));
        n++;
      }
    }
    return n;
  }

  async runMany(agents: string[], req: Omit<RunRequest, 'agent' | 'onEvent'> & { onEvent?: (agent: string, e: AgentEvent) => void }): Promise<RunResult[]> {
    return Promise.all(
      agents.map((agent) =>
        this.run({ ...req, agent, onEvent: (e) => req.onEvent?.(agent, e) }).catch((err: Error) => failedResult(agent, this.config.agents[agent]?.kind ?? 'claude', err)),
      ),
    );
  }

  async run(req: RunRequest): Promise<RunResult> {
    const cfg = this.agent(req.agent);
    const adapter = ADAPTERS[cfg.kind];
    const vm = this.vm(cfg.name);
    const key = `${req.conversation}\u0000${cfg.name}`;
    if (this.running.has(key)) {
      throw new BusyError(`${cfg.name} is still working on the previous message here (/stop cancels it).`);
    }
    const ctl = new AbortController();
    this.running.set(key, ctl);
    try {
      const status = await this.backend.status(vm);
      if (status === 'absent') throw new Error(`${cfg.name}'s VM doesn't exist yet. Run: cage up ${cfg.name}`);
      if (status === 'stopped') {
        req.onEvent?.({ type: 'warning', message: `starting ${vm.name}…` });
        await this.backend.up(vm, () => {});
      }

      const masked = await this.redactor.mask(req.prompt, req.conversation);
      if (req.newSession) this.state.clearSessions(req.conversation, cfg.name);
      const conv = this.state.conversation(req.conversation);
      const sessionId = conv.sessions[cfg.name]?.sessionId;
      const signals = [ctl.signal, ...(req.signal ? [req.signal] : [])];
      const base = { cfg, adapter, vm, prompt: masked.text, conversation: req.conversation, repo: conv.repo, signals, restore: masked.restore, onEvent: req.onEvent };

      let result = await this.attempt({ ...base, sessionId });
      if (sessionId && result.isError && !result.cancelled && !result.timedOut && LOST_SESSION.test(result.errorMessage ?? '')) {
        // The stored id is only replaced if the fresh attempt yields a new session (below).
        result = await this.attempt({ ...base, sessionId: undefined });
        result.notes.push(
          result.isError
            ? 'The previous session could not be resumed, and a fresh attempt failed too.'
            : 'The previous session could not be resumed, so this started a new one.',
        );
      }
      if (result.sessionId && !result.cancelled) this.state.setSession(req.conversation, cfg.name, result.sessionId);
      result.redactions = masked.count;
      return result;
    } finally {
      this.running.delete(key);
    }
  }

  private async attempt(a: {
    cfg: AgentConfig;
    adapter: AgentAdapter;
    vm: VmSpec;
    prompt: string;
    conversation: string;
    repo?: string;
    sessionId?: string;
    signals: AbortSignal[];
    restore: (s: string) => string;
    onEvent?: (e: AgentEvent) => void;
  }): Promise<RunResult> {
    const started = Date.now();
    const notes: string[] = [];
    const autonomy = this.backend.isolated ? a.cfg.autonomy : 'safe';
    if (!this.backend.isolated && a.cfg.autonomy === 'full') notes.push('local-unsafe backend: ran with autonomy "safe" (no VM isolation).');
    const command = a.adapter.run({ model: a.cfg.model, sessionId: a.sessionId, autonomy, extraArgs: a.cfg.extraArgs });
    const runId = randomId();
    const script = buildRunScript({ runId, workspace: workspaceFor(a.conversation, a.repo), repo: a.repo, command });
    const spec = await this.backend.exec(a.vm, script);
    const prompt = a.adapter.preparePrompt ? a.adapter.preparePrompt(a.prompt) : a.prompt;

    const parser = a.adapter.parser();
    const stderr = new TailBuffer(8000);
    let final: Extract<AgentEvent, { type: 'result' }> | undefined;
    let sessionId: string | undefined;
    const handle = (ev: AgentEvent) => {
      if (ev.type === 'session') sessionId = ev.sessionId;
      if (ev.type === 'result') {
        final = ev;
        return;
      }
      if (ev.type === 'text') a.onEvent?.({ type: 'text', text: a.restore(ev.text) });
      else a.onEvent?.(ev);
    };

    const timeout = AbortSignal.timeout(a.cfg.timeoutSec * 1000);
    const abort = AbortSignal.any([...a.signals, timeout]);
    const localKill = new AbortController();
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      void (async () => {
        try {
          // Kill the agent's process group in the guest; the SSH session then ends by itself.
          const c = await this.backend.exec(a.vm, buildCancelScript(runId));
          await runCapture(c, { timeoutMs: 20_000 });
        } catch {
          /* fall through to killing the local transport */
        } finally {
          setTimeout(() => localKill.abort(), 2000).unref();
        }
      })();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener('abort', onAbort, { once: true });

    let exitCode: number;
    try {
      const info = await runStreaming(spec, {
        stdin: prompt,
        signal: localKill.signal,
        onStdoutLine: (line) => parser.push(line).forEach(handle),
        onStderr: (c) => stderr.push(c),
      });
      exitCode = info.exitCode;
    } finally {
      abort.removeEventListener('abort', onAbort);
    }
    parser.end(exitCode).forEach(handle);

    const timedOut = timeout.aborted;
    const res = final ?? { type: 'result' as const, text: '', isError: true };
    let errorMessage = res.isError ? res.errorMessage : undefined;
    const errTail = stderr.toString().trim();
    if (res.isError || !res.text) {
      if (timedOut) errorMessage = `timed out after ${a.cfg.timeoutSec}s`;
      else if (cancelled) errorMessage = 'cancelled';
      else if (exitCode === 127) errorMessage = `${a.adapter.binary} is not installed in ${a.vm.name}. Run: cage update ${a.cfg.name}`;
      else if (exitCode === 96) errorMessage = `git clone of ${a.repo} failed inside ${a.vm.name}${errTail ? `:\n${truncate(errTail, 800)}` : ''}`;
      else if (exitCode === 97) errorMessage = `could not prepare the workspace in ${a.vm.name}`;
      else if (errTail) errorMessage = `${errorMessage ?? `exit code ${exitCode}`}\n${truncate(errTail.slice(-1500), 1500)}`;
      errorMessage ??= res.text ? undefined : `no answer (exit code ${exitCode})`;
    }
    const isError = res.isError || cancelled || timedOut || (!res.text && exitCode !== 0);
    if (isError && errorMessage && !cancelled && !timedOut && AUTH_PROBLEM.test(errorMessage)) {
      notes.push(`This looks like a login problem. Fix it with: cage login ${a.cfg.name}`);
    }
    return {
      agent: a.cfg.name,
      kind: a.cfg.kind,
      text: a.restore(res.text),
      isError,
      errorMessage: isError ? a.restore(errorMessage ?? 'failed') : undefined,
      sessionId: res.sessionId ?? sessionId,
      resumed: a.sessionId !== undefined,
      usage: res.usage,
      costUsd: res.costUsd,
      durationMs: Date.now() - started,
      exitCode,
      cancelled,
      timedOut,
      redactions: 0,
      notes,
    };
  }
}

function failedResult(agent: string, kind: AgentKind, err: Error): RunResult {
  return {
    agent,
    kind,
    text: '',
    isError: true,
    errorMessage: err.message,
    resumed: false,
    durationMs: 0,
    exitCode: -1,
    cancelled: false,
    timedOut: false,
    redactions: 0,
    notes: [],
  };
}
