import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/agents/index.ts';
import type { AgentEvent } from '../src/agents/types.ts';
import { chunkText, parseCommand } from '../src/bot/telegram.ts';
import { LOST_SESSION, repoName, workspaceFor } from '../src/cage.ts';
import { ConfigError, parseConfig } from '../src/config.ts';
import { luhn, maskBuiltin, Vault } from '../src/redact.ts';
import { buildRunScript, renderArgv } from '../src/remote.ts';
import { limaYaml } from '../src/vm/lima.ts';
import { sshMultiplexOptions } from '../src/vm/firecracker.ts';
import { sshExec } from '../src/vm/ssh.ts';
import { LineSplitter, shq } from '../src/util.ts';

const feed = (kind: keyof typeof ADAPTERS, lines: unknown[], exitCode = 0): AgentEvent[] => {
  const p = ADAPTERS[kind].parser();
  return [...lines.flatMap((l) => p.push(typeof l === 'string' ? l : JSON.stringify(l))), ...p.end(exitCode)];
};
const result = (evs: AgentEvent[]) => evs.find((e) => e.type === 'result') as Extract<AgentEvent, { type: 'result' }>;

describe('shell quoting', () => {
  it('round-trips arbitrary strings through bash', () => {
    const samples = ['', 'plain', "it's", '"dq"', '$(id)', '`id`', 'a\nb', 'tab\there', '\\', "'", "''", '--flag', '*', '~', '!event', 'ünïcödé 🚀'];
    for (const s of samples) {
      const r = spawnSync('bash', ['-c', `printf '%s' ${shq(s)}`], { encoding: 'utf8' });
      assert.equal(r.stdout, s);
    }
  });

  it('renders the prompt placeholder as a quoted variable', () => {
    assert.equal(renderArgv(['gemini', { prompt: true, prefix: '--prompt=' }, 'a b']), `gemini --prompt="$PROMPT" 'a b'`);
  });

  it('rejects path traversal in workspaces', () => {
    const command = ADAPTERS.claude.run({ autonomy: 'full' });
    assert.throws(() => buildRunScript({ runId: 'abc', workspace: '../etc', command }));
    assert.throws(() => buildRunScript({ runId: 'abc', workspace: 'a/../../b', command }));
    assert.throws(() => buildRunScript({ runId: 'x;rm', workspace: 'ok', command }));
  });

  it('workspace and repo names are slugged', () => {
    assert.equal(workspaceFor('tg-123'), 'tg-123');
    assert.equal(workspaceFor('tg-123', 'git@github.com:acme/Web.App.git'), 'tg-123/web.app');
    assert.equal(repoName('https://github.com/acme/..'), 'repo');
  });

  it('ssh wrapping disables agent forwarding and quotes the script', () => {
    const s = sshExec(['-F', 'cfg'], 'lima-x', "echo 'hi'", { tty: true, forwardPorts: [1455] });
    assert.ok(s.args.includes('ForwardAgent=no'));
    assert.ok(s.args.includes('127.0.0.1:1455:127.0.0.1:1455'));
    assert.equal(s.args.at(-1), `bash -c 'echo '\\''hi'\\'''`);
  });

  it('ssh control sockets stay under the unix socket path limit', () => {
    const cp = sshMultiplexOptions().find((o) => o.startsWith('ControlPath='));
    if (cp) assert.ok(cp.replace('ControlPath=', '').replace('%C', 'x'.repeat(40)).length < 108);
  });

  it('line splitter handles partial chunks and CRLF', () => {
    const ls = new LineSplitter();
    assert.deepEqual(ls.push('a\r\nb'), ['a']);
    assert.deepEqual(ls.push('c\nd'), ['bc']);
    assert.deepEqual(ls.flush(), ['d']);
  });
});

describe('lost-session detection', () => {
  it('matches the real CLI messages', () => {
    for (const m of [
      'Error: No conversation found with session ID: 1234',
      'Error: thread/resume: thread/resume failed: no rollout found for thread id 1111 (code -32600)',
      'Error resuming session: No previous sessions found for this project.',
      'Chat abc not found',
    ]) assert.match(m, LOST_SESSION, m);
  });
  it('does not match unrelated errors that mention sessions', () => {
    for (const m of ['5-hour session limit reached ∙ resets 3pm', 'Not logged in · Please run /login', 'usage limit reached for this session', 'file not found: src/session.ts'])
      assert.doesNotMatch(m, LOST_SESSION, m);
  });
});

