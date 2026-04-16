/**
 * Natural-language → cron expression parser.
 *
 * Two-tier strategy mirroring `src/classifier/sonnet-classifier.ts`:
 *
 *   1. LLM path — Anthropic Messages API, zod-validated, redacted errors.
 *   2. Heuristic path — 12 hand-rolled phrasing matchers. Used when no API
 *      key is set OR when the LLM errors out (so the cron scheduler never
 *      blocks on a flaky LLM).
 *
 * The API key is read from `opts.apiKey` or `process.env.ANTHROPIC_API_KEY`.
 * No secret is ever written to disk or logged; error text is passed through
 * `redactLlmReason()` before landing in `rationale`.
 */
import { z } from "zod";

const LLM_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TZ = "America/New_York";

// --------------------------- Types ----------------------------------------

export interface CronParseResult {
  cron_expr: string;
  timezone: string;
  confidence: number;
  rationale: string;
  extractedTask?: string;
}

export interface ParseNlOptions {
  timezone?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// --------------------------- Error redaction ------------------------------

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

// --------------------------- Schema ---------------------------------------

const LlmResultSchema = z.object({
  cron_expr: z.string().min(3),
  timezone: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  extractedTask: z.string().optional(),
});

const SYSTEM_PROMPT =
  "Convert this scheduling utterance to a standard 5-field cron expression. " +
  "Return ONLY JSON with keys {cron_expr, timezone, confidence (0..1), " +
  "rationale, extractedTask}. Examples: 'every Friday at 5pm' → 0 17 * * 5. " +
  "'weekday mornings at 9' → 0 9 * * 1-5. 'in 3 days at noon' → use a " +
  "one-shot expression.";

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

// --------------------------- Public API -----------------------------------

export async function parseNl(
  utterance: string,
  opts: ParseNlOptions = {},
): Promise<CronParseResult> {
  const tz = opts.timezone ?? DEFAULT_TZ;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return heuristicParse(utterance, tz);
  }

