/**
 * Zero-LLM fallback classifier. Used when:
 *   - ANTHROPIC_API_KEY is not set in the environment, OR
 *   - caller passes { force_heuristic: true }, OR
 *   - the Haiku classifier itself fails and the loop retries.
 *
 * Rules (intentionally conservative — a miss here is recoverable by the
 * Autonomy Loop's fallback chain; a wrong single-shot call could strand a
 * multi-step task on one pane):
 *
 *   1. If the task wordcount exceeds MAX_SINGLE_SHOT_WORDS OR contains any
 *      "multi-agent" signal phrase → multi-agent (high confidence).
 *   2. Else if it contains any "single-shot" signal verb → single-shot.
 *   3. Else default multi-agent with 0.5 confidence.
 */
import type {
  Classifier,
  ClassificationResult,
  ClassifyOptions,
  ClassifierContext,
} from "./classifier.js";

const MAX_SINGLE_SHOT_WORDS = 100;

/**
 * Signal phrases that strongly indicate a multi-agent task. Matched with a
 * single case-insensitive regex — kept as word-boundary fragments so e.g.
 * "research the architecture" triggers via "architect", while "refactoring"
 * triggers via "refactor the codebase".
 *
 * Note: `&&` is a literal shell/prose operator indicating compound work
 * ("ship X && update docs && notify"), which nearly always warrants a plan.
 */
const MULTI_AGENT_PATTERNS: RegExp[] = [
  /&&/,
  /\bplan\b/i,
  /\barchitect\b/i,
  /\bdesign the\b/i,
  /\bend-to-end\b/i,
  /\bmultiple\b/i,
  /\bacross\b/i,
  /\brefactor the codebase\b/i,
];

const SINGLE_SHOT_PATTERNS: RegExp[] = [
  /\bcheck\b/i,
  /\blook up\b/i,
  /\bwhat is\b/i,
  /\bsummari[sz]e\b/i,
  /\bquick\b/i,
  /\bone-liner\b/i,
  /\bread\b/i,
  /\blist\b/i,
  /\bsearch\b/i,
];

/**
 * Rough role hint for single-shot tasks. First match wins; absence is fine
 * and the orchestrator falls back to its own default.
 */
function suggestRole(task: string): string | undefined {
  const t = task.toLowerCase();
  if (/\b(read|summari[sz]e|what is|look up|search|find)\b/.test(t)) {
    return "researcher";
  }
  if (/\b(list|check|status)\b/.test(t)) return "operator";
  if (/\b(fix|write|implement|patch|refactor)\b/.test(t)) return "coder";
  return undefined;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export class HeuristicClassifier implements Classifier {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async classify(
    task: string,
    _ctx?: ClassifierContext,
    _opts?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    const trimmed = task.trim();
    if (trimmed.length === 0) {
      return {
        complexity: "multi-agent",
        confidence: 0.3,
        rationale: "empty task — defaulting to multi-agent for safety",
      };
    }

    const words = wordCount(trimmed);

    const multiHit = MULTI_AGENT_PATTERNS.find((re) => re.test(trimmed));
    if (words > MAX_SINGLE_SHOT_WORDS || multiHit) {
      return {
        complexity: "multi-agent",
        confidence: multiHit ? 0.85 : 0.8,
        rationale: multiHit
          ? `matched multi-agent pattern ${multiHit.source}`
          : `task is ${words} words (> ${MAX_SINGLE_SHOT_WORDS})`,
      };
    }

    const singleHit = SINGLE_SHOT_PATTERNS.find((re) => re.test(trimmed));
    if (singleHit) {
      return {
        complexity: "single-shot",
        confidence: 0.8,
        rationale: `matched single-shot pattern ${singleHit.source}`,
        suggested_role: suggestRole(trimmed),
      };
    }

    return {
      complexity: "multi-agent",
      confidence: 0.5,
      rationale: "no signal phrases matched — default multi-agent",
    };
  }
}

export function createHeuristicClassifier(): Classifier {
  return new HeuristicClassifier();
}
