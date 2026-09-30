import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cage } from '../src/cage.ts';
import { parseConfig } from '../src/config.ts';
import { StateStore } from '../src/state.ts';
import { LocalUnsafeBackend } from '../src/vm/local.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
export const BINARIES = { claude: 'claude', codex: 'codex', gemini: 'gemini', cursor: 'cursor-agent' } as const;

/** Local backend that claims isolation, so tests exercise the "full autonomy" code path. */
export class IsolatedTestBackend extends LocalUnsafeBackend {
  override readonly isolated = true;
}

export function makeCage(opts: { isolated?: boolean; raw?: Record<string, unknown> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cage-test-'));
  process.env.CAGE_HOME = home;
  const config = parseConfig({
    backend: 'local-unsafe',
    agents: { claude: {}, codex: {}, gemini: {}, cursor: {} },
    ...opts.raw,
  });
  const backend = opts.isolated === false ? new LocalUnsafeBackend() : new IsolatedTestBackend();
  for (const [agent, bin] of Object.entries(BINARIES)) {
    const binDir = join(home, 'local', `cage-${agent}`, '.cagevm', 'bin');
    mkdirSync(binDir, { recursive: true });
    copyFileSync(FAKE, join(binDir, bin));
    chmodSync(join(binDir, bin), 0o755);
  }
  const cage = new Cage(config, { backend, state: new StateStore(join(home, 'state.json')) });
  const last = (agent: keyof typeof BINARIES) =>
    JSON.parse(readFileSync(join(home, 'local', `cage-${agent}`, `last-${BINARIES[agent]}.json`), 'utf8')) as {
      argv: string[];
      prompt: string;
      resume?: string;
      cwd: string;
      pid: number;
      env: Record<string, string | null>;
    };
  return { cage, home, last };
}
