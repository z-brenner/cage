import type { AgentConfig } from '../config.ts';

export type VmStatus = 'running' | 'stopped' | 'absent';

export interface VmSpec {
  /** Backend-level instance name, e.g. `cage-claude`. */
  name: string;
  agent: AgentConfig;
}

/** A process to spawn (ssh, limactl, bash…) that runs a guest script. */
export interface ExecSpec {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface ExecOptions {
  tty?: boolean;
  /** Forward these host localhost ports to the same guest localhost port (OAuth callbacks). */
  forwardPorts?: number[];
}

export type Logger = (line: string) => void;

export interface VmBackend {
  readonly name: string;
  /** false only for local-unsafe: agents then run directly on the host. */
  readonly isolated: boolean;
  /** Whether `cage up` must run guest/provision.sh over SSH (Firecracker images are pre-provisioned). */
  readonly needsProvision: boolean;
  status(vm: VmSpec): Promise<VmStatus>;
  /** Create if absent, start if stopped, return once the guest accepts commands. */
  up(vm: VmSpec, log: Logger): Promise<void>;
  down(vm: VmSpec, log: Logger): Promise<void>;
  /** Irreversible: deletes the VM disk, including the agent's stored login. */
  destroy(vm: VmSpec, log: Logger): Promise<void>;
  /** How to run `script` (a bash script) inside the guest. */
  exec(vm: VmSpec, script: string, opts?: ExecOptions): Promise<ExecSpec>;
  /** Host prerequisite problems, empty when ready. */
  doctor(): Promise<string[]>;
}
