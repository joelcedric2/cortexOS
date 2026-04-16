/**
 * Classifier factory. Thin wrapper that picks an implementation based on the
 * caller's preference and the runtime environment.
 *
 *   mode = "llm"       → always use the LLM classifier (errors still fall
 *                        back internally, but the caller signals intent)
 *   mode = "heuristic" → always use the pure-code classifier
 *   mode = "auto"      → llm if ANTHROPIC_API_KEY is set, else heuristic
 *                        (default)
 */
import type { Classifier } from "./classifier.js";
import { createHeuristicClassifier } from "./heuristic-classifier.js";
import { createLlmClassifier } from "./sonnet-classifier.js";

export type ClassifierMode = "llm" | "heuristic" | "auto";

export interface CreateClassifierOptions {
  mode?: ClassifierMode;
  apiKey?: string;
}

export function createClassifier(
  opts: CreateClassifierOptions = {},
): Classifier {
  const mode = opts.mode ?? "auto";

  if (mode === "heuristic") return createHeuristicClassifier();
  if (mode === "llm") return createLlmClassifier({ apiKey: opts.apiKey });

  // auto
  const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  return key
    ? createLlmClassifier({ apiKey: key })
    : createHeuristicClassifier();
}

export type {
  Classifier,
  ClassificationResult,
  ClassifierContext,
  ClassifyOptions,
  TaskComplexity,
} from "./classifier.js";
export { HeuristicClassifier } from "./heuristic-classifier.js";
export { LlmClassifier, LlmClassifier as HaikuClassifier } from "./sonnet-classifier.js";
