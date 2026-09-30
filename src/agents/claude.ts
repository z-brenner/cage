import type { AgentAdapter, AgentEvent, ArgPart, StreamParser } from './types.ts';
import { num, summarizeInput, tryJson } from './common.ts';

/**
 * Claude Code (`claude`), authenticated with a Claude Pro/Max subscription.
 * Headless: `claude -p --output-format stream-json --verbose`, prompt on stdin
 * (stdin avoids a one-word prompt like "update" being parsed as a subcommand).
 */
export const claude: AgentAdapter = {
  kind: 'claude',
  label: 'Claude Code',
  binary: 'claude',

  run({ model, sessionId, autonomy, extraArgs }) {
    const argv: ArgPart[] = ['claude', '-p', '--output-format', 'stream-json', '--verbose'];
    // Refuses to run as root; guests run agents as an unprivileged user.
    if (autonomy === 'full') argv.push('--dangerously-skip-permissions');
    else argv.push('--permission-mode', 'acceptEdits');
    if (model) argv.push('--model', model);
    if (sessionId) argv.push('--resume', sessionId);
    argv.push(...(extraArgs ?? []));
    return { argv, promptVia: 'stdin' };
  },

  parser(): StreamParser {
    let sawResult = false;
    let lastText = '';
    let sessionId: string | undefined;
    return {
      push(line) {
        const ev = tryJson(line);
        if (!ev) return [];
        const out: AgentEvent[] = [];
        if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
          sessionId = ev.session_id;
          out.push({ type: 'session', sessionId: ev.session_id });
        } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              lastText = block.text;
              out.push({ type: 'text', text: block.text });
            } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
              out.push({ type: 'tool', name: block.name, detail: summarizeInput(block.input) });
            }
          }
        } else if (ev.type === 'result') {
          sawResult = true;
          const isError = ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success');
          const text = typeof ev.result === 'string' ? ev.result : '';
          out.push({
            type: 'result',
            text,
            isError,
            errorMessage: isError ? text || String(ev.subtype ?? 'error') : undefined,
            sessionId: typeof ev.session_id === 'string' ? ev.session_id : undefined,
            costUsd: num(ev.total_cost_usd),
            usage: ev.usage
              ? {
                  inputTokens: num(ev.usage.input_tokens),
                  outputTokens: num(ev.usage.output_tokens),
                  cachedTokens: num(ev.usage.cache_read_input_tokens),
                }
              : undefined,
          });
        }
        return out;
      },
      end(exitCode) {
        if (sawResult) return [];
        // Killed or crashed before the final `result` line (e.g. auth failure printed to stderr).
        return [
          {
            type: 'result',
            text: lastText,
            isError: true,
            errorMessage: `claude exited with code ${exitCode} before reporting a result`,
            sessionId,
          },
        ];
      },
    };
  },

  authCheck: {
    command: 'claude auth status --json',
    parse(stdout) {
      const j = tryJson(stdout.trim().split('\n').filter((l) => l.trim()).join(''));
      return j?.loggedIn === true;
    },
  },

  login() {
    return {
      command: 'claude auth login --claudeai',
      instructions:
        'Open the URL Claude prints, sign in with your Claude Pro/Max account, and paste the code back here.\n' +
        'Alternative: run `claude setup-token` on any machine with a browser, then `cage login <agent> --token`.',
    };
  },

  token: {
    env: 'CLAUDE_CODE_OAUTH_TOKEN',
    how: 'Run `claude setup-token` on a machine with a browser (uses your Claude subscription) and paste the sk-ant-oat… token.',
  },
};
