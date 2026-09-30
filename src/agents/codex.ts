import type { AgentAdapter, AgentEvent, ArgPart, StreamParser, Usage } from './types.ts';
import { num, summarizeInput, tryJson } from './common.ts';

/**
 * OpenAI Codex CLI (`codex`), authenticated with "Sign in with ChatGPT".
 * Headless: `codex exec --json … -` (prompt from stdin). Resume: `codex exec resume … <id> -`.
 * Note: `error` events are also emitted for transient reconnects, so they are warnings, not failures.
 */
export const codex: AgentAdapter = {
  kind: 'codex',
  label: 'OpenAI Codex',
  binary: 'codex',

  run({ model, sessionId, autonomy, extraArgs }) {
    const argv: ArgPart[] = ['codex', 'exec'];
    if (sessionId) argv.push('resume');
    argv.push('--json', '--skip-git-repo-check');
    if (autonomy === 'full') {
      // The VM is the sandbox; Codex's own Landlock/seccomp sandbox is redundant (and flaky in some guests).
      argv.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      // `-c` works for both `exec` and `exec resume` (resume has no --sandbox flag).
      argv.push('-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"');
    }
    if (model) argv.push('-m', model);
    argv.push(...(extraArgs ?? []));
    if (sessionId) argv.push(sessionId);
    argv.push('-');
    return { argv, promptVia: 'stdin' };
  },

  parser(): StreamParser {
    let lastMessage = '';
    let failed: string | undefined;
    let lastError: string | undefined;
    let sessionId: string | undefined;
    const usage: Usage = {};
    return {
      push(line) {
        const ev = tryJson(line);
        if (!ev) return [];
        const out: AgentEvent[] = [];
        const item = ev.item;
        switch (ev.type) {
          case 'thread.started':
            if (typeof ev.thread_id === 'string') {
              sessionId = ev.thread_id;
              out.push({ type: 'session', sessionId: ev.thread_id });
            }
            break;
          case 'item.started':
            if (item?.type === 'command_execution') out.push({ type: 'tool', name: 'shell', detail: summarizeInput(item.command) });
            else if (item?.type === 'mcp_tool_call') out.push({ type: 'tool', name: `${item.server ?? 'mcp'}.${item.tool ?? '?'}` });
            else if (item?.type === 'web_search') out.push({ type: 'tool', name: 'web_search', detail: summarizeInput(item.query) });
            break;
          case 'item.completed':
            if (item?.type === 'agent_message' && typeof item.text === 'string') {
              lastMessage = item.text;
              out.push({ type: 'text', text: item.text });
            } else if (item?.type === 'file_change' && Array.isArray(item.changes)) {
              const paths = item.changes.map((c: { path?: string }) => c?.path).filter(Boolean);
              out.push({ type: 'tool', name: 'edit', detail: summarizeInput(paths.join(' ')) });
            } else if (item?.type === 'error' && typeof item.message === 'string') {
              out.push({ type: 'warning', message: item.message });
            }
            break;
          case 'turn.completed':
            usage.inputTokens = (usage.inputTokens ?? 0) + (num(ev.usage?.input_tokens) ?? 0);
            usage.outputTokens = (usage.outputTokens ?? 0) + (num(ev.usage?.output_tokens) ?? 0);
            usage.cachedTokens = (usage.cachedTokens ?? 0) + (num(ev.usage?.cached_input_tokens) ?? 0);
            break;
          case 'turn.failed':
            failed = String(ev.error?.message ?? 'turn failed');
            break;
          case 'error':
            if (typeof ev.message === 'string') {
              lastError = ev.message;
              out.push({ type: 'warning', message: ev.message });
            }
            break;
        }
        return out;
      },
      end(exitCode) {
        const isError = failed !== undefined || (exitCode !== 0 && !lastMessage);
        return [
          {
            type: 'result',
            text: lastMessage,
            isError,
            errorMessage: isError ? (failed ?? lastError ?? `codex exited with code ${exitCode}`) : undefined,
            sessionId,
            usage: usage.inputTokens !== undefined ? usage : undefined,
          },
        ];
      },
    };
  },

  authCheck: {
    command: 'codex login status',
    parse: (_stdout, exitCode) => exitCode === 0,
  },

  login({ browser }) {
    if (browser) {
      return {
        command: 'codex login',
        forwardPorts: [1455],
        instructions:
          'Open the URL Codex prints in your local browser and sign in with ChatGPT. ' +
          'The OAuth callback to localhost:1455 is forwarded into the VM over SSH.',
      };
    }
    return {
      command: 'codex login --device-auth',
      instructions:
        'Device-code sign-in: open the URL on any device, sign in with ChatGPT, enter the code.\n' +
        'If ChatGPT refuses, enable device code authorization for Codex in ChatGPT → Settings → Security, ' +
        'or use `cage login <agent> --browser` (forwards the localhost:1455 callback over SSH).',
    };
  },
};
