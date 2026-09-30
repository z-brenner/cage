export const AGENT_KINDS = ['claude', 'codex', 'gemini', 'cursor'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** full = agent may run anything inside its VM (the VM is the sandbox). safe = edits only, no shell. */
export type Autonomy = 'full' | 'safe';

/** A piece of the agent's argv. `{ prompt: true }` is substituted with the (quoted) prompt text in the guest. */
export type ArgPart = string | { prompt: true; prefix?: string };

export interface RunOptions {
  model?: string;
  sessionId?: string;
  autonomy: Autonomy;
  extraArgs?: string[];
}

export interface RunCommand {
  argv: ArgPart[];
  /** stdin: prompt is piped to the CLI's stdin. arg: prompt is placed where `{prompt:true}` appears. */
  promptVia: 'stdin' | 'arg';
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'warning'; message: string }
  | {
      type: 'result';
      text: string;
      isError: boolean;
      errorMessage?: string;
      sessionId?: string;
      usage?: Usage;
      costUsd?: number;
    };

export interface StreamParser {
  /** Feed one stdout line; returns zero or more normalized events. */
  push(line: string): AgentEvent[];
  /** Called after the process exits; may emit a synthesized final result. */
  end(exitCode: number): AgentEvent[];
}

export interface LoginFlow {
  /** Shell command run inside the VM with an interactive TTY. */
  command: string;
  /** guest ports to forward to the same host port (OAuth localhost callbacks). */
  forwardPorts?: number[];
  instructions: string;
}

export interface AgentAdapter {
  kind: AgentKind;
  label: string;
  /** Binary name inside the guest. */
  binary: string;
  run(opts: RunOptions): RunCommand;
  /** Last-chance rewrite of the prompt text, e.g. to dodge CLI subcommand parsing. */
  preparePrompt?(prompt: string): string;
  parser(): StreamParser;
  authCheck: { command: string; parse(stdout: string, exitCode: number): boolean };
  login(opts: { browser?: boolean }): LoginFlow;
  /** Env var for token-style auth (`cage login <agent> --token`), written to the guest's secret env file. */
  token?: { env: string; how: string; extra?: Record<string, string> };
}
