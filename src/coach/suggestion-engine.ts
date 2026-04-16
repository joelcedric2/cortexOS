/**
 * Phase 13 — Real-time Writing Coach: single-shot suggestion engine.
 *
 * Given a {@link DraftSample}, asks Claude Haiku for ONE specific, actionable
 * improvement. Returns `null` if the draft is fine (or on any error — every
 * failure is swallowed so the coach never blocks or blows up the UI).
 *
 * Invariants:
 *   - 5s hard timeout (AbortController)
 *   - Response is zod-validated; schema mismatch → `null`
 *   - `reason` is redacted to a small whitelist of safe labels so no raw
 *     error text reaches audit/UI
 *   - Never throws
 */
import { z } from "zod";
import type { DraftSample } from "./draft-watcher.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_TIMEOUT_MS = 5_000;

// Mirror of the redactor in src/classifier/haiku-classifier.ts — keep the
// label list tight so we never surface raw error text to users.
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

// ────────────────────────── Public types ───────────────────────────────────

export interface CoachSuggestion {
  draft_value: string;
  suggestion: string;
  severity: "nit" | "note" | "important";
  reason: string;
}

export interface SuggestOptions {
  /** Injected for tests. Defaults to the global fetch. */
  haikuFetch?: typeof fetch;
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Override the 5s timeout. */
  timeoutMs?: number;
}

// ────────────────────────── Internal schema ────────────────────────────────

const HaikuResponseSchema = z.union([
  z.null(),
  z.object({
    suggestion: z.string().min(1).max(500),
    severity: z.enum(["nit", "note", "important"]),
    reason: z.string().min(1).max(500),
  }),
]);

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

const SYSTEM_PROMPT =
  "You are a real-time writing coach. Look at the user's DRAFT in the given " +
  "app context. If the draft can be improved in ONE specific way (clarity, " +
  "tone, typo, overclaim, apology-overuse, missing call-to-action), respond " +
  "with JSON {suggestion, severity, reason}. The suggestion MUST be ≤ 25 " +
  "words. severity is one of: nit | note | important. If the draft is fine, " +
  "respond with the literal null (no JSON object). Return JSON only.";

// ────────────────────────── Public API ─────────────────────────────────────

/**
 * Returns a single suggestion for the given draft sample, or `null` if the
 * Haiku call declines, times out, errors, or is not configured.
 */
export async function suggestOnce(
  sample: DraftSample,
  opts: SuggestOptions = {},
): Promise<CoachSuggestion | null> {
  const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return null;
  if (!sample.value || !sample.value.trim()) return null;

  const fetchImpl = opts.haikuFetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(sample) }],
      }),
    });

    if (!res.ok) {
      // Stash redacted reason on a side channel; never throw.
      redactReason(`http ${res.status}`);
      return null;
    }

    const body = (await res.json()) as AnthropicMessagesResponse;
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    const rawJson = extractJsonOrNull(text);
    if (rawJson === undefined) return null;

    const parsed = HaikuResponseSchema.parse(rawJson);
    if (parsed === null) return null;

    return {
      draft_value: sample.value,
      suggestion: parsed.suggestion,
      severity: parsed.severity,
      reason: parsed.reason,
    };
  } catch (err) {
    // Record a redacted label for observability; still resolve null.
    redactReason(err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────── Helpers ────────────────────────────────────────

function buildUserPrompt(sample: DraftSample): string {
  // NOTE: the draft content is sent over the network to Anthropic. That's
  // the explicit contract of this path; the caller decides when to opt in.
  return (
    `Draft in context: {app=${sample.app}} ` +
    `"""${sample.value}"""`
  );
}

/**
 * Extracts a JSON value (object or literal `null`) from Haiku's text block.
 * Returns:
 *   - `null` for a literal null token
 *   - a parsed object
 *   - `undefined` when nothing parseable is present (caller → null suggestion)
 */
function extractJsonOrNull(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Literal null is a valid "no improvement" answer.
  if (trimmed === "null") return null;
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch { return undefined; }
  }
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { return undefined; }
  }
  // Sometimes the model wraps `null` in prose (e.g. `The answer is null.`).
  if (/\bnull\b/i.test(trimmed)) return null;
  return undefined;
}
