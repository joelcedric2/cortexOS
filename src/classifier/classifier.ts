/**
 * Intent classifier contract for Nchinda's Autonomy Loop.
 *
 * Given a raw user task, the classifier decides whether to route it to a
 * single focused agent ("single-shot", typically <5 tool calls) or to spin
 * up a full multi-agent swarm ("multi-agent", planner + specialists).
 *
 * This file contains PURE TYPES. Implementations live in sibling files
 * (`sonnet-classifier.ts`, `heuristic-classifier.ts`). Agent A (Autonomy Loop)
 * depends on this contract — do not change the shape without coordination.
 */

/** Two-way routing decision. Everything downstream keys off this literal. */
export type TaskComplexity = "single-shot" | "multi-agent";

export interface ClassificationResult {
  /** Routing decision. */
  complexity: TaskComplexity;
  /** Classifier self-confidence, 0..1 inclusive. */
  confidence: number;
  /** Short human-readable explanation. Shown in logs + the dashboard. */
  rationale: string;
  /**
   * Optional hint for the orchestrator when `complexity === "single-shot"`.
   * Examples: "researcher", "coder", "tester". Ignored for multi-agent.
   */
  suggested_role?: string;
}

/**
 * Optional context supplied by the loop. `recentMemories` is typically the
 * top-k result of a `nchinda_recall` call on the incoming task; passing them
 * in lets the classifier bias toward patterns we've seen before.
 */
export interface ClassifierContext {
  recentMemories?: string[];
}

/**
 * Options a caller can force at classify-time. Useful for tests and for the
 * loop's fallback chain (e.g. "LLM just errored, re-run with heuristic").
 */
export interface ClassifyOptions {
  /** Force the pure-code heuristic even if an LLM classifier is wired up. */
  force_heuristic?: boolean;
}

export interface Classifier {
  classify(
    task: string,
    ctx?: ClassifierContext,
    opts?: ClassifyOptions,
  ): Promise<ClassificationResult>;
}
