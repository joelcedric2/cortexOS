import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

const SESSION_PREFIX = "cortexos_";

export class TmuxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly tmuxArgs?: string[],
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

/**
 * Manages tmux sessions for agent orchestration.
 * Each agent gets its own tmux session prefixed with "cortexos_".
 */
export class TmuxManager {
  private prefixed(name: string): string {
    return `${SESSION_PREFIX}${name}`;
  }

  /**
   * Creates a new detached tmux session for an agent.
   */
  async createSession(
    name: string,
    workingDir: string,
    command?: string,
  ): Promise<void> {
    const sessionName = this.prefixed(name);
    const args = ["new-session", "-d", "-s", sessionName, "-c", workingDir];
    if (command) {
      args.push(command);
    }
    await this.exec(args);
    await this.exec(["set-option", "-t", sessionName, "history-limit", "10000"]);
    await this.exec(["set-option", "-t", sessionName, "mouse", "on"]);
  }

  /**
   * Destroys a tmux session.
   */
  async destroySession(name: string): Promise<void> {
    await this.exec(["kill-session", "-t", this.prefixed(name)]);
  }

  /**
   * Checks whether a tmux session exists.
   */
  async sessionExists(name: string): Promise<boolean> {
    try {
      await this.exec(["has-session", `-t=${this.prefixed(name)}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends text to a tmux session. For single-line text, uses send-keys.
   * For multi-line text, uses load-buffer + paste-buffer so Claude Code
   * receives it as a proper paste event instead of fragmented keystrokes.
   * Always followed by Enter to submit.
   */
  async sendKeys(name: string, keys: string): Promise<void> {
    const sessionTarget = this.prefixed(name);

    if (keys.includes("\n") || keys.length > 200) {
      // Multi-line or long text: write to temp file, load into tmux buffer, paste
      const tmpFile = join(tmpdir(), `cortexos_buf_${Date.now()}.txt`);
      await writeFile(tmpFile, keys, "utf-8");
      await this.exec(["load-buffer", tmpFile]);
      await this.exec(["paste-buffer", "-t", sessionTarget]);
      // Small delay to let Claude Code process the paste, then submit
      await new Promise((r) => setTimeout(r, 500));
      await this.exec(["send-keys", "-t", sessionTarget, "Enter"]);
      // Cleanup temp file
      unlink(tmpFile).catch(() => {});
    } else {
      // Single-line: direct send-keys is fine
      const escaped = keys.replace(/'/g, "'\\''");
      await this.exec([
        "send-keys",
        "-t",
        sessionTarget,
        escaped,
        "Enter",
      ]);
    }
  }

  /**
   * Sends a raw tmux key (e.g. "Down", "Enter", "C-c") without appending Enter.
   * Used for TUI navigation where individual keypresses are needed.
   */
  async sendKeysRaw(name: string, key: string): Promise<void> {
    await this.exec([
      "send-keys",
      "-t",
      this.prefixed(name),
      key,
    ]);
  }

  /**
   * Captures the visible pane content from a session.
   * If lines is specified, captures that many lines of scrollback.
   */
  async capturePane(name: string, lines?: number): Promise<string> {
    const args = ["capture-pane", "-t", this.prefixed(name), "-p", "-J"];
    if (lines !== undefined) {
      args.push("-S", `-${lines}`);
    }
    return this.exec(args);
  }

  /**
   * Lists all cortexos_ tmux sessions, returning their unprefixed names.
   */
  async listSessions(): Promise<string[]> {
    try {
      const output = await this.exec([
        "list-sessions",
        "-F",
        "#{session_name}",
      ]);
      return output
        .split("\n")
        .filter((s) => s.startsWith(SESSION_PREFIX))
        .map((s) => s.slice(SESSION_PREFIX.length));
    } catch {
      // tmux returns error when no server is running / no sessions exist
      return [];
    }
  }

  /**
   * Attaches to a session interactively.
   * Only useful when run from a real terminal.
   */
  async attachSession(name: string): Promise<void> {
    await this.exec(["attach-session", "-t", this.prefixed(name)]);
  }

  /**
   * Colors the active pane's border in a session. Used by the controller to
   * give each agent's pane a role-specific border (Nchinda plan §5.3). `color`
   * should be one of the standard tmux color names (e.g. "cyan", "blue",
   * "yellow", "magenta", "red", "green", "white").
   */
  async setPaneBorderColor(name: string, color: string): Promise<void> {
    const sessionTarget = this.prefixed(name);
    await this.exec([
      "set-option",
      "-t",
      sessionTarget,
      "pane-active-border-style",
      `fg=${color}`,
    ]);
    await this.exec([
      "set-option",
      "-t",
      sessionTarget,
      "pane-border-style",
      `fg=${color}`,
    ]);
    await this.exec([
      "set-option",
      "-t",
      sessionTarget,
      "pane-border-status",
      "top",
    ]);
  }

  /**
   * Captures the pane and returns a SHA-256 hash of its content.
   * Useful for polling-based change detection.
   */
  async hashOutput(name: string): Promise<string> {
    const content = await this.capturePane(name);
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Executes a tmux command and returns trimmed stdout.
   * Throws TmuxError on failure.
   */
  private async exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("tmux", args);
      return stdout.trimEnd();
    } catch (err: unknown) {
      const error = err as Error & { stderr?: string; code?: number };
      const message =
        error.stderr?.trim() || error.message || "tmux command failed";
      throw new TmuxError(message, "TMUX_EXEC_FAILED", args);
    }
  }
}
