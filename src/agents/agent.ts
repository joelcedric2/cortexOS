import type { AgentRole } from "./roles.js";

export type AgentProvider = "claude" | "gemini" | "codex";

export interface AgentConfig {
  role: AgentRole;
  provider: AgentProvider;
  workingDirectory: string;
  claudeMdPath?: string;
  environmentVars?: Record<string, string>;
}

export interface AgentHandle {
  pid: number;
  slot: number;
  provider: AgentProvider;
  role: AgentRole;
  sessionName: string;
  startedAt: Date;
}

/**
 * Base interface for all AI agent spawners.
 * Each provider (Claude, Gemini, Codex) implements this.
 */
export interface Agent {
  readonly provider: AgentProvider;

  /**
   * Spawn the agent process in the given tmux session.
   * Returns a handle for tracking.
   */
  spawn(config: AgentConfig, sessionName: string): Promise<AgentHandle>;

  /**
   * Send a task/prompt to a running agent via tmux session send-keys.
   */
  sendTask(handle: AgentHandle, task: string): Promise<void>;

  /**
   * Read current output from the agent's tmux session.
   */
  readOutput(handle: AgentHandle): Promise<string>;

  /**
   * Gracefully stop the agent process.
   */
  stop(handle: AgentHandle): Promise<void>;
}
