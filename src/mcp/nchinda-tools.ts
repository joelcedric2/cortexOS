/**
 * MCP tool handlers for Nchinda's memory primitives.
 *
 *   nchinda_recall   — top-k semantic search over past memories
 *   nchinda_remember — explicit write into the memory store
 *
 * These handlers sit between the MCP transport (stdio server at
 * scripts/mcp/serve-nchinda.mjs) and the existing `VectorStore` +
 * `Embedder`. They own input validation (zod) and the typed response
 * shape; they do NOT own persistence or embedding — those are delegated.
 *
 * No silent catches: any embedder or store failure propagates. The MCP
 * server layer converts thrown errors into protocol error frames.
 */
import { z } from "zod";
import type {
  VectorStore,
  MemorySearchResult,
} from "../memory/vector-store.js";
import type { Embedder } from "../memory/embedder.js";

// --------------------------- Schemas ---------------------------------------

const RecallInputSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(50).optional(),
  filter: z
    .object({
      agent_role: z.string().optional(),
      task_type: z.string().optional(),
    })
    .optional(),
});

const RememberInputSchema = z.object({
  content: z.string().min(1),
  outcome: z.enum(["success", "fail", "recovered"]),
  tags: z.array(z.string()).default([]),
  agent_role: z.string().optional(),
  task_type: z.string().optional(),
});

export type RecallInput = z.infer<typeof RecallInputSchema>;
export type RememberInput = z.infer<typeof RememberInputSchema>;

// --------------------------- Output types ---------------------------------

export interface RecallHit {
  id: string;
  content: string;
  agent_role: string;
  task_type: string;
  outcome: "success" | "fail";
  tags: string[];
  similarity: number;
  created_at: string;
}

export interface RememberResult {
  id: string;
  stored_at: string;
}

// --------------------------- Dependency bundle -----------------------------

export interface NchindaToolsDeps {
  vectorStore: Pick<VectorStore, "storeMemory" | "searchMemories">;
  embedder: Pick<Embedder, "embed">;
  /** Override current-agent-role lookup (e.g. from registry). Optional. */
  resolveAgentRole?: () => string | undefined;
  /** Wall clock, injectable for tests. */
  now?: () => Date;
}

// --------------------------- Handlers --------------------------------------

export class NchindaTools {
  constructor(private readonly deps: NchindaToolsDeps) {}

  /**
   * nchinda_recall(query, k=5, filter?) → RecallHit[]
   *
   * Embeds `query`, runs a top-k cosine search against `memories`, and
   * returns hydrated rows. The optional `filter` narrows by `agent_role`
   * and/or `task_type` at the DB level.
   */
  async recall(raw: unknown): Promise<RecallHit[]> {
    const input = RecallInputSchema.parse(raw);
    const embedding = await this.deps.embedder.embed(input.query);
    const k = input.k ?? 5;

    const dbFilter: {
      agentRole?: string;
      taskType?: string;
    } = {};
    if (input.filter?.agent_role) dbFilter.agentRole = input.filter.agent_role;
    if (input.filter?.task_type) dbFilter.taskType = input.filter.task_type;

    const hits: MemorySearchResult[] =
      await this.deps.vectorStore.searchMemories(embedding, k, dbFilter);

    return hits.map((h) => ({
      id: h.id,
      content: h.content,
      agent_role: h.agentRole,
      task_type: h.taskType,
      outcome: h.outcome,
      tags: h.tags,
      similarity: h.similarity,
      created_at: h.createdAt.toISOString(),
    }));
  }

  /**
   * nchinda_remember(content, outcome, tags, agent_role?, task_type?)
   *
   * Embeds `content`, persists a memory row, returns the new id + ts.
   *
   * `outcome="recovered"` is collapsed to `"success"` at the DB boundary
   * (the vector_store schema only knows success/fail); the distinction is
   * preserved in the `tags` array as "recovered" so the learning loop can
   * still surface it.
   */
  async remember(raw: unknown): Promise<RememberResult> {
    const input = RememberInputSchema.parse(raw);
    const embedding = await this.deps.embedder.embed(input.content);

    const agentRole =
      input.agent_role ?? this.deps.resolveAgentRole?.() ?? "unknown";
    const taskType = input.task_type ?? "general";

    const dbOutcome: "success" | "fail" =
      input.outcome === "fail" ? "fail" : "success";
    const tags =
      input.outcome === "recovered" && !input.tags.includes("recovered")
        ? [...input.tags, "recovered"]
        : input.tags;

    const id = await this.deps.vectorStore.storeMemory({
      agentRole,
      taskType,
      content: input.content,
      embedding,
      outcome: dbOutcome,
      tags,
    });

    const now = this.deps.now?.() ?? new Date();
    return { id, stored_at: now.toISOString() };
  }
}

export function createNchindaTools(deps: NchindaToolsDeps): NchindaTools {
  return new NchindaTools(deps);
}
