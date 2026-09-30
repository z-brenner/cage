#!/usr/bin/env node
// Stand-in for claude / codex / gemini / cursor-agent. Records what it was given, then emits that
// CLI's stream-json format with an answer that echoes the prompt. Magic words in the prompt:
//   SLEEP       emit a tool event, then hang (cancel/timeout tests)
//   FAILRESUME  when resuming: fail like a lost session
//   AUTHFAIL    fail like a logged-out CLI
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const kind = basename(process.argv[1]).replace(/\.mjs$/, '');
const argv = process.argv.slice(2);
const root = process.env.CAGE_GUEST_ROOT ?? process.env.HOME;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

let prompt;
let resume;
switch (kind) {
  case 'claude':
    prompt = readFileSync(0, 'utf8');
    resume = flag('--resume');
    break;
  case 'codex':
    prompt = argv.at(-1) === '-' ? readFileSync(0, 'utf8') : argv.at(-1);
    resume = argv[1] === 'resume' ? argv.at(-2) : undefined;
    break;
  case 'gemini':
    prompt = argv.find((a) => a.startsWith('--prompt=')).slice('--prompt='.length);
    resume = flag('--resume');
    break;
  case 'cursor-agent':
    prompt = argv.at(-1);
    resume = flag('--resume');
    break;
  default:
    process.stderr.write(`fake-agent: unknown kind ${kind}\n`);
    process.exit(2);
}

writeFileSync(join(root, `last-${kind}.json`), JSON.stringify({ argv, prompt, resume, cwd: process.cwd(), pid: process.pid, env: { GOOGLE_GENAI_USE_GCA: process.env.GOOGLE_GENAI_USE_GCA ?? null } }));

if (prompt.includes('AUTHFAIL')) {
  process.stderr.write('Invalid API key · Please run /login\n');
  process.exit(1);
}
if (resume && prompt.includes('FAILRESUME')) {
  process.stderr.write(`Error: No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

const session = resume ?? `${kind}-${Math.random().toString(36).slice(2, 10)}`;
const answer = `ECHO[${kind}]:${prompt}`;
const hang = prompt.includes('SLEEP');

function finish() {
  switch (kind) {
    case 'claude':
      out({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: session, total_cost_usd: 0.0123, usage: { input_tokens: 11, output_tokens: 7 } });
      break;
    case 'codex':
      out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'thinking out loud' } });
      out({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: answer } });
      out({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 9 } });
      break;
    case 'gemini':
      out({ type: 'message', role: 'assistant', content: answer.slice(0, 5), delta: true });
      out({ type: 'message', role: 'assistant', content: answer.slice(5), delta: true });
      out({ type: 'result', status: 'success', stats: { total_tokens: 40, input_tokens: 30, output_tokens: 10, cached: 0 } });
      break;
    case 'cursor-agent':
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] }, session_id: session });
      out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: session, duration_ms: 5 });
      break;
  }
}

// preamble + one tool call, in each CLI's own format
switch (kind) {
  case 'claude':
    out({ type: 'system', subtype: 'init', session_id: session, model: 'fake' });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } });
    break;
  case 'codex':
    process.stdout.write('not json: codex sometimes prints plain lines\n');
    out({ type: 'thread.started', thread_id: session });
    out({ type: 'turn.started' });
    out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } });
    out({ type: 'error', message: 'Reconnecting... 1/5' });
    break;
  case 'gemini':
    out({ type: 'init', session_id: session, model: 'fake' });
    out({ type: 'message', role: 'user', content: prompt });
    out({ type: 'message', role: 'assistant', content: 'Checking.', delta: true });
    out({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: 't1', parameters: { command: 'ls' } });
    out({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'a b' });
    break;
  case 'cursor-agent':
    out({ type: 'system', subtype: 'init', session_id: session, model: 'fake' });
    out({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls' } } } });
    break;
}

if (hang) setTimeout(finish, 60_000);
else finish();
