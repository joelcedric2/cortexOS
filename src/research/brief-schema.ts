/**
 * Research Brief — structured output of the H→P→R→B loop (plan §2.3).
 *
 * This file is the contract between the research loop (producer) and every
 * consumer: the MCP tool handler, the `researcher` role, pgvector persistence,
 * Designer recall, Mission Control UI. It is imported before any behaviour is
 * published so downstream agents can target a stable shape.
 *
 * Kept schema-only (no runtime deps beyond zod). If you add fields, append
 * at the end of each object and mark them optional — do not re-order.
 */
import { z } from "zod";

// --------------------------- Hypothesis ------------------------------------

/**
 * One candidate explanation / approach emitted during the HYPOTHESIZE phase.
 *
 * Lifecycle:
 *   1. HYPOTHESIZE fills   { h, prior, verdict: 'inconclusive' }
 *   2. DESIGN_PROBES fills { probe }
 *   3. EXECUTE_PROBES fills { result }
 *   4. UPDATE_BELIEFS fills { posterior, verdict }
 */
export const HypothesisVerdictSchema = z.enum([
  "confirmed",
  "falsified",
  "inconclusive",
]);

export type HypothesisVerdict = z.infer<typeof HypothesisVerdictSchema>;

export const HypothesisSchema = z.object({
  /** The hypothesis statement in plain English. */
  h: z.string().min(1),
  /** Prior probability this hypothesis is right, 0..1. */
  prior: z.number().min(0).max(1),
  /** Smallest experiment that would confirm or falsify `h`. */
  probe: z.string().min(1),
  /** Raw probe result text (scratchpad output). Optional pre-EXECUTE. */
  result: z.string().optional(),
  /** Posterior after Bayesian-flavored update, 0..1. Optional pre-UPDATE. */
  posterior: z.number().min(0).max(1).optional(),
  /** Final verdict on this hypothesis. Defaults to inconclusive. */
  verdict: HypothesisVerdictSchema,
});

export type Hypothesis = z.infer<typeof HypothesisSchema>;

// --------------------------- Brief -----------------------------------------

/**
 * Consolidated research output. Matches the JSON example in plan §2.3.
 *
 * Persistence: Agent B tags these with `research_brief` in pgvector so the
 * Designer can recall relevant briefs on future similar questions.
 */
export const BriefSchema = z.object({
  /** The original question that triggered the loop. */
  question: z.string().min(1),
  /** All hypotheses the loop considered, with their trajectory. */
  hypotheses: z.array(HypothesisSchema).min(1),
  /**
   * Id (== `h` text) of the winning hypothesis. Absent if every hypothesis
   * came back `inconclusive` — consumer should treat that as "more research
   * needed" and not act.
   */
  winning: z.string().optional(),
  /** URLs / pointers / file paths backing the winner. */
  evidence: z.array(z.string()),
  /** Questions the loop couldn't answer — fuel for the next cycle. */
  open_questions: z.array(z.string()),
  /** One-line actionable recommendation. */
  recommended_action: z.string().min(1),
  /** Overall confidence in `recommended_action`, 0..1. */
  confidence: z.number().min(0).max(1),
  /** Rough token cost of the full loop. Optional — best effort. */
  cost_tokens: z.number().int().nonnegative().optional(),
  /** Wall-clock seconds the loop ran. Optional — best effort. */
  cost_seconds: z.number().nonnegative().optional(),
});

export type Brief = z.infer<typeof BriefSchema>;

// --------------------------- Phase labels ----------------------------------

/**
 * Phase names emitted on the event bus as `plan_emitted` payloads, so the
 * journal in Mission Control can show the research loop ticking through.
 */
export const RESEARCH_PHASES = [
  "HYPOTHESIZE",
  "DESIGN_PROBES",
  "EXECUTE_PROBES",
  "UPDATE_BELIEFS",
  "BRIEF",
] as const;

export type ResearchPhase = (typeof RESEARCH_PHASES)[number];

// --------------------------- Parse helper ----------------------------------

/**
 * Strict parse — throws a `ZodError` if the Haiku consolidation step returns
 * anything that doesn't round-trip. Callers should wrap in a schema-mismatch
 * handler; silent catches are forbidden.
 */
export function parseBrief(raw: unknown): Brief {
  return BriefSchema.parse(raw);
}
