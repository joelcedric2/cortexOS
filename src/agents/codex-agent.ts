import type { Agent, AgentConfig, AgentHandle } from "./agent.js";
import type { TmuxManager } from "../tmux/tmux-manager.js";
import { checkBinaryExists } from "./binary-check.js";

/**
 * Spawns and manages OpenAI Codex CLI instances.
 * Uses the `codex` CLI tool in full-auto approval mode.
 */
export class CodexAgent implements Agent {
  readonly provider = "codex" as const;

  constructor(private readonly tmux: TmuxManager) {}

  async spawn(config: AgentConfig, sessionName: string): Promise<AgentHandle> {
    if (!(await checkBinaryExists("codex"))) {
      throw new Error("codex CLI is not installed. Install it first.");
    }

    // Codex CLI supports --instructions to point at a file with role instructions
    let command = "codex --approval-mode full-auto";
    if (config.claudeMdPath) {
      command += ` --instructions "${config.claudeMdPath}"`;
    }

    await this.tmux.sendKeys(sessionName, command);

    return {
      pid: 0,
      slot: -1,
      provider: this.provider,
      role: config.role,
      sessionName,
      startedAt: new Date(),
    };
  }

  async sendTask(handle: AgentHandle, task: string): Promise<void> {
    await this.tmux.sendKeys(handle.sessionName, task);
  }

  async readOutput(handle: AgentHandle): Promise<string> {
    return this.tmux.capturePane(handle.sessionName);
  }

  async stop(handle: AgentHandle): Promise<void> {
    try {
      await this.tmux.sendKeys(handle.sessionName, "/exit");
    } catch {
      try {
        await this.tmux.sendKeys(handle.sessionName, "C-c");
      } catch {
        // Session may already be gone
      }
    }
  }
}
