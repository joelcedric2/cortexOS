import type { Agent, AgentConfig, AgentHandle } from "./agent.js";
import type { TmuxManager } from "../tmux/tmux-manager.js";
import { checkBinaryExists } from "./binary-check.js";

/**
 * Spawns and manages Gemini CLI instances.
 * Uses the `gemini` CLI tool.
 */
export class GeminiAgent implements Agent {
  readonly provider = "gemini" as const;

  constructor(private readonly tmux: TmuxManager) {}

  async spawn(config: AgentConfig, sessionName: string): Promise<AgentHandle> {
    if (!(await checkBinaryExists("gemini"))) {
      throw new Error("gemini CLI is not installed. Install it first.");
    }

    // Gemini CLI reads GEMINI.md from the working directory.
    // Copy the role instructions so Gemini picks them up automatically.
    if (config.claudeMdPath) {
      const { copyFile } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");
      const geminiMdPath = join(dirname(config.claudeMdPath), "GEMINI.md");
      await copyFile(config.claudeMdPath, geminiMdPath);
    }

    const command = "gemini";
    await this.tmux.sendKeys(sessionName, command);

    // Inject role instructions as the first message so Gemini has context
    if (config.claudeMdPath) {
      const { readFile } = await import("node:fs/promises");
      const instructions = await readFile(config.claudeMdPath, "utf-8");
      const condensed = `You are a ${config.role} agent. Follow these rules strictly:\n${instructions.slice(0, 3000)}`;
      await new Promise((r) => setTimeout(r, 2000));
      await this.tmux.sendKeys(sessionName, condensed);
    }

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
