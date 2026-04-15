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
import { CronJobsDB } from "../scheduler/_cron-jobs-db-stub.js";
import { parseNl, type ParseNlOptions } from "../scheduler/nl-parser.js";

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

const ScheduleInputSchema = z.object({
  utterance: z.string().min(1).max(2_000),
  autoEnable: z.boolean().default(false),
  createdBy: z.enum(["user", "nchinda_proactive"]).default("user"),
  timezone: z.string().min(1).max(64).optional(),
});

export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

export interface ScheduleResult {
  job_id: string;
  cron_expr: string;
  next_run: string;
  rationale: string;
  confidence: number;
  enabled: boolean;
  extractedTask?: string;
}

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
  /** Cron persistence. Injected by caller; required for `schedule()`. */
  cronDb?: CronJobsDB;
  /** Override parseNl options (test seam). */
  parseNlOptions?: ParseNlOptions;
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

  /**
   * nchinda_schedule(utterance, autoEnable?, createdBy?) → create a cron job
   * from a natural-language schedule phrase. Flow: parseNl → db.insert →
   * optionally db.update({enabled: true}) → return summary.
   */
  async schedule(raw: unknown): Promise<ScheduleResult> {
    if (!this.deps.cronDb) {
      throw new Error("nchinda_schedule: cronDb dependency not provided");
    }
    const input = ScheduleInputSchema.parse(raw);
    const parsed = await parseNl(input.utterance, {
      ...(this.deps.parseNlOptions ?? {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    });
    const name = deriveJobName(parsed.extractedTask ?? input.utterance);
    const task = parsed.extractedTask ?? input.utterance;
    const job = this.deps.cronDb.insert({
      name,
      cron_expr: parsed.cron_expr,
      task,
      enabled: false,
      timezone: parsed.timezone,
      created_by: input.createdBy,
    });
    if (input.autoEnable) {
      this.deps.cronDb.update(job.id, { enabled: true });
    }
    const fresh = this.deps.cronDb.getById(job.id);
    if (!fresh) throw new Error("schedule: row vanished after insert");
    return {
      job_id: fresh.id,
      cron_expr: fresh.cron_expr,
      next_run: fresh.next_run.toISOString(),
      rationale: parsed.rationale,
      confidence: parsed.confidence,
      enabled: fresh.enabled,
      extractedTask: parsed.extractedTask,
    };
  }
}


/**
 * Best-effort snake_case job name derived from the utterance. Keeps only
 * alphanumerics + underscores, caps length at 64. Prefixes with `nl_` so
 * user-created rows are visually distinct from onboarding-seeded defaults.
 */
function deriveJobName(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "job";
  return `nl_${base}_${Date.now().toString(36).slice(-6)}`.slice(0, 64);
}

export function createNchindaTools(deps: NchindaToolsDeps): NchindaTools {
  return new NchindaTools(deps);
}
