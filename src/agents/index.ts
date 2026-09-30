import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { cursor } from './cursor.ts';
import { gemini } from './gemini.ts';
import type { AgentAdapter, AgentKind } from './types.ts';

export const ADAPTERS: Record<AgentKind, AgentAdapter> = { claude, codex, gemini, cursor };

export * from './types.ts';
