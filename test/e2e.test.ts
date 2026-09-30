import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AgentEvent } from '../src/agents/types.ts';
import { BusyError } from '../src/cage.ts';
import { makeCage } from './helpers.ts';

const AGENTS = ['claude', 'codex', 'gemini', 'cursor'] as const;

describe('end-to-end through the guest run script (local backend, fake CLIs)', () => {
  for (const agent of AGENTS) {
    it(`${agent}: hostile prompt arrives byte-exact, answer + session come back`, async () => {
      const { cage, home, last } = makeCage();
      const canary = join(home, 'pwned');
      const prompt = `it's "quoted" $(touch ${canary}) \`touch ${canary}\` $HOME\nline two\t-- --force; exit 1`;
      const events: AgentEvent[] = [];
      const r = await cage.run({ conversation: 'cli', agent, prompt, onEvent: (e) => events.push(e) });

      assert.equal(r.isError, false, r.errorMessage);
      assert.equal(last(agent).prompt, prompt);
      // gemini's text before a tool call is its own segment (the fake says "Checking." first)
      const preamble = agent === 'gemini' ? 'Checking.\n\n' : '';
      assert.equal(r.text, `${preamble}ECHO[${agent === 'cursor' ? 'cursor-agent' : agent}]:${prompt}`);
      assert.equal(existsSync(canary), false, 'prompt must never be shell-evaluated');
      assert.ok(r.sessionId, 'session id captured');
      assert.equal(cage.state.getSession('cli', agent), r.sessionId);
      assert.ok(events.some((e) => e.type === 'tool'), 'tool progress event');
      assert.match(last(agent).cwd, /\/work\/cli$/);
    });
  }

  it('second message resumes the stored session with each CLI’s own syntax', async () => {
    const { cage, last } = makeCage();
    for (const agent of AGENTS) {
      const first = await cage.run({ conversation: 'c1', agent, prompt: 'hello there' });
      const second = await cage.run({ conversation: 'c1', agent, prompt: 'and again' });
      assert.equal(second.resumed, true);
      assert.equal(last(agent).resume, first.sessionId, `${agent} resumed`);
      if (agent === 'codex') assert.deepEqual(last(agent).argv.slice(0, 2), ['exec', 'resume']);
    }
  });

  it('newSession forgets the previous session', async () => {
    const { cage, last } = makeCage();
    await cage.run({ conversation: 'c2', agent: 'claude', prompt: 'one two' });
    const r = await cage.run({ conversation: 'c2', agent: 'claude', prompt: 'three four', newSession: true });
    assert.equal(r.resumed, false);
    assert.equal(last('claude').resume, undefined);
  });

  it('full autonomy flags are used inside an isolated backend', async () => {
    const { cage, last } = makeCage();
    await cage.runMany([...AGENTS], { conversation: 'c3', prompt: 'go now' });
    assert.ok(last('claude').argv.includes('--dangerously-skip-permissions'));
    assert.ok(last('codex').argv.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.deepEqual(last('gemini').argv.slice(last('gemini').argv.indexOf('--approval-mode'), last('gemini').argv.indexOf('--approval-mode') + 2), ['--approval-mode', 'yolo']);
    assert.ok(last('cursor').argv.includes('--force'));
    assert.ok(last('cursor').argv.includes('--trust'));
  });

  it('local-unsafe forces safe autonomy', async () => {
    const { cage, last } = makeCage({ isolated: false });
    const r = await cage.run({ conversation: 'c4', agent: 'claude', prompt: 'hi there' });
    assert.ok(!last('claude').argv.includes('--dangerously-skip-permissions'));
    assert.ok(last('claude').argv.includes('acceptEdits'));
    assert.ok(r.notes.some((n) => /safe/.test(n)));
  });

  it('cursor: one-word prompts cannot turn into subcommands', async () => {
    const { cage, last } = makeCage();
    await cage.run({ conversation: 'c5', agent: 'cursor', prompt: 'status' });
    assert.equal(last('cursor').prompt, ' status');
  });

  it('cancel kills the agent’s whole process group in the guest', async () => {
    const { cage, last } = makeCage();
    let sawTool!: () => void;
    const toolSeen = new Promise<void>((res) => (sawTool = res));
    const run = cage.run({ conversation: 'c6', agent: 'claude', prompt: 'SLEEP please', onEvent: (e) => e.type === 'tool' && sawTool() });
    await toolSeen;
    await assert.rejects(cage.run({ conversation: 'c6', agent: 'claude', prompt: 'meanwhile' }), BusyError);
    assert.equal(cage.cancel('c6'), 1);
    const r = await run;
    assert.equal(r.cancelled, true);
    assert.equal(r.isError, true);
    const pid = last('claude').pid;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && alive(pid)) await new Promise((res) => setTimeout(res, 100));
    assert.equal(alive(pid), false, 'fake agent process was killed');
    assert.equal(cage.isBusy('c6', 'claude'), false);
  });

  it('timeouts cancel the run', async () => {
    const { cage } = makeCage({ raw: { agents: { claude: { timeoutSec: 1 } } } });
    const r = await cage.run({ conversation: 'c7', agent: 'claude', prompt: 'SLEEP forever' });
    assert.equal(r.timedOut, true);
    assert.match(r.errorMessage ?? '', /timed out/);
  });

  it('a lost session is retried once as a fresh session', async () => {
    const { cage, last } = makeCage();
    const first = await cage.run({ conversation: 'c8', agent: 'claude', prompt: 'hello there' });
    const r = await cage.run({ conversation: 'c8', agent: 'claude', prompt: 'FAILRESUME now' });
    assert.equal(r.isError, false, r.errorMessage);
    assert.equal(last('claude').resume, undefined);
    assert.notEqual(r.sessionId, first.sessionId);
    assert.ok(r.notes.some((n) => /could not be resumed/.test(n)));
  });

  it('auth failures surface stderr and a login hint', async () => {
    const { cage } = makeCage();
    const r = await cage.run({ conversation: 'c9', agent: 'claude', prompt: 'AUTHFAIL' });
    assert.equal(r.isError, true);
    assert.match(r.errorMessage ?? '', /Please run \/login/);
    assert.ok(r.notes.some((n) => n.includes('cage login claude')));
  });

  it('redaction: the agent sees placeholders, you see real values', async () => {
    const { cage, last } = makeCage({ raw: { redact: { enabled: true } } });
    const r = await cage.run({ conversation: 'c10', agent: 'claude', prompt: 'mail bob@example.com re card 4111 1111 1111 1111' });
    assert.equal(last('claude').prompt, 'mail [[EMAIL_1]] re card [[CARD_1]]');
    assert.equal(r.text, 'ECHO[claude]:mail bob@example.com re card 4111 1111 1111 1111');
    assert.equal(r.redactions, 2);
  });

  it('secrets set via setToken are loaded into the agent environment', async () => {
    const { cage, last } = makeCage();
    await cage.setToken('gemini', "k3y'with\"quotes");
    await cage.run({ conversation: 'c11', agent: 'gemini', prompt: 'hi there' });
    assert.equal(last('gemini').env.GOOGLE_GENAI_USE_GCA, 'false');
  });

  it('missing CLI gives an actionable error', async () => {
    const { cage, home } = makeCage();
    const { rmSync } = await import('node:fs');
    rmSync(join(home, 'local', 'cage-codex', '.cagevm', 'bin', 'codex'));
    const r = await cage.run({ conversation: 'c12', agent: 'codex', prompt: 'hi there' });
    assert.equal(r.isError, true);
    assert.match(r.errorMessage ?? '', /not installed.*cage update codex/);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