describe('stream parsers', () => {
  it('claude: session, tools, final result with cost', () => {
    const evs = feed('claude', [
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/a.ts' } }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's1', total_cost_usd: 0.5, usage: { input_tokens: 3, output_tokens: 4 } },
    ]);
    assert.deepEqual(evs[0], { type: 'session', sessionId: 's1' });
    assert.deepEqual(evs[1], { type: 'tool', name: 'Edit', detail: '/w/a.ts' });
    assert.equal(result(evs).text, 'done');
    assert.equal(result(evs).costUsd, 0.5);
  });

  it('claude: error_max_turns is an error; missing result is an error', () => {
    assert.equal(result(feed('claude', [{ type: 'result', subtype: 'error_max_turns', is_error: true }])).isError, true);
    assert.equal(result(feed('claude', ['garbage'], 1)).isError, true);
  });

  it('codex: last agent_message wins; reconnect errors are warnings', () => {
    const evs = feed('codex', [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'error', message: 'Reconnecting... 1/5' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'final' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } },
    ]);
    const r = result(evs);
    assert.equal(r.text, 'final');
    assert.equal(r.isError, false);
    assert.equal(r.sessionId, 't1');
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5, cachedTokens: 2 });
  });

  it('codex: turn.failed is an error', () => {
    const r = result(feed('codex', [{ type: 'turn.failed', error: { message: 'usage limit reached' } }], 1));
    assert.equal(r.isError, true);
    assert.equal(r.errorMessage, 'usage limit reached');
  });

  it('gemini: deltas joined, segments split by tool calls', () => {
    const r = result(
      feed('gemini', [
        { type: 'init', session_id: 'g1' },
        { type: 'message', role: 'user', content: 'q' },
        { type: 'message', role: 'assistant', content: 'Let me ', delta: true },
        { type: 'message', role: 'assistant', content: 'look.', delta: true },
        { type: 'tool_use', tool_name: 'read_file', tool_id: 'x', parameters: { path: 'a' } },
        { type: 'message', role: 'assistant', content: 'Answer.', delta: true },
        { type: 'result', status: 'success', stats: { input_tokens: 9, output_tokens: 2, cached: 1 } },
      ]),
    );
    assert.equal(r.text, 'Let me look.\n\nAnswer.');
    assert.equal(r.sessionId, 'g1');
    assert.equal(r.usage?.inputTokens, 9);
  });

  it('cursor: result text, tool names from tool_call keys', () => {
    const evs = feed('cursor', [
      { type: 'system', subtype: 'init', session_id: 'c1' },
      { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'README.md' } } } },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'c1' },
    ]);
    assert.deepEqual(evs[1], { type: 'tool', name: 'read', detail: 'README.md' });
    assert.equal(result(evs).text, 'ok');
  });

  it('cursor: non-zero exit without a result event is an error', () => {
    assert.equal(result(feed('cursor', [], 1)).isError, true);
  });

  it('auth checks interpret each CLI’s status output', () => {
    assert.equal(ADAPTERS.claude.authCheck.parse('{"loggedIn": true, "authMethod": "claude.ai"}', 0), true);
    assert.equal(ADAPTERS.claude.authCheck.parse('{\n  "loggedIn": false\n}', 1), false);
    assert.equal(ADAPTERS.codex.authCheck.parse('', 1), false);
    // real cursor-agent 2026.09.28 output, logged out:
    assert.equal(ADAPTERS.cursor.authCheck.parse('{\n  "status": "unauthenticated",\n  "isAuthenticated": false\n}', 0), false);
    assert.equal(ADAPTERS.cursor.authCheck.parse('{"status": "authenticated", "isAuthenticated": true}', 0), true);
    assert.equal(ADAPTERS.cursor.authCheck.parse('{"apiKey":true}', 0), true);
  });
});

