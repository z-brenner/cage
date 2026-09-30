import type { ExecOptions, ExecSpec } from './types.ts';
import { shq } from '../util.ts';

/**
 * Builds an `ssh` invocation that runs a bash script in the guest.
 * ssh hands the remote command to the login shell as a string, so the script is wrapped in
 * `bash -c '<quoted>'` — correct regardless of the guest user's shell.
 */
export function sshExec(options: string[], destination: string, script: string, opts: ExecOptions = {}): ExecSpec {
  const args = [
    ...options,
    '-o', 'LogLevel=ERROR',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    // Never hand the host's SSH agent (your GitHub keys) to a guest.
    '-o', 'ForwardAgent=no',
    opts.tty ? '-t' : '-T',
  ];
  for (const p of opts.forwardPorts ?? []) {
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error(`bad port ${p}`);
    args.push('-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${p}:127.0.0.1:${p}`);
  }
  args.push(destination, `bash -c ${shq(script)}`);
  return { cmd: 'ssh', args };
}
