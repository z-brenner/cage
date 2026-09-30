import { spawn } from 'node:child_process';
import type { ExecSpec, Logger } from './types.ts';
import { LineSplitter, TailBuffer } from '../util.ts';

export interface StreamOptions {
  stdin?: string;
  onStdoutLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface ExitInfo {
  exitCode: number;
  signal: NodeJS.Signals | null;
}

/** Spawn and stream stdout line-by-line. Resolves on exit; aborting SIGTERMs (then SIGKILLs) the local process. */
export function runStreaming(spec: ExecSpec, opts: StreamOptions = {}): Promise<ExitInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, {
      env: spec.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => lines.push(d).forEach((l) => opts.onStdoutLine?.(l)));
    child.stderr.on('data', (d: string) => opts.onStderr?.(d));
    child.stdin.on('error', () => {}); // EPIPE if the process exits before reading stdin
    child.stdin.end(opts.stdin ?? '');

    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`failed to start ${spec.cmd}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      lines.flush().forEach((l) => opts.onStdoutLine?.(l));
      resolve({ exitCode: code ?? (signal ? 128 : 1), signal });
    });
  });
}

export interface Captured extends ExitInfo {
  stdout: string;
  stderr: string;
}

export async function runCapture(spec: ExecSpec, opts: { stdin?: string; timeoutMs?: number } = {}): Promise<Captured> {
  let stdout = '';
  const stderr = new TailBuffer(16384);
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  const info = await runStreaming(spec, {
    stdin: opts.stdin,
    signal,
    onStdoutLine: (l) => (stdout += l + '\n'),
    onStderr: (c) => stderr.push(c),
  });
  return { ...info, stdout, stderr: stderr.toString() };
}

/** Run with an attached terminal (logins, shells). Returns the exit code. */
export function runInteractive(spec: ExecSpec): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, { env: spec.env ?? process.env, stdio: 'inherit' });
    child.on('error', (err) => reject(new Error(`failed to start ${spec.cmd}: ${err.message}`)));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Run a host command, streaming its output to `log`; throws with the output tail on failure. */
export async function runLogged(cmd: string, args: string[], log: Logger, opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const tail = new TailBuffer(4000);
  const errLines = new LineSplitter();
  const info = await runStreaming(
    { cmd, args, env: opts.env },
    {
      stdin: opts.stdin,
      onStdoutLine: (l) => {
        tail.push(l + '\n');
        log(l);
      },
      onStderr: (c) => {
        tail.push(c);
        errLines.push(c).forEach(log);
      },
    },
  );
  errLines.flush().forEach(log);
  if (info.exitCode !== 0) {
    throw new Error(`\`${cmd} ${args.join(' ')}\` exited with ${info.exitCode}\n${tail.toString().trim()}`);
  }
}

export async function which(cmd: string): Promise<boolean> {
  try {
    const r = await runCapture({ cmd: 'sh', args: ['-c', `command -v "$1"`, 'sh', cmd] }, { timeoutMs: 5000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
