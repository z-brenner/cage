import type { AgentAdapter, AgentEvent, ArgPart, StreamParser } from './types.ts';
import { num, summarizeInput, tryJson } from './common.ts';

/**
 * Google Gemini CLI (`gemini`), authenticated with "Login with Google" (Google AI Pro/Ultra).
 * Headless: `gemini --prompt=<text> --output-format stream-json`. The `--prompt=` form keeps a
 * prompt that starts with "-" from being parsed as a flag. Non-interactive auth requires
 * GOOGLE_GENAI_USE_GCA=true or security.auth.selectedType=oauth-personal (both set by provisioning).
 */
export const gemini: AgentAdapter = {
  kind: 'gemini',
  label: 'Gemini CLI',
  binary: 'gemini',

  run({ model, sessionId, autonomy, extraArgs }) {
    const argv: ArgPart[] = ['gemini', { prompt: true, prefix: '--prompt=' }, '--output-format', 'stream-json', '--skip-trust'];
    if (autonomy === 'full') argv.push('--approval-mode', 'yolo');
    else argv.push('--approval-mode', 'auto_edit');
    if (model) argv.push('-m', model);
    // Sessions are scoped to the project directory; cage keeps one workdir per conversation.
    if (sessionId) argv.push('--resume', sessionId);
    argv.push(...(extraArgs ?? []));
    return { argv, promptVia: 'arg' };
  },

  parser(): StreamParser {
    const segments: string[] = [];
    let current = '';
    let sessionId: string | undefined;
    let lastError: string | undefined;
    let sawResult = false;
    const flushSegment = () => {
      if (current.trim()) segments.push(current.trim());
      current = '';
    };
    return {
      push(line) {
        const ev = tryJson(line);
        if (!ev) return [];
        const out: AgentEvent[] = [];
        switch (ev.type) {
          case 'init':
            if (typeof ev.session_id === 'string') {
              sessionId = ev.session_id;
              out.push({ type: 'session', sessionId: ev.session_id });
            }
            break;
          case 'message':
            if (ev.role === 'assistant' && typeof ev.content === 'string') {
              current += ev.content;
              out.push({ type: 'text', text: ev.content });
            }
            break;
          case 'tool_use':
            flushSegment();
            out.push({ type: 'tool', name: String(ev.tool_name ?? 'tool'), detail: summarizeInput(ev.parameters) });
            break;
          case 'tool_result':
            if (ev.status === 'error' && ev.error?.message) out.push({ type: 'warning', message: String(ev.error.message) });
            break;
          case 'error':
            if (typeof ev.message === 'string') {
              if (ev.severity === 'error') lastError = ev.message;
              out.push({ type: 'warning', message: ev.message });
            }
            break;
          case 'result': {
            sawResult = true;
            flushSegment();
            const isError = ev.status !== 'success';
            const s = ev.stats ?? {};
            out.push({
              type: 'result',
              text: segments.join('\n\n'),
              isError,
              errorMessage: isError ? String(ev.error?.message ?? lastError ?? 'gemini reported an error') : undefined,
              sessionId,
              usage: { inputTokens: num(s.input_tokens), outputTokens: num(s.output_tokens), cachedTokens: num(s.cached) },
            });
            break;
          }
        }
        return out;
      },
      end(exitCode) {
        if (sawResult) return [];
        flushSegment();
        return [
          {
            type: 'result',
            text: segments.join('\n\n'),
            isError: exitCode !== 0,
            errorMessage: exitCode !== 0 ? (lastError ?? `gemini exited with code ${exitCode}`) : undefined,
            sessionId,
          },
        ];
      },
    };
  },

  authCheck: {
    command: '[ -s "$HOME/.gemini/oauth_creds.json" ] || [ -n "${GEMINI_API_KEY:-}" ]',
    parse: (_stdout, exitCode) => exitCode === 0,
  },

  login() {
    return {
      command: 'NO_BROWSER=true gemini',
      instructions:
        'Gemini starts "Login with Google": open the URL, sign in with the Google account that has your AI Pro/Ultra plan, ' +
        'paste the authorization code back. Once the prompt appears, type /quit.',
    };
  },

  token: {
    env: 'GEMINI_API_KEY',
    how: 'API key from Google AI Studio. NOTE: this bills the API, not your Google AI subscription.',
    // Provisioning sets GOOGLE_GENAI_USE_GCA=true (Login with Google), which outranks an API key.
    extra: { GOOGLE_GENAI_USE_GCA: 'false' },
  },
};
