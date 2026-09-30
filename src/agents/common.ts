import { truncate } from '../util.ts';

// Agent CLIs emit loosely-typed JSON; we probe it defensively rather than trusting a schema.
export type Json = any;

export function tryJson(line: string): Json | undefined {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const DETAIL_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'path', 'url', 'pattern', 'query', 'description'];

/** One-line human summary of a tool call's input, for progress display. */
export function summarizeInput(input: Json): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return truncate(input.replace(/\s+/g, ' '), 120);
  if (typeof input !== 'object') return undefined;
  for (const k of DETAIL_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v) return truncate(v.replace(/\s+/g, ' '), 120);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return truncate(v.join(' '), 120);
  }
  if (input.args && typeof input.args === 'object') return summarizeInput(input.args);
  return undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
