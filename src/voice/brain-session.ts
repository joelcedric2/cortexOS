import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  // Claude Code shows ❯ in the UI chrome even while thinking.
  // "esc to interrupt" means Claude is still working — NOT ready.
  // "? for shortcuts" means Claude is idle and waiting — ready.
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const tail = lines.slice(-6).join("\n");
  if (tail.includes("esc to interrupt")) return false;
  if (tail.includes("Ionizing") || tail.includes("Thinking")) return false;
  return tail.includes("❯");
}

export interface BrainSessionOptions {
  tmux: TmuxManager;
  workDir?: string;
  sessionName?: string;
  claudeMdContent?: string;
}

// Default: cortexOS repo root (derived from this file's location).
// The brain runs in the project root for full access to MCP tools,
// CLAUDE.md, SOUL.md, and all system capabilities.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORK_DIR = REPO_ROOT;
const DEFAULT_SESSION_NAME = "nchinda_brain";
const BOOT_TIMEOUT_MS = 60_000;
const SEND_TIMEOUT_MS = 60_000;
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
    // Write voice context alongside the existing project CLAUDE.md.
    // The brain runs in the project root so it inherits all project context,
    // MCP tools, and CLAUDE.md. We add voice-specific rules via SOUL.md
    // which the project CLAUDE.md already references.
    const voiceContextPath = join(this.workDir, ".claude", "voice-rules.md");
    await mkdir(join(this.workDir, ".claude"), { recursive: true });
    await writeFile(voiceContextPath, this.claudeMdContent, "utf-8");

    // Pre-approve all tools so the brain session never prompts during voice.
    const settingsPath = join(this.workDir, ".claude", "settings.local.json");
    try {
      // Merge with existing settings if present
      const existing = JSON.parse(await readFile(settingsPath, "utf-8"));
      const allow = new Set(existing?.permissions?.allow ?? []);
      for (const t of ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"]) {
        allow.add(t);
      }
      existing.permissions = { ...existing.permissions, allow: [...allow] };
      await writeFile(settingsPath, JSON.stringify(existing, null, 2), "utf-8");
    } catch {
      // No existing settings — create fresh
      await writeFile(settingsPath, JSON.stringify({
        permissions: {
          allow: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"],
        },
      }, null, 2), "utf-8");
    }

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

      await this.tmux.sendKeys(this.sessionName, message);

      // Poll until Claude finishes: ready prompt visible AND no
      // "esc to interrupt" (still working). We extract the response
      // by finding our sent message in the pane output.
      const deadline = Date.now() + SEND_TIMEOUT_MS;
      let response = "";
      let pollCount = 0;

      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const raw = await this.tmux.capturePane(this.sessionName, 200);
        const cleaned = stripAnsi(raw);
        pollCount++;

        // Log progress every 10s so we know it's alive
        if (pollCount % 20 === 0) {
          const elapsed = Math.round((Date.now() - deadline + SEND_TIMEOUT_MS) / 1000);
          console.log(`[BrainSession] Waiting for response... (${elapsed}s)`);
        }

        // The response is complete when:
        // 1. The ready prompt is visible (❯ with no "esc to interrupt")
        // 2. Our sent message appears in the pane
        // 3. There is response content between the message and the prompt
        if (hasReadyPrompt(cleaned) && cleaned.includes(message.slice(0, 40))) {
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

    // Extract lines between message and prompt, filtering out
    // Claude CLI chrome: tool-use indicators, separators, hints.
    const responseLines = lines.slice(messageLineIndex + 1, promptLineIndex);
    return responseLines
      .map((l) => l.trim())
      .filter((l) => {
        if (l.length === 0) return false;
        // Skip tool-use invocations (⏺ Bash(...), ⏺ Read(...), etc.)
        if (l.startsWith("⏺") && l.includes("(")) return false;
        // Skip tool output lines
        if (l.startsWith("⎿")) return false;
        // Skip separator lines (─ or ━ repeated)
        if (/^[─━\-=]{5,}$/.test(l)) return false;
        // Skip hint/shortcut lines
        if (l.startsWith("?") && l.includes("shortcut")) return false;
        if (l.includes("esc to interrupt")) return false;
        // Skip standalone bullet
        if (l === "⏺") return false;
        return true;
      })
      // Strip the ⏺ prefix from response lines (Claude prefixes its text with it)
      .map((l) => l.startsWith("⏺") ? l.slice(1).trim() : l)
      .join("\n");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