  try {
    return await callLlm(utterance, tz, {
      apiKey,
      fetchImpl: opts.fetchImpl ?? fetch,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const fallback = heuristicParse(utterance, tz);
    return {
      ...fallback,
      rationale: `[llm-fallback: ${redactLlmReason(reason)}] ${fallback.rationale}`,
    };
  }
}

// --------------------------- LLM path ------------------------------------

interface LlmDeps {
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

async function callLlm(
  utterance: string,
  tz: string,
  deps: LlmDeps,
): Promise<CronParseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

  try {
    const res = await deps.fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": deps.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Utterance: ${utterance}\nDefault timezone: ${tz}` }],
      }),
    });

    if (!res.ok) {
      throw new Error(`llm http ${res.status}`);
    }

    const body = (await res.json()) as AnthropicMessagesResponse;
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    const json = extractJson(text);
    if (!json) throw new Error("no JSON block in llm response");

    const parsed = LlmResultSchema.parse(JSON.parse(json));
    return {
      cron_expr: parsed.cron_expr,
      timezone: parsed.timezone ?? tz,
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      extractedTask: parsed.extractedTask,
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

// --------------------------- Heuristic path -------------------------------

const DOW_MAP: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/**
 * Parse a time like "5pm", "5:30pm", "17:00", "9", into [hour, minute].
 * Returns null if the string cannot be interpreted.
 */
function parseTime(input: string): [number, number] | null {
  const s = input.trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = m[3];

  if (mer === "am") {
    if (hour === 12) hour = 0;
  } else if (mer === "pm") {
    if (hour !== 12) hour += 12;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return [hour, minute];
}

function heuristicParse(utterance: string, tz: string): CronParseResult {
  const s = utterance.trim().toLowerCase();

  // Order matters: specific phrases first, then generic "every" forms.

  // "at midnight"
  if (/\bat\s+midnight\b/.test(s) || /^midnight$/.test(s)) {
    return mk("0 0 * * *", tz, 0.9, "matched: at midnight", utterance);
  }
  // "at noon"
  if (/\bat\s+noon\b/.test(s) || /^noon$/.test(s)) {
    return mk("0 12 * * *", tz, 0.9, "matched: at noon", utterance);
  }
  // "hourly"
  if (/^hourly$/.test(s) || /\bevery\s+hour\b/.test(s)) {
    return mk("0 * * * *", tz, 0.9, "matched: hourly", utterance);
  }
  // "nightly"
  if (/^nightly$/.test(s) || /\bnightly\b/.test(s)) {
    return mk("0 2 * * *", tz, 0.85, "matched: nightly (2am)", utterance);
  }
  // "every morning"
  if (/\bevery\s+morning\b/.test(s)) {
    return mk("0 8 * * *", tz, 0.85, "matched: every morning (8am)", utterance);
  }
  // "every evening"
  if (/\bevery\s+evening\b/.test(s)) {
    return mk("0 18 * * *", tz, 0.85, "matched: every evening (6pm)", utterance);
  }

  // "every N minutes"
  const everyMin = s.match(/\bevery\s+(\d{1,2})\s+min(?:ute)?s?\b/);
  if (everyMin) {
    const n = Number(everyMin[1]);
    if (n >= 1 && n <= 59) {
      return mk(`*/${n} * * * *`, tz, 0.9, `matched: every ${n} minutes`, utterance);
    }
  }
  // "every N hours"
  const everyHr = s.match(/\bevery\s+(\d{1,2})\s+hours?\b/);
  if (everyHr) {
    const n = Number(everyHr[1]);
    if (n >= 1 && n <= 23) {
      return mk(`0 */${n} * * *`, tz, 0.9, `matched: every ${n} hours`, utterance);
    }
  }

  // "every weekday at HH(:MM)(am|pm)"
  const weekdayAt = s.match(
    /\bevery\s+weekdays?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/,
  );
  if (weekdayAt) {
    const t = parseTime(weekdayAt[1]!);
    if (t) {
      return mk(
        `${t[1]} ${t[0]} * * 1-5`,
        tz,
        0.9,
        `matched: every weekday at ${weekdayAt[1]}`,
        utterance,
      );
    }
  }
  // "weekday mornings at N"
  const weekdayMorning = s.match(
    /\bweekday\s+mornings?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/,
  );
  if (weekdayMorning) {
    const t = parseTime(weekdayMorning[1]!);
    if (t) {
      return mk(
        `${t[1]} ${t[0]} * * 1-5`,
        tz,
        0.85,
        `matched: weekday mornings at ${weekdayMorning[1]}`,
        utterance,
      );
    }
  }

  // "every weekend at HH(:MM)(am|pm)"
  const weekendAt = s.match(
    /\bevery\s+weekends?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/,
  );
  if (weekendAt) {
    const t = parseTime(weekendAt[1]!);
    if (t) {
      return mk(
        `${t[1]} ${t[0]} * * 0,6`,
        tz,
        0.9,
        `matched: every weekend at ${weekendAt[1]}`,
        utterance,
      );
    }
  }

  // "daily at HH:MM" / "every day at HH:MM"
  const dailyAt = s.match(
    /\b(?:daily|every\s+day)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/,
  );
  if (dailyAt) {
    const t = parseTime(dailyAt[1]!);
    if (t) {
      return mk(
        `${t[1]} ${t[0]} * * *`,
        tz,
        0.9,
        `matched: daily at ${dailyAt[1]}`,
        utterance,
      );
    }
  }

  // "every {Mon|Tue|...}(day)? at HH:MM(am|pm)?"
  const dowAt = s.match(
    /\bevery\s+(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday|s)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/,
  );
  if (dowAt) {
    const dow = DOW_MAP[dowAt[1]!];
    const t = parseTime(dowAt[2]!);
    if (dow !== undefined && t) {
      return mk(
        `${t[1]} ${t[0]} * * ${dow}`,
        tz,
        0.9,
        `matched: every ${dowAt[1]} at ${dowAt[2]}`,
        utterance,
      );
    }
  }

  // No-match fallback: conservative hourly.
  return mk(
    "0 * * * *",
    tz,
    0.2,
    "unrecognized-pattern, defaulting to hourly",
    utterance,
  );
}

function mk(
  cron_expr: string,
  timezone: string,
  confidence: number,
  rationale: string,
  originalUtterance: string,
): CronParseResult {
  return {
    cron_expr,
    timezone,
    confidence,
    rationale,
    extractedTask: extractTaskFrom(originalUtterance),
  };
}

/**
 * Strip the leading schedule phrase from the utterance, leaving whatever task
 * description follows. Best-effort — callers should not rely on this for
 * correctness, only for convenience when seeding `job.task`.
 */
function extractTaskFrom(utterance: string): string | undefined {
  const patterns: RegExp[] = [
    /^\s*(?:every\s+\w+(?:day)?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)[\s,:-]+(.+)$/i,
    /^\s*(?:every\s+weekday\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)[\s,:-]+(.+)$/i,
    /^\s*(?:daily|every\s+day)\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?[\s,:-]+(.+)$/i,
    /^\s*(?:every\s+\d+\s+(?:minutes?|hours?))[\s,:-]+(.+)$/i,
    /^\s*(?:hourly|nightly|at\s+midnight|at\s+noon|every\s+morning|every\s+evening)[\s,:-]+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = utterance.match(re);
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  return undefined;
}
