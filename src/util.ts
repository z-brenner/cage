import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the installed package (works from both src/ and dist/). */
export const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function cageHome(): string {
  return process.env.CAGE_HOME ?? join(homedir(), '.cage');
}

export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** POSIX single-quote escaping: the result is always exactly one shell word. */
export function shq(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\-+=/.,:@%]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shJoin(argv: readonly string[]): string {
  return argv.map(shq).join(' ');
}

/** Splits a byte stream into complete lines; keeps the partial tail buffered. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, ''));
  }
  flush(): string[] {
    const rest = this.buf.replace(/\r$/, '');
    this.buf = '';
    return rest ? [rest] : [];
  }
}

/** Keeps only the last `max` characters written to it (for stderr tails). */
export class TailBuffer {
  private s = '';
  private readonly max: number;
  constructor(max = 8192) {
    this.max = max;
  }
  push(chunk: string): void {
    this.s = (this.s + chunk).slice(-this.max);
  }
  toString(): string {
    return this.s;
  }
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
  }
}

/** Atomic write (tmp + rename) so a crash never leaves a half-written file. */
export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  renameSync(tmp, path);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Filesystem-safe slug for workspace / VM names. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'default';
}

export function randomId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
