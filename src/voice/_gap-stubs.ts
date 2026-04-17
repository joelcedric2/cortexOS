/**
 * Gap stubs for Agent 1-4 deliverables. These provide the interfaces
 * that cortex.ts depends on while the real implementations land.
 * Delete this file at integration time.
 */
import type { TmuxManager } from "../tmux/tmux-manager.js";
import type { VectorStore } from "../memory/vector-store.js";
import type { Embedder } from "../memory/embedder.js";

// ---------------------------------------------------------------------------
// Agent 1 — BrainSession
// ---------------------------------------------------------------------------

export interface BrainSessionOptions {
  tmux: TmuxManager;
  claudeMdContent: string;
}

export class BrainSession {
  private alive = false;

  constructor(readonly opts: BrainSessionOptions) {}

  /** Start the persistent Claude Code session in a tmux pane. */
  async boot(): Promise<void> {
    this.alive = true;
  }

  /** Send a transcript and receive a reply from the brain. */
  async send(message: string): Promise<string> {
    if (!this.alive) {
      throw new Error("BrainSession is not running");
    }
    // Stub — returns echo. Real impl polls tmux capture-pane.
    return `[stub] Received: ${message}`;
  }

  /** Check if the brain session tmux pane is still alive. */
  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  /** Kill and re-boot the brain session. */
  async restart(): Promise<void> {
    await this.shutdown();
    await this.boot();
  }

  /** Tear down the brain session tmux pane. */
  async shutdown(): Promise<void> {
    this.alive = false;
  }
}

// ---------------------------------------------------------------------------
// Agent 3 — Brain CLAUDE.md generator
// ---------------------------------------------------------------------------

export interface BuildBrainClaudeMdOptions {
  vectorStore: VectorStore;
  embedder: Embedder;
  userName: string;
}

/**
 * Generates the CLAUDE.md content for the persistent brain session,
 * injecting SOUL.md, tool lists, recent memories, and voice-mode rules.
 */
export async function buildBrainClaudeMd(
  _opts: BuildBrainClaudeMdOptions,
): Promise<string> {
  // Stub — real implementation (Agent 3) will inject SOUL.md, memory, etc.
  return [
    "# Brain Session — cortexOS Voice",
    "",
    "You are Nchinda, the cortexOS voice assistant.",
    "Replies are spoken aloud via TTS. Be conversational and concise.",
    "No markdown, no code blocks, no bullet points.",
    "",
    `User: ${_opts.userName}`,
  ].join("\n");
}
