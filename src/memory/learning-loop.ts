import type { VectorStore, MemorySearchResult } from "./vector-store.js";
import type { Embedder } from "./embedder.js";
import type { AgentRole } from "../agents/roles.js";

export interface Learning {
  agentRole: AgentRole;
  taskType: string;
  content: string;
  outcome: "success" | "fail";
  tags: string[];
}

export interface TaskContext {
  role: AgentRole;
  taskDescription: string;
  topK?: number;
}

/**
 * Self-learning loop: extract learnings on task completion,
 * query relevant learnings on task start.
 */
export class LearningLoop {
  constructor(
    private readonly vectorStore: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  /**
   * Called when an agent completes a task.
   * Embeds the learning content and persists to pgvector.
   * Must complete reliably -- learnings are persisted before agent teardown.
   */
  async onTaskComplete(learning: Learning): Promise<string> {
    const embedding = await this.embedder.embed(learning.content);
    const id = await this.vectorStore.storeMemory({
      agentRole: learning.agentRole,
      taskType: learning.taskType,
      content: learning.content,
      embedding,
      outcome: learning.outcome,
      tags: learning.tags,
    });
    return id;
  }

  /**
   * Called when an agent starts a new task.
   * Queries for relevant past learnings filtered by role.
   */
  async onTaskStart(context: TaskContext): Promise<MemorySearchResult[]> {
    const embedding = await this.embedder.embed(context.taskDescription);
    const topK = context.topK ?? 5;
    const results = await this.vectorStore.searchMemories(embedding, topK, {
      agentRole: context.role,
    });
    return results;
  }

  /**
   * Build a markdown context string from retrieved learnings
   * for injection into an agent's system prompt.
   */
  formatLearningsForContext(learnings: MemorySearchResult[]): string {
    if (learnings.length === 0) return "";

    const lines = learnings.map((l) => {
      const tag = l.outcome === "success" ? "SUCCESS" : "FAIL";
      const pct = Math.round(l.similarity * 100);
      return `- [${tag}] (${pct}% match) "${l.content}"`;
    });

    return `## Past Learnings (from similar tasks)\n${lines.join("\n")}`;
  }
}
