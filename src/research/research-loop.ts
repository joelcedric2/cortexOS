/**
 * Nchinda H→P→R→B research loop (plan §2.3).
 *
 * Runs four phases against one natural-language question:
 *
 *   1. HYPOTHESIZE      — one Haiku call emits `{hypotheses: [{h, prior, probe}]}`
 *   2. EXECUTE_PROBES   — Promise.all, dispatched through ProbeExecutor chain
 *   3. UPDATE_BELIEFS   — one Haiku call scores each (h, probe, result) triple
 *   4. BRIEF            — one Haiku call consolidates into the Brief schema
 *
 * The loop emits `plan_emitted` bus events at each phase and a
 * `research_brief_emitted` event on completion, so the Mission Control
 * journal can show it ticking through.
 *
 * Security:
 *   - API key read from opts.apiKey or ANTHROPIC_API_KEY; never logged.
 *   - Fetch errors redacted through {@link redactReason} before surfacing.
 *   - Each Haiku call has its own 8s timeout; the whole run is bounded by
 *     `timeBudgetMs` via a single outer AbortController so a hung API call
 *     can't burn past budget.
 *
 * Failure mode:
 *   - If Haiku returns malformed JSON or a zod mismatch, or if any phase
 *     aborts on budget, we return a Brief marked `recommended_action:
 *     'research-failed'` with `confidence: 0.0` and a synthetic "loop
 *     failed" hypothesis. Documented in docs/phase-2.5/DECISIONS.md. We
 *     do NOT throw — the MCP tool contract promises a Brief.
 */
import { z } from "zod";
import {
  type Brief,
  BriefSchema,
  type Hypothesis,
  HypothesisVerdictSchema,
  parseBrief,
  type ResearchPhase,
} from "./brief-schema.js";
import {
  DEFAULT_EXECUTORS,
  echoExecutor,
  type ProbeExecutor,
} from "./probe-executors.js";
import type { AgentEvent, EventBus } from "../ipc/event-bus.js";

// --------------------------- Public types ---------------------------------

export type ResearchDepth = "normal" | "deep";

export interface ResearchOptions {
  /** `normal` = 3 hypotheses × 1 probe × 2min; `deep` = 5 × 2 × 5min. */
  depth?: ResearchDepth;
  /** Override max hypotheses. Defaults follow depth. */
  maxHypotheses?: number;
  /** Override max probes per hypothesis. Defaults follow depth. */
  maxProbes?: number;
  /** Overall wall-clock budget in ms. Defaults follow depth. */
  timeBudgetMs?: number;
  /** Anthropic API key. Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Event bus for phase + brief emission. No-op when undefined. */
  bus?: EventBus;
  /** Custom probe executor chain. Falls back to DEFAULT_EXECUTORS. */
  probeExecutors?: ReadonlyArray<ProbeExecutor>;
  /** Wall clock, injectable for tests. */
  now?: () => Date;
  /**
   * Task id that triggered this research — forwarded so trace events can
   * be correlated back to the originating task. Ignored by the loop
   * itself; reserved for future `research_brief_emitted.task_id` wiring.
   */
  task_id?: string;
}

// --------------------------- Defaults --------------------------------------

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const PER_CALL_TIMEOUT_MS = 8_000;

interface DepthDefaults {
  maxHypotheses: number;
  maxProbes: number;
  timeBudgetMs: number;
}

const DEPTH_DEFAULTS: Record<ResearchDepth, DepthDefaults> = {
  normal: { maxHypotheses: 3, maxProbes: 1, timeBudgetMs: 120_000 },
  deep: { maxHypotheses: 5, maxProbes: 2, timeBudgetMs: 300_000 },
};

// --------------------------- Error redaction ------------------------------

const SAFE_REASON_PATTERNS: ReadonlyArray<{ match: RegExp; label: string }> = [
  { match: /abort|timeout|deadline/i, label: "timeout" },
  { match: /429|rate.?limit/i, label: "rate-limited" },
  { match: /\b(5\d\d)\b/, label: "server-error" },
  { match: /\b(4\d\d)\b/, label: "client-error" },
  { match: /invalid.*json|unexpected token|parse/i, label: "parse-error" },
  { match: /schema|zod|invalid response/i, label: "schema-mismatch" },
  { match: /econn|enotfound|network|fetch/i, label: "network" },
  { match: /budget|time.?budget/i, label: "budget-exceeded" },
];

