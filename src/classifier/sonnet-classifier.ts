/**
 * Claude Sonnet-backed classifier.
 *
 * Calls the Anthropic Messages API directly via fetch (no SDK dep, keeps
 * our footprint small and the injection seam easy for tests). Falls back
 * to the heuristic classifier on any error — network, timeout, bad JSON,
 * schema mismatch — so the loop never blocks on a flaky LLM path.
 *
 * The API key is read from `opts.apiKey` or `process.env.ANTHROPIC_API_KEY`.
 * No secret is ever written to disk or logged.
 *
 * History: migrated from Haiku to Sonnet per user directive (2026-04).
 */
import { z } from "zod";
import type {
  Classifier,
  ClassificationResult,
  ClassifierContext,
  ClassifyOptions,
} from "./classifier.js";
import { HeuristicClassifier } from "./heuristic-classifier.js";

const CLASSIFIER_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * The `rationale` field is part of the classifier's return value and may be
 * surfaced to the user / written to memory. The raw error text from an SDK
 * or fetch failure can contain API keys, hostnames, or other bootstrapping
 * detail we don't want to leak. Whitelist only known-safe error categories
 * and describe anything else with a generic label.
 */
const SAFE_REASON_PATTERNS: ReadonlyArray<{ match: RegExp; label: string }> = [
  { match: /abort|timeout|deadline/i, label: "timeout" },
  { match: /429|rate.?limit/i, label: "rate-limited" },
  { match: /\b(5\d\d)\b/, label: "server-error" },
  { match: /\b(4\d\d)\b/, label: "client-error" },
  { match: /invalid.*json|unexpected token|parse/i, label: "parse-error" },
  { match: /schema|zod|invalid response/i, label: "schema-mismatch" },
  { match: /econn|enotfound|network|fetch/i, label: "network" },
];

function redactLlmReason(reason: string): string {
  for (const { match, label } of SAFE_REASON_PATTERNS) {
    if (match.test(reason)) return label;
  }
  return "unknown";
}

/**
 * Schema the LLM must emit. Matches `ClassificationResult` but validated at
 * the boundary — the model can and will hallucinate field names otherwise.
 */
const ResultSchema = z.object({
  complexity: z.enum(["single-shot", "multi-agent"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  suggested_role: z.string().optional(),
});

const SYSTEM_PROMPT =
  "Classify this task as single-shot (one focused agent, <5 tool calls) or " +
  "multi-agent (needs planner + specialists). Return JSON only, with keys " +
  "{complexity, confidence, rationale, suggested_role}. confidence is 0..1. " +
  "suggested_role is optional; populate it only for single-shot tasks.";

export interface LlmClassifierOptions {
  /** API key. Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Hard ceiling on the API round-trip. Defaults to 8s. */
  timeoutMs?: number;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

export class LlmClassifier implements Classifier {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly heuristic = new HeuristicClassifier();

  constructor(opts: LlmClassifierOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async classify(
    task: string,
    ctx?: ClassifierContext,
    opts?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    if (opts?.force_heuristic || !this.apiKey) {
      return this.heuristic.classify(task, ctx, opts);
    }

    try {
      const parsed = await this.callLlm(task, ctx);
      return parsed;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const fallback = await this.heuristic.classify(task, ctx, opts);
      return {
        ...fallback,
        rationale: `[llm-fallback: ${redactLlmReason(reason)}] ${fallback.rationale}`,
      };
    }
  }

  private async callLlm(
    task: string,
    ctx?: ClassifierContext,
  ): Promise<ClassificationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const userContent = buildUserPrompt(task, ctx);

    try {
      const res = await this.fetchImpl(ANTHROPIC_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: CLASSIFIER_MODEL,
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
        }),
      });

      if (!res.ok) {
        throw new Error(`llm http ${res.status}`);
      }

      const body = (await res.json()) as AnthropicMessagesResponse;
      const text = body.content?.find((c) => c.type === "text")?.text ?? "";
      const json = extractJson(text);
      if (!json) throw new Error("no JSON block in llm response");

      const parsed = ResultSchema.parse(JSON.parse(json));
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildUserPrompt(task: string, ctx?: ClassifierContext): string {
  const memBlock =
    ctx?.recentMemories && ctx.recentMemories.length > 0
      ? `\n\nRecent similar memories (for context):\n- ${ctx.recentMemories
          .slice(0, 5)
          .join("\n- ")}`
      : "";
  return `Task: ${task}${memBlock}`;
}

/**
 * Pulls a JSON object out of the model's text response. The model usually
 * returns bare JSON; guard against accidental ```json fencing or leading prose.
 */
function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

export function createLlmClassifier(
  opts?: LlmClassifierOptions,
): Classifier {
  return new LlmClassifier(opts);
}

// Backward-compatible aliases for downstream imports
export { LlmClassifierOptions as HaikuClassifierOptions };
export { LlmClassifier as HaikuClassifier };
export { createLlmClassifier as createHaikuClassifier };
