/**
 * Meta-tool `tool_discovery` (plan §5.1).
 *
 * Given a natural-language `need`, ask Claude Haiku to pick the top 3 tools
 * from our catalog. Catalog defaults to `NCHINDA_TOOL_SCHEMAS` (we map each
 * schema to a `{name, description}` pair) but can be overridden for tests
 * or alternative registries.
 *
 * Mirrors the HaikuClassifier's fetch path deliberately: same 8s timeout,
 * same AbortController wiring, same whitelist-based error redaction. All
 * failures resolve to `[]` with a redacted warn — this is a hint surface,
 * not a critical path, and we never want to block a caller on a flaky LLM.
 *
 * The API key is read from `opts.apiKey` or `process.env.ANTHROPIC_API_KEY`.
 * If neither is set we return `[]` without hitting the network.
 */
import { z } from "zod";
import { NCHINDA_TOOL_SCHEMAS } from "../mcp/tool-schema.js";

// --------------------------- Constants ------------------------------------

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_SUGGESTIONS = 3;

// --------------------------- Types ----------------------------------------

export interface ToolSuggestion {
  name: string;
  confidence: number;
  rationale: string;
}

export interface ToolDiscoveryOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  catalog?: Array<{ name: string; description: string }>;
}

// --------------------------- Redaction ------------------------------------

const SAFE_REASON_PATTERNS: ReadonlyArray<{ match: RegExp; label: string }> = [
  { match: /abort|timeout|deadline/i, label: "timeout" },
  { match: /429|rate.?limit/i, label: "rate-limited" },
  { match: /\b(5\d\d)\b/, label: "server-error" },
  { match: /\b(4\d\d)\b/, label: "client-error" },
  { match: /invalid.*json|unexpected token|parse/i, label: "parse-error" },
  { match: /schema|zod|invalid response/i, label: "schema-mismatch" },
  { match: /econn|enotfound|network|fetch/i, label: "network" },
];

function redactReason(reason: string): string {
  for (const { match, label } of SAFE_REASON_PATTERNS) {
    if (match.test(reason)) return label;
  }
  return "unknown";
}

// --------------------------- Schema ---------------------------------------

const SuggestionSchema = z.object({
  name: z.string().min(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

const ResponseSchema = z.object({
  suggestions: z.array(SuggestionSchema),
});

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

// --------------------------- Public API -----------------------------------

/**
 * Ask Haiku which tools from our catalog best satisfy `need`.
 *
 * Returns the top 3 suggestions sorted by confidence descending. Always
 * resolves; on any error (no API key, network, timeout, malformed JSON,
 * schema mismatch) returns `[]` with a redacted warning.
 */
export async function toolDiscovery(
  need: string,
  opts: ToolDiscoveryOptions = {},
): Promise<ToolSuggestion[]> {
  if (!need || !need.trim()) return [];

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[tool_discovery] no ANTHROPIC_API_KEY — returning []");
    return [];
  }

  const catalog =
    opts.catalog ??
    NCHINDA_TOOL_SCHEMAS.map((s) => ({
      name: s.name,
      description: s.description,
    }));

  if (catalog.length === 0) return [];

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const suggestions = await callHaiku({
      need,
      catalog,
      apiKey,
      fetchImpl,
      timeoutMs,
    });
    return suggestions
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_SUGGESTIONS);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[tool_discovery] haiku failed: ${redactReason(reason)}`);
    return [];
  }
}

// --------------------------- Haiku call -----------------------------------

async function callHaiku(args: {
  need: string;
  catalog: Array<{ name: string; description: string }>;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<ToolSuggestion[]> {
  const { need, catalog, apiKey, fetchImpl, timeoutMs } = args;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const prompt = buildPrompt(need, catalog);

  try {
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 512,
        system:
          "You recommend tools from a fixed catalog. Return ONLY valid JSON " +
          "matching {\"suggestions\":[{name,confidence,rationale}]}. " +
          "confidence is 0..1 (0 if no tool fits). Never invent tool names " +
          "outside the catalog.",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`haiku http ${res.status}`);
    }

    const body = (await res.json()) as AnthropicMessagesResponse;
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    const json = extractJson(text);
    if (!json) throw new Error("no JSON block in haiku response");

    const parsed = ResponseSchema.parse(JSON.parse(json));

    // Drop any suggestions pointing at tools not in the catalog — cheap
    // hedge against model hallucinating names.
    const allowed = new Set(catalog.map((c) => c.name));
    const filtered = parsed.suggestions.filter((s) => allowed.has(s.name));
    return filtered;
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(
  need: string,
  catalog: Array<{ name: string; description: string }>,
): string {
  const catalogJson = JSON.stringify(catalog, null, 2);
  return (
    `Given this need: '${need}'. Here is our tool catalog:\n` +
    catalogJson +
    `\n\nReturn ONLY JSON {suggestions: [{name, confidence (0..1), ` +
    `rationale}]} with the top 3 candidates. confidence=0 if no tool fits.`
  );
}

/** Pull the first JSON object out of a Haiku text response. */
function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}