function redactReason(reason: string): string {
  for (const { match, label } of SAFE_REASON_PATTERNS) {
    if (match.test(reason)) return label;
  }
  return "unknown";
}

// --------------------------- Haiku JSON schemas ---------------------------

const HypothesisSeedSchema = z.object({
  h: z.string().min(1),
  prior: z.number().min(0).max(1),
  probe: z.string().min(1),
});

const HypothesisSeedsSchema = z.object({
  hypotheses: z.array(HypothesisSeedSchema).min(1),
});

const ScoreSchema = z.object({
  id: z.string().min(1),
  likelihood: z.number().min(0).max(1),
  verdict: HypothesisVerdictSchema,
});

const ScoresSchema = z.object({
  scores: z.array(ScoreSchema).min(1),
});

// Consolidation step returns a partial Brief; we post-process then
// validate against the full BriefSchema before returning.
const BriefDraftSchema = z.object({
  winning: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  recommended_action: z.string().min(1),
});

// --------------------------- Prompts --------------------------------------

function hypothesizePrompt(question: string, maxHypotheses: number): string {
  return (
    `You are a research hypothesizer. Given a question, emit between 1 and ` +
    `${maxHypotheses} distinct, mutually-contrasting hypotheses. For each, ` +
    `write a prior probability in [0,1] reflecting how likely it is a priori ` +
    `and a probe: the single smallest experiment that would confirm or falsify ` +
    `it (natural language, no markdown).\n\n` +
    `Return STRICT JSON: {"hypotheses":[{"h":"...","prior":0.3,"probe":"..."}]}.` +
    `\n\nQuestion: ${question}`
  );
}

function scorePrompt(question: string, triples: ScoreTriple[]): string {
  const lines = triples
    .map(
      (t, i) =>
        `${i + 1}. id="${t.id}" hypothesis=${JSON.stringify(t.h)} ` +
        `probe=${JSON.stringify(t.probe)} ` +
        `result=${JSON.stringify(t.result)}`,
    )
    .join("\n");
  return (
    `You are a Bayesian belief updater. For each (hypothesis, probe, result) ` +
    `triple, score the likelihood the result supports the hypothesis in [0,1] ` +
    `and assign a verdict: "confirmed" if likelihood >= 0.7, "falsified" if ` +
    `<= 0.3, else "inconclusive". Keep id exactly as given.\n\n` +
    `Return STRICT JSON: {"scores":[{"id":"...","likelihood":0.7,"verdict":"confirmed"}]}.` +
    `\n\nQuestion: ${question}\nTriples:\n${lines}`
  );
}

function briefPrompt(
  question: string,
  hypotheses: Hypothesis[],
  winning: string | undefined,
): string {
  const summary = hypotheses
    .map(
      (h, i) =>
        `${i + 1}. "${h.h}" prior=${h.prior} posterior=${h.posterior ?? 0} ` +
        `verdict=${h.verdict} probe=${JSON.stringify(h.probe)} ` +
        `result=${JSON.stringify(h.result ?? "")}`,
    )
    .join("\n");
  return (
    `You are a research consolidator. Given the question and the scored ` +
    `hypotheses, emit a brief.\n\n` +
    `Rules:\n` +
    ` - "winning" must be the exact text of the winning hypothesis (provided), or omit if none.\n` +
    ` - "evidence" lists concrete pointers (URLs, file paths, probe quotes) from the results.\n` +
    ` - "open_questions" are gaps the probes did not resolve.\n` +
    ` - "recommended_action" is one actionable sentence.\n\n` +
    `Return STRICT JSON: {"winning":"...","evidence":["..."],"open_questions":["..."],"recommended_action":"..."}.` +
    `\n\nQuestion: ${question}\nWinning hypothesis: ${winning ?? "(none)"}\n` +
    `Hypotheses:\n${summary}`
  );
}

