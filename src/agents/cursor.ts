import type { AgentAdapter, AgentEvent, ArgPart, StreamParser } from './types.ts';
import { num, summarizeInput, tryJson } from './common.ts';

/**
 * Cursor CLI (`cursor-agent`; the installer also links it as `agent`), on a Cursor subscription.
 * Headless: `cursor-agent -p --output-format stream-json --trust [--force] <prompt>`.
 */
export const cursor: AgentAdapter = {
  kind: 'cursor',
  label: 'Cursor Agent',
  binary: 'cursor-agent',

  run({ model, sessionId, autonomy, extraArgs }) {
    const argv: ArgPart[] = ['cursor-agent', '-p', '--output-format', 'stream-json', '--trust'];
    if (autonomy === 'full') argv.push('--force');
    if (model) argv.push('--model', model);
    if (sessionId) argv.push('--resume', sessionId);
    argv.push(...(extraArgs ?? []));
    argv.push({ prompt: true });
    return { argv, promptVia: 'arg' };
  },

  // Verified against cursor-agent 2026.09: `cursor-agent -p status` (even after `--`) runs the
  // `status` subcommand, and a leading "-" is parsed as a flag. A leading space defuses both.
  preparePrompt(prompt) {
    return /^-/.test(prompt) || !/\s/.test(prompt.trim()) ? ` ${prompt}` : prompt;
  },

  parser(): StreamParser {
    let text = '';
    let sessionId: string | undefined;
    let sawResult = false;
    return {
      push(line) {
        const ev = tryJson(line);
        if (!ev) return [];
        const out: AgentEvent[] = [];
        if (!sessionId && typeof ev.session_id === 'string') {
          sessionId = ev.session_id;
          out.push({ type: 'session', sessionId: ev.session_id });
        }
        if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              text += block.text;
              out.push({ type: 'text', text: block.text });
            }
          }
        } else if (ev.type === 'tool_call' && ev.subtype === 'started' && ev.tool_call && typeof ev.tool_call === 'object') {
          // e.g. { shellToolCall: { args: { command } } } → "shell"
          const key = Object.keys(ev.tool_call)[0] ?? 'tool';
          const name = key.replace(/ToolCall$/, '') || key;
          out.push({ type: 'tool', name, detail: summarizeInput(ev.tool_call[key]) });
        } else if (ev.type === 'result') {
          sawResult = true;
          const isError = ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success');
          const finalText = typeof ev.result === 'string' && ev.result ? ev.result : text;
          out.push({
            type: 'result',
            text: finalText,
            isError,
            errorMessage: isError ? finalText || String(ev.subtype ?? 'error') : undefined,
            sessionId,
            usage: ev.usage
              ? { inputTokens: num(ev.usage.input_tokens ?? ev.usage.inputTokens), outputTokens: num(ev.usage.output_tokens ?? ev.usage.outputTokens) }
              : undefined,
          });
        }
        return out;
      },
      end(exitCode) {
        if (sawResult) return [];
        return [
          {
            type: 'result',
            text,
            isError: exitCode !== 0,
            errorMessage: exitCode !== 0 ? `cursor-agent exited with code ${exitCode}` : undefined,
            sessionId,
          },
        ];
      },
    };
  },

  authCheck: {
    // An API key counts as logged in; otherwise ask the CLI.
    command: 'if [ -n "${CURSOR_API_KEY:-}" ]; then echo \'{"apiKey":true}\'; else cursor-agent status --format json; fi',
    parse(stdout, exitCode) {
      const j = tryJson(stdout.trim().split('\n').filter((l) => l.trim()).join(''));
      if (j) return j.apiKey === true || j.hasAccessToken === true || j.isAuthenticated === true || j.loggedIn === true;
      return exitCode === 0 && !/not logged in/i.test(stdout);
    },
  },

  login() {
    return {
      command: 'NO_OPEN_BROWSER=1 cursor-agent login',
      instructions: 'Open the URL Cursor prints on any device and approve the login; the CLI finishes on its own.',
    };
  },

  token: {
    env: 'CURSOR_API_KEY',
    how: 'Create a User API Key in the Cursor dashboard (Integrations) and paste it.',
  },
};
