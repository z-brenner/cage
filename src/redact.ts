import type { RedactConfig } from './config.ts';
import { runCapture } from './vm/proc.ts';

/**
 * Pre-send masking. Sensitive values are replaced with stable placeholders ([[EMAIL_1]]) before the
 * prompt leaves the host; placeholders in the agent's reply are swapped back locally, so the model
 * never sees the real value but you do.
 *
 * Limits (by design, not bugs):
 *  - Restoration only applies to the chat reply. Files the agent writes inside its VM keep placeholders.
 *  - Tasks that need the real value (e.g. "connect to 10.0.0.5") will not work while masked.
 *  - The placeholder↔value vault lives in memory only; it is lost on restart.
 */

interface Rule {
  type: string;
  re: RegExp;
  accept?: (match: string) => boolean;
}

// Ordered most-specific first so e.g. a JWT isn't half-eaten by the API key rule.
const RULES: Rule[] = [
  { type: 'PRIVATE_KEY', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { type: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    type: 'SECRET',
    re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
  },
  { type: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'SSN', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { type: 'CARD', re: /\b\d(?:[ -]?\d){12,18}\b/g, accept: (m) => luhn(m.replace(/\D/g, '')) },
  { type: 'PHONE', re: /(?<![\w+])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\w)/g },
  { type: 'IP', re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g },
];

export function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const PLACEHOLDER = /\[\[([A-Z_]+_\d+)\]\]/g;

class Vault {
  private byValue = new Map<string, string>();
  private byPlaceholder = new Map<string, string>();
  private counters = new Map<string, number>();

  placeholderFor(type: string, value: string): string {
    const existing = this.byValue.get(value);
    if (existing) return existing;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const ph = `[[${type}_${n}]]`;
    this.byValue.set(value, ph);
    this.byPlaceholder.set(ph, value);
    return ph;
  }

  add(placeholder: string, original: string): void {
    this.byValue.set(original, placeholder);
    this.byPlaceholder.set(placeholder, original);
  }

  restore(text: string): string {
    return text.replace(PLACEHOLDER, (m) => this.byPlaceholder.get(m) ?? m);
  }
}

export interface Masked {
  text: string;
  count: number;
  restore(text: string): string;
}

export function maskBuiltin(text: string, vault: Vault): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (m) => {
      if (rule.accept && !rule.accept(m)) return m;
      count++;
      return vault.placeholderFor(rule.type, m);
    });
  }
  return { text: out, count };
}

export class Redactor {
  private readonly cfg: RedactConfig;
  private readonly vaults = new Map<string, Vault>();

  constructor(cfg: RedactConfig) {
    this.cfg = cfg;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  private vault(conversation: string): Vault {
    let v = this.vaults.get(conversation);
    if (!v) this.vaults.set(conversation, (v = new Vault()));
    return v;
  }

  /** Fails closed: if the external masker errors, the prompt is not sent. */
  async mask(text: string, conversation: string): Promise<Masked> {
    const vault = this.vault(conversation);
    if (!this.cfg.enabled) return { text, count: 0, restore: (t) => t };
    let out = text;
    let count = 0;
    if (this.cfg.command) {
      const [cmd, ...args] = this.cfg.command as [string, ...string[]];
      const r = await runCapture({ cmd, args }, { stdin: JSON.stringify({ text: out }), timeoutMs: 30_000 });
      if (r.exitCode !== 0) throw new Error(`redaction command failed (exit ${r.exitCode}); prompt NOT sent.\n${r.stderr.trim()}`);
      let parsed: { text?: unknown; replacements?: { placeholder?: unknown; original?: unknown }[] };
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        throw new Error('redaction command returned invalid JSON; prompt NOT sent.');
      }
      if (typeof parsed.text !== 'string') throw new Error('redaction command returned no "text"; prompt NOT sent.');
      out = parsed.text;
      for (const rep of parsed.replacements ?? []) {
        if (typeof rep.placeholder === 'string' && typeof rep.original === 'string') {
          vault.add(rep.placeholder, rep.original);
          count++;
        }
      }
    }
    if (this.cfg.builtin) {
      const b = maskBuiltin(out, vault);
      out = b.text;
      count += b.count;
    }
    return { text: out, count, restore: (t) => vault.restore(t) };
  }
}

export { Vault };