// --------------------------- Haiku call helper ----------------------------

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

interface HaikuCallDeps {
  apiKey: string | undefined;
  fetchImpl: typeof fetch;
  outerSignal: AbortSignal;
}

async function callHaikuJson<T>(
  deps: HaikuCallDeps,
  userPrompt: string,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!deps.apiKey) {
    throw new Error("missing ANTHROPIC_API_KEY");
  }
  if (deps.outerSignal.aborted) {
    throw new Error("budget-exceeded");
  }

  const perCall = new AbortController();
  const timer = setTimeout(() => perCall.abort(), PER_CALL_TIMEOUT_MS);
  const onOuterAbort = () => perCall.abort();
  deps.outerSignal.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const res = await deps.fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      signal: perCall.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": deps.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`haiku http ${res.status}`);
    }

    const body = (await res.json()) as AnthropicMessagesResponse;
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    const json = extractJson(text);
    if (!json) throw new Error("no JSON block in haiku response");
    return schema.parse(JSON.parse(json));
  } finally {
    clearTimeout(timer);
    deps.outerSignal.removeEventListener("abort", onOuterAbort);
  }
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

// --------------------------- Internal state -------------------------------

interface ScoreTriple {
  id: string;
  h: string;
  probe: string;
  result: string;
}

// --------------------------- Loop -----------------------------------------

/**
 * Run the H→P→R→B loop against one question.
 *
 * Always resolves with a Brief. On failure (bad Haiku output, budget
 * exceeded, etc.) the Brief is marked `recommended_action: 'research-failed'`
 * with `confidence: 0.0` and a single synthetic "loop failed" hypothesis.
 */
