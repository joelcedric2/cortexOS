/**
 * MCP tool handler for `nchinda_research` (plan §2.3, inline form).
 *
 * Exposes the H→P→R→B research loop as a JSON-RPC tool call so any agent
 * can ask a quick research question inline without spinning up a dedicated
 * `researcher` role + tmux pane. The heavy lifting lives in
 * `src/research/research-loop.ts`; this file is a thin, validated edge.
 *
 * Input is zod-validated at the boundary. The loop handles its own
 * redaction + budget, so errors bubbling out of here are already safe to
 * surface over the wire.
 */
import { z } from "zod";
import type { Brief } from "../research/brief-schema.js";
import {
  runResearch,
  type ResearchDepth,
  type ResearchOptions,
} from "../research/research-loop.js";

// --------------------------- Schemas ---------------------------------------

const DepthSchema = z.enum(["normal", "deep"]);

const ResearchInputSchema = z.object({
  question: z.string().min(1),
  depth: DepthSchema.optional(),
  /** Overall budget in ms. Clamped to 10min. */
  timeBudgetMs: z.number().int().min(1_000).max(600_000).optional(),
});

export type ResearchInput = z.infer<typeof ResearchInputSchema>;

// --------------------------- Dependency bundle -----------------------------

export interface ResearchToolDeps {
  /**
   * Shared options injected into `runResearch`. Callers typically pass
   * `{bus, fetchImpl?, apiKey?, probeExecutors?}`. Per-call fields
   * (question, depth, timeBudgetMs) are merged in below.
   */
  runtime?: Omit<ResearchOptions, "depth" | "timeBudgetMs">;
}

// --------------------------- Handler --------------------------------------

export class ResearchTool {
  constructor(private readonly deps: ResearchToolDeps = {}) {}

  /**
   * nchinda_research(question, depth?, timeBudgetMs?) → Brief
   *
   * Validates input, merges runtime defaults, runs the loop, returns the
   * Brief verbatim. `Brief` is already zod-validated by the loop before
   * it resolves, so no extra parse is needed here.
   */
  async research(raw: unknown): Promise<Brief> {
    const input = ResearchInputSchema.parse(raw);
    const depth: ResearchDepth = input.depth ?? "normal";
    const opts: ResearchOptions = {
      ...(this.deps.runtime ?? {}),
      depth,
    };
    if (input.timeBudgetMs !== undefined) {
      opts.timeBudgetMs = input.timeBudgetMs;
    }
    return runResearch(input.question, opts);
  }
}

export function createResearchTool(deps?: ResearchToolDeps): ResearchTool {
  return new ResearchTool(deps);
}
