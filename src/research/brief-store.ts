import type { VectorStore, MemorySearchResult } from "../memory/vector-store.js";
import type { Embedder } from "../memory/embedder.js";
import type { Brief } from "./_research-stub.js";

/**
 * Context attached to a persisted Brief so we can later trace it back to
 * the task / session / agent that produced it. Kept narrow by design —
 * richer provenance belongs on the Brief itself, not on the store.
 */
export interface BriefPersistContext {
  task_id: string;
  session_id?: string;
  agent_role?: string;
}

export interface BriefSearchResult {
  id: string;
  brief: Brief;
  similarity: number;
  tags: string[];
  createdAt: Date;
}

export interface BriefStoreDeps {
  vectorStore: Pick<VectorStore, "storeMemory" | "searchMemories">;
  embedder: Pick<Embedder, "embed">;
}

/**
 * Persistence layer for research Briefs. Wraps the pgvector VectorStore
 * with Brief-specific semantics:
 *
 *  - `persist(brief, ctx)`: embeds a short summary and stores the full
 *    Brief as JSON under task_type="research_brief" with tags
 *    `["research_brief", task_id, session_id?]`.
 *  - `recall(question, topK, minConfidence)`: embeds the question, pulls
 *    the top-K research_brief rows, filters by a minimum similarity, and
 *    hydrates the JSON back into `Brief` objects.
 *
 * Designed so the Designer (and any future role) can pull relevant prior
 * research before dispatching new work — Phase 2.5 DoD.
 */
export class BriefStore {
  private readonly vectorStore: BriefStoreDeps["vectorStore"];
  private readonly embedder: BriefStoreDeps["embedder"];

  constructor(deps: BriefStoreDeps) {
    this.vectorStore = deps.vectorStore;
    this.embedder = deps.embedder;
  }

  /**
   * Persist a Brief and return its memory id. Tags include `research_brief`
   * (type discriminator), the originating `task_id`, and optionally the
   * `session_id` so we can slice by conversation later.
   */
  async persist(brief: Brief, ctx: BriefPersistContext): Promise<string> {
    const summary = this.composeSummary(brief);
    const embedding = await this.embedder.embed(summary);

    const tags = ["research_brief", ctx.task_id];
    if (ctx.session_id) tags.push(ctx.session_id);

    return this.vectorStore.storeMemory({
      agentRole: ctx.agent_role ?? "researcher",
      taskType: "research_brief",
      content: JSON.stringify(brief),
      embedding,
      outcome: "success",
      tags,
    });
  }

  /**
   * Retrieve prior Briefs whose question is semantically similar to
   * `question`. Results below `minConfidence` (cosine similarity) are
   * dropped. Unparseable rows are skipped rather than throwing — a
   * corrupted cache line should not take down the whole call site.
   */
  async recall(
    question: string,
    topK = 3,
    minConfidence = 0.5,
  ): Promise<BriefSearchResult[]> {
    const embedding = await this.embedder.embed(question);
    const rows = await this.vectorStore.searchMemories(embedding, topK, {
      taskType: "research_brief",
    });

    const out: BriefSearchResult[] = [];
    for (const row of rows) {
      if (row.similarity < minConfidence) continue;
      const brief = this.safeParseBrief(row);
      if (!brief) continue;
      out.push({
        id: row.id,
        brief,
        similarity: row.similarity,
        tags: row.tags,
        createdAt: row.createdAt,
      });
    }
    return out;
  }

  private composeSummary(brief: Brief): string {
    return [
      brief.question,
      brief.winning ?? "",
      brief.recommended_action,
      brief.evidence.join(" "),
    ].join(" | ");
  }

  private safeParseBrief(row: MemorySearchResult): Brief | null {
    try {
      const parsed = JSON.parse(row.content) as Brief;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.question !== "string" ||
        typeof parsed.recommended_action !== "string" ||
        typeof parsed.confidence !== "number" ||
        !Array.isArray(parsed.evidence) ||
        !Array.isArray(parsed.open_questions) ||
        !Array.isArray(parsed.hypotheses)
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