describe('redaction', () => {
  it('luhn', () => {
    assert.equal(luhn('4111111111111111'), true);
    assert.equal(luhn('4111111111111112'), false);
  });

  it('masks and restores with stable placeholders', () => {
    const v = new Vault();
    const m = maskBuiltin('a@b.io and a@b.io, key sk-ant-abcdefghijklmnopqrstuvwxyz, ssn 123-45-6789, ip 10.1.2.3', v);
    assert.equal(m.text, '[[EMAIL_1]] and [[EMAIL_1]], key [[SECRET_1]], ssn [[SSN_1]], ip [[IP_1]]');
    assert.equal(v.restore('sent to [[EMAIL_1]] from [[IP_1]] ([[NOPE_9]])'), 'sent to a@b.io from 10.1.2.3 ([[NOPE_9]])');
  });

  it('leaves non-card digit runs alone', () => {
    assert.equal(maskBuiltin('order 1234567890123', new Vault()).text, 'order 1234567890123');
  });
});

describe('telegram commands', () => {
  const agents = ['claude', 'codex', 'claude-research'];
  it('plain text goes to the default agent', () => {
    assert.deepEqual(parseCommand('fix the build', agents, 'codex'), { kind: 'ask', agents: ['codex'], prompt: 'fix the build' });
  });
  it('agent commands, @bot suffix, multiline prompts', () => {
    assert.deepEqual(parseCommand('/claude@MyBot line1\nline2', agents, 'codex'), { kind: 'ask', agents: ['claude'], prompt: 'line1\nline2' });
    assert.deepEqual(parseCommand('/claude_research go', agents, 'codex'), { kind: 'ask', agents: ['claude-research'], prompt: 'go' });
    assert.deepEqual(parseCommand('/ask claude-research dig in', agents, 'codex'), { kind: 'ask', agents: ['claude-research'], prompt: 'dig in' });
  });
  it('/all fans out; paths are not commands', () => {
    assert.deepEqual(parseCommand('/all compare', agents, 'claude'), { kind: 'ask', agents, prompt: 'compare' });
    assert.equal(parseCommand('/usr/bin is odd', agents, 'claude').kind, 'ask');
  });
  it('control commands and errors', () => {
    assert.deepEqual(parseCommand('/use codex', agents, 'claude'), { kind: 'use', agent: 'codex' });
    assert.equal(parseCommand('/use nope', agents, 'claude').kind, 'error');
    assert.deepEqual(parseCommand('/repo off', agents, 'claude'), { kind: 'repo', clear: true });
    assert.equal(parseCommand('/repo file:///etc', agents, 'claude').kind, 'error');
    assert.equal(parseCommand('/claude', agents, 'claude').kind, 'error');
    assert.equal(parseCommand('/wat', agents, 'claude').kind, 'error');
  });
  it('chunks long answers under the Telegram limit', () => {
    const text = Array.from({ length: 300 }, (_, i) => `paragraph ${i} `.repeat(5)).join('\n\n');
    const chunks = chunkText(text, 4000);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 4000));
    assert.equal(chunks.join('\n\n'), text);
  });
});

describe('config', () => {
  it('fills defaults and allows several VMs of one kind', () => {
    const c = parseConfig({ agents: { claude: {}, 'claude-research': { kind: 'claude', model: 'opus', autonomy: 'safe' } }, defaultAgent: 'claude' });
    assert.equal(c.backend, 'lima');
    assert.equal(c.agents['claude-research']?.kind, 'claude');
    assert.equal(c.agents.claude?.autonomy, 'full');
    assert.equal(c.agents.claude?.memoryMiB, 4096);
  });
  it('rejects bad input with every problem listed', () => {
    assert.throws(
      () => parseConfig({ backend: 'docker', agents: { Bad_Name: {}, x: { kind: 'copilot' } }, telegram: { allowedUserIds: ['me'] } }),
      (e: Error) => e instanceof ConfigError && /backend/.test(e.message) && /Bad_Name/.test(e.message) && /copilot|kind/.test(e.message) && /allowedUserIds/.test(e.message),
    );
  });
  it('lima yaml is plain: no mounts, no agent forwarding', () => {
    const c = parseConfig({ agents: { codex: {} } });
    const y = limaYaml({ name: 'cage-codex', agent: c.agents.codex! });
    assert.match(y, /^plain: true$/m);
    assert.match(y, /^mounts: \[\]$/m);
    assert.match(y, /forwardAgent: false/);
    assert.match(y, /memory: "4096MiB"/);
  });
});
