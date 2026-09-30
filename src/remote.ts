import type { ArgPart, RunCommand } from './agents/types.ts';
import { shq } from './util.ts';

/**
 * Shell scripts executed inside a guest (over SSH, or locally for `local-unsafe`).
 *
 * Invariants:
 *  - The prompt never appears in any argv on the host or in the script text; it travels on stdin,
 *    lands in a 0600 file, and is deleted when the run ends.
 *  - Every static argument is single-quoted by `shq`, so config values can't inject shell.
 *  - The agent runs in its own process group (setsid) so a cancel kills its whole tool tree.
 *
 * `$G` is the guest root: $HOME in a VM, or a per-agent directory for `local-unsafe`.
 */
const PRELUDE = `set -u
G="\${CAGE_GUEST_ROOT:-$HOME}"
export PATH="$G/.cagevm/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
set -a
if [ -r /etc/cage/env ]; then . /etc/cage/env; fi
if [ -r "$G/.cagevm/env" ]; then . "$G/.cagevm/env"; fi
set +a
`;

export function guestScript(body: string): string {
  return PRELUDE + body;
}

export function renderArgv(argv: readonly ArgPart[]): string {
  return argv.map((a) => (typeof a === 'string' ? shq(a) : `${a.prefix ? shq(a.prefix) : ''}"$PROMPT"`)).join(' ');
}

export interface RunScriptSpec {
  runId: string;
  /** Workspace path relative to $G/work, already slugged. */
  workspace: string;
  /** Optional git URL cloned into an empty workspace before the first run. */
  repo?: string;
  command: RunCommand;
}

export function buildRunScript(spec: RunScriptSpec): string {
  if (!/^[a-z0-9]+$/.test(spec.runId)) throw new Error(`bad runId ${spec.runId}`);
  if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/.test(spec.workspace) || spec.workspace.split('/').includes('..')) {
    throw new Error(`bad workspace ${spec.workspace}`);
  }
  const id = spec.runId;
  const lines = [
    `R="$G/.cagevm/run"`,
    `W="$G/work/"${shq(spec.workspace)}`,
    `mkdir -p "$R" "$W" || exit 97`,
    `chmod 700 "$G/.cagevm" "$R" 2>/dev/null`,
    `cd "$W" || exit 97`,
    `umask 077`,
    `cat > "$R/${id}.prompt" || exit 97`,
    `umask 022`,
    `trap 'rm -f "$R/${id}.prompt" "$R/${id}.pid"' EXIT`,
  ];
  if (spec.repo) {
    lines.push(
      `if [ ! -e .git ] && [ -z "$(ls -A . 2>/dev/null)" ]; then`,
      `  git clone --quiet -- ${shq(spec.repo)} . >&2 || { echo "cage: git clone failed" >&2; exit 96; }`,
      `fi`,
    );
  }
  const argv = renderArgv(spec.command.argv);
  const stdin = spec.command.promptVia === 'stdin' ? `"$R/${id}.prompt"` : '/dev/null';
  if (spec.command.promptVia === 'arg') lines.push(`PROMPT=$(cat "$R/${id}.prompt")`);
  lines.push(
    `if command -v setsid >/dev/null 2>&1; then S="setsid -w"; else S=""; fi`,
    // sh records its pid (= process-group leader under setsid) and execs the agent CLI in place.
    `$S sh -c 'echo $$ > "$1"; shift; exec "$@"' cage-run "$R/${id}.pid" ${argv} < ${stdin}`,
    `exit $?`,
  );
  return guestScript(lines.join('\n') + '\n');
}

/** TERM the run's process group, escalate to KILL after ~5s. Safe to call for finished runs. */
export function buildCancelScript(runId: string): string {
  if (!/^[a-z0-9]+$/.test(runId)) throw new Error(`bad runId ${runId}`);
  return guestScript(`P="$G/.cagevm/run/${runId}.pid"
[ -r "$P" ] || exit 0
pid=$(cat "$P")
[ -n "$pid" ] || exit 0
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
i=0
while [ $i -lt 50 ]; do
  kill -0 -- "-$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null || exit 0
  sleep 0.1
  i=$((i + 1))
done
kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
exit 0
`);
}

/**
 * Upserts `KEY=<value>` in the guest's 0600 secret env file. The full line arrives on stdin so the
 * secret never shows up in `ps` on either side.
 */
export function buildSetEnvScript(key: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`bad env key ${key}`);
  return guestScript(`umask 077
mkdir -p "$G/.cagevm" && chmod 700 "$G/.cagevm"
F="$G/.cagevm/env"
touch "$F"
line=$(cat)
grep -v '^${key}=' "$F" > "$F.tmp" || true
printf '%s\\n' "$line" >> "$F.tmp"
mv "$F.tmp" "$F"
`);
}

export function envLine(key: string, value: string): string {
  return `${key}=${shq(value)}`;
}

/** Run a command with the guest env loaded (used for auth checks, logins and shells). */
export function buildCommandScript(command: string, opts: { cwd?: 'work' } = {}): string {
  const cd = opts.cwd === 'work' ? `mkdir -p "$G/work" && cd "$G/work"\n` : '';
  return guestScript(`${cd}${command}\n`);
}
