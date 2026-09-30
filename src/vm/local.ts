import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cageHome } from '../util.ts';
import type { ExecSpec, Logger, VmBackend, VmSpec, VmStatus } from './types.ts';

/**
 * NO ISOLATION. Runs agent CLIs directly on this machine with your existing logins,
 * using ~/.cage/local/<vm> for workspaces. For trying cage out and for tests only.
 * The orchestrator forces autonomy "safe" on this backend.
 */
export class LocalUnsafeBackend implements VmBackend {
  readonly name = 'local-unsafe';
  readonly isolated: boolean = false;
  readonly needsProvision = false;

  root(vm: VmSpec): string {
    return join(cageHome(), 'local', vm.name);
  }

  async status(): Promise<VmStatus> {
    return 'running';
  }

  async up(vm: VmSpec): Promise<void> {
    mkdirSync(join(this.root(vm), '.cagevm', 'bin'), { recursive: true, mode: 0o700 });
  }

  async down(): Promise<void> {}

  async destroy(vm: VmSpec, log: Logger): Promise<void> {
    log(`deleting ${this.root(vm)}`);
    rmSync(this.root(vm), { recursive: true, force: true });
  }

  async exec(vm: VmSpec, script: string): Promise<ExecSpec> {
    mkdirSync(this.root(vm), { recursive: true, mode: 0o700 });
    return { cmd: 'bash', args: ['-c', script], env: { ...process.env, CAGE_GUEST_ROOT: this.root(vm) } };
  }

  async doctor(): Promise<string[]> {
    return [];
  }
}