export async function runResearch(
  question: string,
  opts: ResearchOptions = {},
): Promise<Brief> {
  const depth: ResearchDepth = opts.depth ?? "normal";
  const defaults = DEPTH_DEFAULTS[depth];
  const maxHypotheses = opts.maxHypotheses ?? defaults.maxHypotheses;
  const maxProbes = opts.maxProbes ?? defaults.maxProbes;
  const timeBudgetMs = opts.timeBudgetMs ?? defaults.timeBudgetMs;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const bus = opts.bus;
  const taskId = opts.task_id;
  const executors = opts.probeExecutors ?? DEFAULT_EXECUTORS;
  const now = opts.now ?? (() => new Date());
  const startedAt = now();

  const outer = new AbortController();
  const budgetTimer = setTimeout(() => outer.abort(), timeBudgetMs);
  const haikuDeps: HaikuCallDeps = {
    apiKey,
    fetchImpl,
    outerSignal: outer.signal,
  };

  const emit = (phase: ResearchPhase, extra?: object) => {
    if (!bus) return;
    const event: AgentEvent = {
      kind: "plan_emitted",
      payload: { phase, ...(extra ?? {}) },
      ts: now(),
    };
    bus.emit(event);
  };

  const failBrief = (reason: string): Brief => {
    const label = redactReason(reason);
    const brief: Brief = {
      question,
      hypotheses: [
        {
          h: "loop failed before producing a brief",
          prior: 0,
          probe: "n/a",
          verdict: "inconclusive",
        },
      ],
      evidence: [],
      open_questions: [question],
      recommended_action: "research-failed",
      confidence: 0,
      cost_seconds: elapsedSeconds(startedAt, now()),
    };
    if (bus) {
      bus.emit({
        kind: "research_brief_emitted",
        task_id: taskId,
        payload: {
          question,
          winning: undefined,
          confidence: 0,
          reason: label,
        },
        ts: now(),
      });
    }
    return brief;
  };

  try {
    // ----- 1. HYPOTHESIZE -------------------------------------------------
    emit("HYPOTHESIZE", { maxHypotheses });
    const seeds = await callHaikuJson(
      haikuDeps,
      hypothesizePrompt(question, maxHypotheses),
      HypothesisSeedsSchema,
    );

    // Respect the cap; "deep" allows up to 5, "normal" up to 3.
    const trimmed = seeds.hypotheses.slice(0, maxHypotheses);
    const hypotheses: Hypothesis[] = trimmed.map((s) => ({
      h: s.h,
      prior: s.prior,
      probe: s.probe,
      verdict: "inconclusive",
    }));

    // ----- 2. EXECUTE_PROBES ---------------------------------------------
    // maxProbes applies per-hypothesis; Phase 2.5 only models one probe per
    // hypothesis in the seed (plan §2.3 treats probes as 1:1 with hypotheses
    // during design). The `maxProbes > 1` case is reserved for deep-mode
    // replays in Phase 3 — for now we just note the cap in telemetry.
    emit("EXECUTE_PROBES", { count: hypotheses.length, maxProbes });
    await Promise.all(
      hypotheses.map(async (h) => {
        if (outer.signal.aborted) return;
        const chosen =
          executors.find((ex) => ex.canRun(h.probe)) ?? echoExecutor;
        h.result = await chosen.run(h.probe);
      }),
    );

    if (outer.signal.aborted) {
      throw new Error("budget-exceeded");
    }

    // ----- 3. UPDATE_BELIEFS ---------------------------------------------
    emit("UPDATE_BELIEFS");
    const triples: ScoreTriple[] = hypotheses.map((h, i) => ({
      id: `h${i + 1}`,
      h: h.h,
      probe: h.probe,
      result: h.result ?? "",
    }));
    const scoreResp = await callHaikuJson(
      haikuDeps,
      scorePrompt(question, triples),
      ScoresSchema,
    );

    // Map scores back to hypotheses by id; unmatched entries keep prior=0.
    const scoreById = new Map(scoreResp.scores.map((s) => [s.id, s]));
    const posteriors = hypotheses.map((h, i) => {
      const score = scoreById.get(`h${i + 1}`);
      if (!score) return 0;
      return h.prior * score.likelihood;
    });
    const sum = posteriors.reduce((a, b) => a + b, 0);
    for (let i = 0; i < hypotheses.length; i++) {
      const h = hypotheses[i]!;
      const score = scoreById.get(`h${i + 1}`);
      // Normalize so posteriors form a distribution; fall back to 0 when all
      // likelihoods are zero (total failure signal).
      h.posterior = sum > 0 ? posteriors[i]! / sum : 0;
      if (score) h.verdict = score.verdict;
    }

    // Winner: argmax posterior, tiebreak confirmed > inconclusive > falsified.
    const winner = pickWinner(hypotheses);

    // ----- 4. BRIEF -------------------------------------------------------
    emit("BRIEF");
    const draft = await callHaikuJson(
      haikuDeps,
      briefPrompt(question, hypotheses, winner?.h),
      BriefDraftSchema,
    );

    const confidence = winner?.posterior ?? 0;
    const brief = parseBrief({
      question,
      hypotheses,
      winning: winner?.h,
      evidence: draft.evidence,
      open_questions: draft.open_questions,
      recommended_action: draft.recommended_action,
      confidence,
      cost_seconds: elapsedSeconds(startedAt, now()),
    } satisfies Brief);

    if (bus) {
      bus.emit({
        kind: "research_brief_emitted",
        task_id: taskId,
        payload: {
          question,
          winning: brief.winning,
          confidence: brief.confidence,
        },
        ts: now(),
      });
    }
    return brief;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Validate against BriefSchema to ensure the fallback shape is legal —
    // any drift in the fallback becomes a typechecker or zod failure at
    // dev time instead of a silent contract break.
    const fallback = failBrief(reason);
    return BriefSchema.parse(fallback);
  } finally {
    clearTimeout(budgetTimer);
  }
}

// --------------------------- Helpers --------------------------------------

function pickWinner(hypotheses: Hypothesis[]): Hypothesis | undefined {
  if (hypotheses.length === 0) return undefined;
  const verdictRank: Record<Hypothesis["verdict"], number> = {
    confirmed: 2,
    inconclusive: 1,
    falsified: 0,
  };
  return [...hypotheses].sort((a, b) => {
    const pa = a.posterior ?? 0;
    const pb = b.posterior ?? 0;
    if (pb !== pa) return pb - pa;
    return verdictRank[b.verdict] - verdictRank[a.verdict];
  })[0];
}

function elapsedSeconds(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / 1000);
}
