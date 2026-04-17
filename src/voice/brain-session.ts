import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TmuxManager } from "../tmux/tmux-manager.js";

/**
 * Strips ANSI escape codes from terminal output.
 * Covers colors, cursor moves, erase sequences, and OSC hyperlinks.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1B\]8;;[^\x1B]*\x1B\\/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B[()][AB012]/g, "");
}

/**
 * Strips Claude Code formatting artifacts that shouldn't be spoken by TTS:
 * thinking tags, tool-use blocks, code fences, and markdown headers.
 */
export function stripFormattingForTTS(text: string): string {
  let cleaned = text;
  // Remove <thinking>...</thinking> blocks
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  // Remove <tool_use>...</tool_use> blocks
  cleaned = cleaned.replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, "");
  // Remove <result>...</result> blocks
  cleaned = cleaned.replace(/<result>[\s\S]*?<\/result>/gi, "");
  // Remove code fences
  cleaned = cleaned.replace(/```[\s\S]*?```/g, "");
  // Remove inline code
  cleaned = cleaned.replace(/`[^`]+`/g, "");
  // Remove markdown headers
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, "");
  // Remove bold/italic markers
  cleaned = cleaned.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  // Collapse whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

/**
 * Detects the Claude Code ready prompt in pane output.
 * The CLI shows a prompt character when ready for input.
 */
function hasReadyPrompt(output: string): boolean {
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1]!.trim();
  // Claude Code prompt indicators
  return last.includes("❯") || last.includes("> ") || last.endsWith(">");
}

export interface BrainSessionOptions {
  tmux: TmuxManager;
  workDir?: string;
  sessionName?: string;
  claudeMdContent?: string;
}

const DEFAULT_WORK_DIR = join(homedir(), ".cortexos", "brain");
const DEFAULT_SESSION_NAME = "nchinda_brain";
const BOOT_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * Persistent Claude Code CLI session running inside tmux.
 *
 * Replaces the stateless `claude -p` one-shot with a long-lived session
 * that preserves conversation history, has access to tools, and reads
 * the SOUL.md personality via a project CLAUDE.md file.
 */
export class BrainSession {
  private readonly tmux: TmuxManager;
  private readonly workDir: string;
  private readonly sessionName: string;
  private readonly claudeMdContent: string;
  private _booted = false;

  /** Whether boot() has completed at least once. */
  get isBooted(): boolean {
    return this._booted;
  }

  constructor(opts: BrainSessionOptions) {
    this.tmux = opts.tmux;
    this.workDir = opts.workDir ?? DEFAULT_WORK_DIR;
    this.sessionName = opts.sessionName ?? DEFAULT_SESSION_NAME;
    this.claudeMdContent =
      opts.claudeMdContent ??
      [
        "# Brain Session",
        "",
        "You are Nchinda, a voice-first AI assistant.",
        "Reply conversationally — your output is spoken via TTS.",
        "Keep answers concise. No markdown, no code blocks unless asked.",
        "Use tools (bash, web search) before guessing facts.",
      ].join("\n");
  }

  /**
   * Boot the tmux session and start the Claude CLI inside it.
   *
   * 1. Creates the working directory if needed
   * 2. Writes CLAUDE.md into it (context injection)
   * 3. Creates a tmux session rooted in that directory
   * 4. Starts `claude` inside the session
   * 5. Polls until the CLI is ready (prompt detected) or 30s timeout
   */
  async boot(): Promise<void> {
    await mkdir(this.workDir, { recursive: true });
    await writeFile(join(this.workDir, "CLAUDE.md"), this.claudeMdContent, "utf-8");

    await this.tmux.createSession(this.sessionName, this.workDir);
    await this.tmux.sendKeys(this.sessionName, "claude");

    // Poll for ready prompt
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const output = await this.tmux.capturePane(this.sessionName);
      if (hasReadyPrompt(stripAnsi(output))) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      console.warn(
        `[BrainSession] Claude CLI did not show ready prompt within ${BOOT_TIMEOUT_MS / 1000}s — proceeding anyway`,
      );
    }

    this._booted = true;
  }

  /**
   * Send a voice transcript to the brain and capture the response.
   *
   * Auto-restarts the session if it has died. Returns a clean string
   * suitable for TTS. Never throws — returns an error message on failure.
   */
  async send(message: string): Promise<string> {
    try {
      const alive = await this.isAlive();
      if (!alive) {
        await this.restart();
      }

      // Snapshot the pane before sending so we can diff later
      const preSend = stripAnsi(await this.tmux.capturePane(this.sessionName, 200));

      await this.tmux.sendKeys(this.sessionName, message);

      // Poll until the prompt reappears after new content
      const deadline = Date.now() + SEND_TIMEOUT_MS;
      let response = "";

      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const raw = await this.tmux.capturePane(this.sessionName, 200);
        const cleaned = stripAnsi(raw);

        // The response is complete when the prompt reappears
        // and there is new content beyond our pre-send snapshot
        if (hasReadyPrompt(cleaned) && cleaned.length > preSend.length) {
          response = this.extractResponse(cleaned, message);
          if (response.length > 0) {
            break;
          }
        }
      }

      if (response.length === 0) {
        return "I took too long on that. Try again.";
      }

      return stripFormattingForTTS(response);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[BrainSession] send() failed: ${errMsg}`);
      return "Something went wrong processing that. Try again.";
    }
  }

  /**
   * Check if the tmux session is still alive.
   */
  async isAlive(): Promise<boolean> {
    return this.tmux.sessionExists(this.sessionName);
  }

  /**
   * Kill and restart the session.
   */
  async restart(): Promise<void> {
    await this.shutdown();
    await this.boot();
  }

  /**
   * Clean shutdown: gracefully exit Claude CLI, then destroy the tmux session.
   */
  async shutdown(): Promise<void> {
    try {
      const exists = await this.tmux.sessionExists(this.sessionName);
      if (exists) {
        await this.tmux.sendKeys(this.sessionName, "/exit");
        await sleep(SHUTDOWN_GRACE_MS);
        // Session may still be alive if /exit didn't close it
        const stillExists = await this.tmux.sessionExists(this.sessionName);
        if (stillExists) {
          await this.tmux.destroySession(this.sessionName);
        }
      }
    } catch {
      // Best-effort shutdown — swallow errors from already-dead sessions
    }
    this._booted = false;
  }

  /**
   * Extract the assistant's response from the full pane output.
   *
   * Strategy: find the last occurrence of the sent message, then grab
   * everything between it and the final prompt line.
   */
  private extractResponse(paneOutput: string, sentMessage: string): string {
    const lines = paneOutput.split("\n");

    // Find the last line that contains our sent message
    let messageLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.includes(sentMessage.slice(0, 50))) {
        messageLineIndex = i;
        break;
      }
    }

    if (messageLineIndex === -1) {
      // Fallback: can't find the message, return empty
      return "";
    }

    // Find the last prompt line (response end)
    let promptLineIndex = lines.length - 1;
    for (let i = lines.length - 1; i > messageLineIndex; i--) {
      const trimmed = lines[i]!.trim();
      if (trimmed.includes("❯") || trimmed === ">" || trimmed.endsWith(">")) {
        promptLineIndex = i;
        break;
      }
    }

    // Extract lines between message and prompt
    const responseLines = lines.slice(messageLineIndex + 1, promptLineIndex);
    return responseLines
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
