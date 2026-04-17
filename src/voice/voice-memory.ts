/**
 * Voice interaction persistence layer.
 *
 * Stores every completed voice interaction in pgvector so that future brain
 * sessions can recall past conversations and build better context.
 *
 * Emits bus events on every store so Phase 7 anti-pattern detection can
 * observe voice failures in real time.
 */

import type { VectorStore } from "../memory/vector-store.js";
import type { Embedder } from "../memory/embedder.js";
import type { EventBus } from "../ipc/event-bus.js";

/** Outcome of a voice interaction. `recovered` maps to `success` at the DB layer. */
export type VoiceOutcome = "success" | "fail" | "recovered";

export interface VoiceMemoryDeps {
  vectorStore: VectorStore;
  embedder: Embedder;
  bus: EventBus;
}

export interface StoreInteractionOpts {
  transcript: string;
  reply: string;
  outcome: VoiceOutcome;
  durationMs: number;
  sessionLabel?: string;
}

/** Agent role used for all voice memories — matches the Nchinda voice agent. */
const VOICE_AGENT_ROLE = "nchinda-voice";
const VOICE_TASK_TYPE = "voice_interaction";
const RECALL_QUERY = "recent voice conversations with Cedric";

export class VoiceMemory {
  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;
  private readonly bus: EventBus;

  constructor(deps: VoiceMemoryDeps) {
    this.vectorStore = deps.vectorStore;
    this.embedder = deps.embedder;
    this.bus = deps.bus;
  }

  /**
   * Store a completed voice interaction in pgvector.
   *
   * 1. Compose content from transcript + reply
   * 2. Embed the content
   * 3. Persist to vector store
   * 4. Emit bus event
   *
   * @returns The memory ID (UUID)
   */
  async storeInteraction(opts: StoreInteractionOpts): Promise<string> {
    const content = `Voice Q: ${opts.transcript}\nVoice A: ${opts.reply}`;
    const embedding = await this.embedder.embed(content);

    // Map 'recovered' to 'success' at the DB boundary — the DB CHECK
    // constraint only allows 'success' | 'fail'.
    const dbOutcome: "success" | "fail" =
      opts.outcome === "fail" ? "fail" : "success";

    const tags = ["voice", opts.sessionLabel ?? "default"];
    if (opts.outcome === "recovered") {
      tags.push("recovered");
    }

    const id = await this.vectorStore.storeMemory({
      agentRole: VOICE_AGENT_ROLE,
      taskType: VOICE_TASK_TYPE,
      content,
      embedding,
      outcome: dbOutcome,
      tags,
    });

    this.bus.emit({
      kind: "plan_emitted",
      payload: {
        phase: "VOICE_MEMORY_STORED",
        transcript: opts.transcript.slice(0, 50),
      },
      ts: new Date(),
    });

    return id;
  }

  /**
   * Recall recent voice interactions for brain session context injection.
   *
   * Returns a formatted markdown string suitable for CLAUDE.md injection,
   * or an empty string if no memories are found.
   */
  async recallRecentInteractions(topK?: number): Promise<string> {
    const embedding = await this.embedder.embed(RECALL_QUERY);
    const results = await this.vectorStore.searchMemories(
      embedding,
      topK ?? 5,
      { agentRole: VOICE_AGENT_ROLE },
    );

    if (results.length === 0) return "";

    const lines = results.map((r, i) => {
      const outcome = r.outcome === "fail" ? "fail" : "success";
      const content = r.content;

      // Parse "Voice Q: ...\nVoice A: ..." back into Q/A
      const qMatch = content.match(/^Voice Q: (.+)/);
      const aMatch = content.match(/\nVoice A: (.+)/);
      const q = qMatch?.[1] ?? content.slice(0, 60);
      const a = aMatch?.[1] ?? "...";

      const age = formatAge(r.createdAt);
      return `${i + 1}. [${outcome}] Q: "${q}" A: "${a}" (${age})`;
    });

    return `## Recent Voice Interactions\n\n${lines.join("\n")}`;
  }

  /**
   * Mark an interaction as failed (user said "no", "wrong", "stop").
   *
   * Updates the memory's outcome to 'fail' and adds the 'anti-pattern:voice'
   * tag so the Phase 7 anti-pattern detection picks it up.
   */
  async markFailed(memoryId: string): Promise<void> {
    await this.vectorStore.updateMemory(memoryId, {
      outcome: "fail",
      addTags: ["anti-pattern:voice"],
    });
  }
}

/** Human-readable relative time from a Date. */
function formatAge(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
