import type { Agent, AgentConfig, AgentHandle } from "./agent.js";
import type { TmuxManager } from "../tmux/tmux-manager.js";
import { checkBinaryExists } from "./binary-check.js";

/**
 * Spawns and manages Claude Code CLI instances.
 * Uses `claude` CLI with --dangerously-skip-permissions for automation.
 */
export class ClaudeAgent implements Agent {
  readonly provider = "claude" as const;

  constructor(private readonly tmux: TmuxManager) {}

  async spawn(config: AgentConfig, sessionName: string): Promise<AgentHandle> {
    if (!(await checkBinaryExists("claude"))) {
      throw new Error("claude CLI is not installed. Install it first.");
    }

    // Claude Code auto-discovers CLAUDE.md in its working directory.
    // The controller writes CLAUDE.md into agentWorkDir and sets that as cwd.
    const command = "claude --dangerously-skip-permissions";

    await this.tmux.sendKeys(sessionName, command);

    // Auto-accept the bypass permissions warning screen.
    // Claude shows "1. No, exit / 2. Yes, I accept" — we need to send "2".
    await this.waitAndAcceptPermissions(sessionName);

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

  /**
   * Navigate through all startup TUI prompts (settings errors, permissions, etc.)
   * and accept/continue through each until we reach the ❯ input prompt.
   */
  private async waitAndAcceptPermissions(sessionName: string): Promise<void> {
    const maxWait = 45_000;
    const interval = 1_500;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise((r) => setTimeout(r, interval));
      waited += interval;

      try {
        const output = await this.tmux.capturePane(sessionName);

        // Check if we're at the actual input prompt (fully ready)
        // The ❯ in the input area has no "exit" or "confirm" nearby
        if (output.includes("❯") && !output.includes("Enter to confirm") && !output.includes("No, exit")) {
          return;
        }

        // Any TUI selector prompt — navigate to option 2 (continue/accept) and confirm
        if (output.includes("Enter to confirm")) {
          // Move down to option 2 (Continue/Accept) then press Enter
          await this.tmux.sendKeysRaw(sessionName, "Down");
          await new Promise((r) => setTimeout(r, 300));
          await this.tmux.sendKeysRaw(sessionName, "Enter");
          // Wait a bit for next prompt or initialization
          await new Promise((r) => setTimeout(r, 2_000));
          // Don't return — there may be more prompts. Loop again.
          continue;
        }
      } catch {
        // Session may not be fully ready
      }
    }
    console.log(`[ClaudeAgent] Warning: could not confirm ready state for ${sessionName}, proceeding`);
  }

  async stop(handle: AgentHandle): Promise<void> {
    try {
      await this.tmux.sendKeys(handle.sessionName, "/exit");
    } catch {
      // If /exit fails, force kill with Ctrl-C
      try {
        await this.tmux.sendKeys(handle.sessionName, "C-c");
      } catch {
        // Session may already be gone
      }
    }
  }
}
