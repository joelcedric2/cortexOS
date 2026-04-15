/**
 * Claude Haiku-backed classifier.
 *
 * Calls the Anthropic Messages API directly via fetch (no SDK dep, keeps
 * our footprint small and the injection seam easy for tests). Falls back
 * to the heuristic classifier on any error — network, timeout, bad JSON,
 * schema mismatch — so the loop never blocks on a flaky LLM path.
 *
 * The API key is read from `opts.apiKey` or `process.env.ANTHROPIC_API_KEY`.
 * No secret is ever written to disk or logged.
 */
import { z } from "zod";
import type {
  Classifier,
  ClassificationResult,
  ClassifierContext,
  ClassifyOptions,
} from "./classifier.js";
import { HeuristicClassifier } from "./heuristic-classifier.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_TIMEOUT_MS = 8_000;

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

export interface HaikuClassifierOptions {
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

export class HaikuClassifier implements Classifier {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly heuristic = new HeuristicClassifier();

  constructor(opts: HaikuClassifierOptions = {}) {
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
      const parsed = await this.callHaiku(task, ctx);
      return parsed;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const fallback = await this.heuristic.classify(task, ctx, opts);
      return {
        ...fallback,
        rationale: `[haiku-fallback: ${reason}] ${fallback.rationale}`,
      };
    }
  }

  private async callHaiku(
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
          model: HAIKU_MODEL,
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
        }),
      });

      if (!res.ok) {
        throw new Error(`haiku http ${res.status}`);
      }

      const body = (await res.json()) as AnthropicMessagesResponse;
      const text = body.content?.find((c) => c.type === "text")?.text ?? "";
      const json = extractJson(text);
      if (!json) throw new Error("no JSON block in haiku response");

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
 * Pulls a JSON object out of the model's text response. Haiku usually returns
 * bare JSON; guard against accidental ```json fencing or leading prose.
 */
function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

export function createHaikuClassifier(
  opts?: HaikuClassifierOptions,
): Classifier {
  return new HaikuClassifier(opts);
}
