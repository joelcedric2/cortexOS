/**
 * Classifier factory. Thin wrapper that picks an implementation based on the
 * caller's preference and the runtime environment.
 *
 *   mode = "haiku"     → always use the LLM classifier (errors still fall
 *                        back internally, but the caller signals intent)
 *   mode = "heuristic" → always use the pure-code classifier
 *   mode = "auto"      → haiku if ANTHROPIC_API_KEY is set, else heuristic
 *                        (default)
 */
import type { Classifier } from "./classifier.js";
import { createHeuristicClassifier } from "./heuristic-classifier.js";
import { createHaikuClassifier } from "./haiku-classifier.js";

export type ClassifierMode = "haiku" | "heuristic" | "auto";

export interface CreateClassifierOptions {
  mode?: ClassifierMode;
  apiKey?: string;
}

export function createClassifier(
  opts: CreateClassifierOptions = {},
): Classifier {
  const mode = opts.mode ?? "auto";

  if (mode === "heuristic") return createHeuristicClassifier();
  if (mode === "haiku") return createHaikuClassifier({ apiKey: opts.apiKey });

  // auto
  const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  return key
    ? createHaikuClassifier({ apiKey: key })
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
export { HaikuClassifier } from "./haiku-classifier.js";
