import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_KINDS, type AgentKind, type Autonomy } from './agents/types.ts';
import { cageHome, expandHome, readJson, writeJsonAtomic } from './util.ts';

export type BackendName = 'lima' | 'firecracker' | 'local-unsafe';
export const BACKENDS: readonly BackendName[] = ['lima', 'firecracker', 'local-unsafe'];

export interface AgentConfig {
  /** Config key; also names the VM (`cage-<name>`). Lets you run e.g. two Claude VMs. */
  name: string;
  kind: AgentKind;
  enabled: boolean;
  model?: string;
  autonomy: Autonomy;
  cpus: number;
  memoryMiB: number;
  diskGiB: number;
  timeoutSec: number;
  extraArgs: string[];
}

export interface RedactConfig {
  enabled: boolean;
  /** Built-in regex detectors (emails, keys, cards, SSNs, phones, IPs). */
  builtin: boolean;
  /**
   * Optional external masker, argv form, e.g. ["sonomos-mask", "--json"].
   * Protocol: stdin {"text": string} → stdout {"text": string, "replacements": [{"placeholder","original"}]}.
   */
  command?: string[];
}

export interface CageConfig {
  backend: BackendName;
  defaultAgent: string;
  agents: Record<string, AgentConfig>;
  telegram: { tokenEnv: string; allowedUserIds: number[] };
  redact: RedactConfig;
  lima: { limactl: string };
  firecracker: { binary: string; kernel: string; imagesDir: string; subnetBase: string };
}

const AGENT_DEFAULTS = { enabled: true, autonomy: 'full' as Autonomy, cpus: 2, memoryMiB: 4096, diskGiB: 30, timeoutSec: 3600 };

export function configPath(): string {
  return process.env.CAGE_CONFIG ?? join(cageHome(), 'config.json');
}

/** What `cage init` writes: only the knobs people actually change. */
export function starterConfig(backend: BackendName): Record<string, unknown> {
  return {
    backend,
    defaultAgent: 'claude',
    agents: {
      claude: { kind: 'claude' },
      codex: { kind: 'codex' },
      gemini: { kind: 'gemini' },
      cursor: { kind: 'cursor' },
    },
    telegram: { tokenEnv: 'CAGE_TELEGRAM_TOKEN', allowedUserIds: [] },
    redact: { enabled: false, builtin: true },
  };
}

export class ConfigError extends Error {}

type Raw = Record<string, any>;

export function parseConfig(raw: Raw): CageConfig {
  const errors: string[] = [];
  const backend = (raw.backend ?? 'lima') as BackendName;
  if (!BACKENDS.includes(backend)) errors.push(`backend must be one of ${BACKENDS.join(', ')}`);

  const agents: Record<string, AgentConfig> = {};
  for (const [name, a] of Object.entries<Raw>(raw.agents ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(name)) {
      errors.push(`agent name "${name}" must match [a-z][a-z0-9-]{0,23}`);
      continue;
    }
    const kind = (a?.kind ?? name) as AgentKind;
    if (!AGENT_KINDS.includes(kind)) {
      errors.push(`agents.${name}.kind must be one of ${AGENT_KINDS.join(', ')}`);
      continue;
    }
    const merged: Raw = { ...AGENT_DEFAULTS, ...a };
    if (!['full', 'safe'].includes(merged.autonomy)) errors.push(`agents.${name}.autonomy must be "full" or "safe"`);
    for (const k of ['cpus', 'memoryMiB', 'diskGiB', 'timeoutSec'] as const) {
      if (!Number.isInteger(merged[k]) || merged[k] <= 0) errors.push(`agents.${name}.${k} must be a positive integer`);
    }
    agents[name] = {
      name,
      kind,
      enabled: merged.enabled !== false,
      model: typeof merged.model === 'string' && merged.model ? merged.model : undefined,
      autonomy: merged.autonomy,
      cpus: merged.cpus,
      memoryMiB: merged.memoryMiB,
      diskGiB: merged.diskGiB,
      timeoutSec: merged.timeoutSec,
      extraArgs: Array.isArray(merged.extraArgs) ? merged.extraArgs.map(String) : [],
    };
  }
  if (Object.keys(agents).length === 0 && errors.length === 0) errors.push('no agents configured');

  const defaultAgent = String(raw.defaultAgent ?? Object.keys(agents)[0] ?? '');
  if (Object.keys(agents).length && !agents[defaultAgent]) errors.push(`defaultAgent "${defaultAgent}" is not a configured agent`);

  const allowed = raw.telegram?.allowedUserIds ?? [];
  if (!Array.isArray(allowed) || !allowed.every((x: unknown) => Number.isInteger(x))) {
    errors.push('telegram.allowedUserIds must be an array of numeric Telegram user ids');
  }
  const cmd = raw.redact?.command;
  if (cmd !== undefined && !(Array.isArray(cmd) && cmd.length > 0 && cmd.every((x: unknown) => typeof x === 'string'))) {
    errors.push('redact.command must be an argv array of strings');
  }

  if (errors.length) throw new ConfigError(`Invalid config (${configPath()}):\n  - ${errors.join('\n  - ')}`);

  const fcHome = join(cageHome(), 'fc');
  const localFc = join(fcHome, 'bin', 'firecracker');
  return {
    backend,
    defaultAgent,
    agents,
    telegram: { tokenEnv: String(raw.telegram?.tokenEnv ?? 'CAGE_TELEGRAM_TOKEN'), allowedUserIds: allowed },
    redact: { enabled: raw.redact?.enabled === true, builtin: raw.redact?.builtin !== false, command: cmd },
    lima: { limactl: String(raw.lima?.limactl ?? 'limactl') },
    firecracker: {
      binary: expandHome(String(raw.firecracker?.binary ?? (existsSync(localFc) ? localFc : 'firecracker'))),
      kernel: expandHome(String(raw.firecracker?.kernel ?? join(fcHome, 'vmlinux'))),
      imagesDir: expandHome(String(raw.firecracker?.imagesDir ?? join(fcHome, 'images'))),
      subnetBase: String(raw.firecracker?.subnetBase ?? '172.30'),
    },
  };
}

export function loadConfig(): CageConfig {
  const path = configPath();
  if (!existsSync(path)) throw new ConfigError(`No config at ${path}. Run \`cage init\` first.`);
  return parseConfig(readJson<Raw>(path, {}));
}

export function writeStarterConfig(backend: BackendName): string {
  const path = configPath();
  writeJsonAtomic(path, starterConfig(backend));
  return path;
}
