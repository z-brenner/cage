import { join } from 'node:path';
import { cageHome, readJson, writeJsonAtomic } from './util.ts';

export interface ConversationState {
  defaultAgent?: string;
  repo?: string;
  sessions: Record<string, { sessionId: string; updatedAt: string }>;
}

interface StateFile {
  version: 1;
  conversations: Record<string, ConversationState>;
}

/**
 * Persistent per-conversation state (agent session ids, default agent, repo).
 * Deliberately holds no prompt or response text.
 */
export class StateStore {
  private data: StateFile;
  private readonly path: string;

  constructor(path = join(cageHome(), 'state.json')) {
    this.path = path;
    this.data = readJson<StateFile>(path, { version: 1, conversations: {} });
  }

  conversationKeys(): string[] {
    return Object.keys(this.data.conversations);
  }

  conversation(key: string): ConversationState {
    return this.data.conversations[key] ?? { sessions: {} };
  }

  private update(key: string, fn: (c: ConversationState) => void): void {
    const c = this.conversation(key);
    fn(c);
    this.data.conversations[key] = c;
    writeJsonAtomic(this.path, this.data);
  }

  getSession(conv: string, agent: string): string | undefined {
    return this.conversation(conv).sessions[agent]?.sessionId;
  }

  setSession(conv: string, agent: string, sessionId: string): void {
    this.update(conv, (c) => {
      c.sessions[agent] = { sessionId, updatedAt: new Date().toISOString() };
    });
  }

  clearSessions(conv: string, agent?: string): void {
    this.update(conv, (c) => {
      if (agent) delete c.sessions[agent];
      else c.sessions = {};
    });
  }

  setDefaultAgent(conv: string, agent: string): void {
    this.update(conv, (c) => {
      c.defaultAgent = agent;
    });
  }

  /** Changing repo changes the workdir, which invalidates cwd-scoped sessions (Claude, Gemini). */
  setRepo(conv: string, repo: string | undefined): void {
    this.update(conv, (c) => {
      c.repo = repo;
      c.sessions = {};
    });
  }
}
