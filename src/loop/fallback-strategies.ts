/**
 * Built-in FallbackStrategies — all 7 rungs of the Resourcefulness ladder
 * (Nchinda §2.1).
 *
 * Rungs 1–3 (retry-same, alternate-tool, reduce-scope) are pure transforms
 * over the FallbackContext. Rungs 4–7 (ask-peer, recall-memory, web-search,
 * escalate) cooperate with external tools and therefore accept a deps bag
 * so they stay testable in isolation.
 *
 * The AutonomyLoop composes strategies in ascending rung order; the first
 * whose `canHandle` returns true wins.
 */
import type {
  AgentRecord,
} from "../registry/agent-registry.js";
import type {
  AskPeerResult,
  EscalateResult,
} from "../mcp/nchinda-coordination.js";
import type { RecallHit } from "../mcp/nchinda-tools.js";
import type { SearchResult, WebSearchOptions } from "../tools/web-search.js";
import type {
  FallbackContext,
  FallbackOutcome,
  FallbackStrategy,
} from "./types.js";

/**
 * Rung 1 — Retry with the same tool, unchanged parameters.
 *
 * Fires only on classic transient errors (timeouts, rate limits, connection
 * resets). The loop simply re-enters ATTEMPT with the existing plan.
 */
export class RetrySameStrategy implements FallbackStrategy {
  readonly name = "retry-same";
  readonly rung = 1;

  canHandle(ctx: FallbackContext): boolean {
    return isTransient(ctx.lastError.message);
  }

  async apply(_ctx: FallbackContext): Promise<FallbackOutcome> {
    return { handled: true, note: "rung1: retrying unchanged" };
  }
}

/**
 * Rung 2 — Switch to an alternate tool for the same capability.
 *
 * Phase 2 can only express "drop to single-shot" as the alternate strategy
 * (no tool registry yet). We mark handled and let the loop reuse the
 * existing plan. The richer implementation (actually swapping tools)
 * arrives in Phase 3.
 */
export class AlternateToolStrategy implements FallbackStrategy {
  readonly name = "alternate-tool";
  readonly rung = 2;

  canHandle(ctx: FallbackContext): boolean {
    return !isTransient(ctx.lastError.message) && ctx.lastPlan !== undefined;
  }

  async apply(ctx: FallbackContext): Promise<FallbackOutcome> {
    return {
      handled: true,
      note: `rung2: alternate tool not wired until Phase 3; retrying primary (plan=${ctx.lastPlan?.agents.length ?? 0} agents)`,
    };
  }
}

/**
 * Rung 3 — Reduce scope to a narrower task.
 *
 * Produces a new `nextTask` — the existing task prefixed with a scope
 * instruction. Also invalidates any cached Plan so the next ATTEMPT re-plans
 * against the narrower intent (or delegates to planFactory).
 */
export class ReduceScopeStrategy implements FallbackStrategy {
  readonly name = "reduce-scope";
  readonly rung = 3;

  canHandle(_ctx: FallbackContext): boolean {
    return true;
  }

  async apply(ctx: FallbackContext): Promise<FallbackOutcome> {
    const nextTask =
      `Focus on the smallest useful slice of the following task, ignore everything else: ` +
      ctx.task;
    return {
      handled: true,
      nextTask,
      nextPlan: undefined,
      note: "rung3: reduced scope to smallest useful slice",
    };
  }
}

// ─── Rung 4 — ask-peer ────────────────────────────────────────────────────

export interface AskPeerDeps {
  /** Lists currently-spawned agents so canHandle() can look for a designer. */
  listAgents: () => AgentRecord[];
  /** Invoke the `nchinda_ask_peer` handler. */
  askPeer: (input: { role: string; question: string; timeout_s?: number }) =>
    Promise<AskPeerResult>;
  /** Role identifier for the System Designer. Default "system-designer". */
  designerRole?: string;
}

/**
 * Rung 4 — Ask a peer (the System Designer by default) for guidance. Fires
 * only when a designer agent is actually alive in the registry so we don't
 * block the loop waiting for a reply that will never arrive.
 */
export class AskPeerStrategy implements FallbackStrategy {
  readonly name = "ask-peer";
  readonly rung = 4;
  private readonly designerRole: string;

  constructor(private readonly deps: AskPeerDeps) {
    this.designerRole = deps.designerRole ?? "system-designer";
  }

  canHandle(_ctx: FallbackContext): boolean {
    try {
      return this.deps
        .listAgents()
        .some(
          (a) => a.role === this.designerRole && a.status === "running",
        );
    } catch {
      return false;
    }
  }

  async apply(ctx: FallbackContext): Promise<FallbackOutcome> {
    const question =
      `Executor reported: "${ctx.lastError.message}". ` +
      `Task was: "${ctx.task}". How should I proceed?`;
    try {
      const reply = await this.deps.askPeer({
        role: this.designerRole,
        question,
        timeout_s: 60,
      });
      if (reply.ok) {
        return {
          handled: true,
          nextTask: `${ctx.task} — additional guidance from designer: ${reply.answer}`,
          nextPlan: undefined,
          note: `rung4: designer replied (correlation=${reply.correlation_id})`,
        };
      }
      return {
        handled: false,
        note: `rung4: ask-peer failed (${reply.reason})`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { handled: false, note: `rung4: askPeer threw: ${message}` };
    }
  }
}

// ─── Rung 5 — recall-memory ───────────────────────────────────────────────

export interface RecallMemoryDeps {
  /** Invoke the `nchinda_recall` handler. */
  recall: (input: {
    query: string;
    k?: number;
    filter?: { agent_role?: string; task_type?: string };
  }) => Promise<RecallHit[]>;
  /** Minimum similarity score for a recall hit to be considered useful. */
  minSimilarity?: number;
}

/**
 * Rung 5 — Recall past successes against the failure signature. If a
 * similar prior task succeeded, attach its content as a hint so the next
 * attempt can learn from the earlier resolution.
 */
export class RecallMemoryStrategy implements FallbackStrategy {
  readonly name = "recall-memory";
  readonly rung = 5;
  private readonly minSimilarity: number;

  constructor(private readonly deps: RecallMemoryDeps) {
    this.minSimilarity = deps.minSimilarity ?? 0.5;
  }

  canHandle(_ctx: FallbackContext): boolean {
    // Always eligible when the recall handler is wired — the apply()
    // method decides handled:false if no useful hits come back.
    return typeof this.deps.recall === "function";
  }

  async apply(ctx: FallbackContext): Promise<FallbackOutcome> {
    const query = buildFailureSignature(ctx);
    let hits: RecallHit[];
    try {
      hits = await this.deps.recall({ query, k: 5 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { handled: false, note: `rung5: recall threw: ${message}` };
    }

    const useful = hits
      .filter((h) => h.outcome === "success")
      .filter((h) => h.similarity >= this.minSimilarity);
    if (useful.length === 0) {
      return { handled: false, note: "rung5: no similar success memory" };
    }
    const best = useful[0];
    return {
      handled: true,
      nextTask: `${ctx.task} — hint from memory: ${best.content}`,
      nextPlan: undefined,
      note: `rung5: memory hint (sim=${best.similarity.toFixed(2)}, tags=${best.tags.join("|")})`,
    };
  }
}

// ─── Rung 6 — web-search ──────────────────────────────────────────────────

export interface WebSearchDeps {
  /** Invoke the generic web-search utility. */
  webSearch: (query: string, opts?: WebSearchOptions) => Promise<SearchResult[]>;
  /** Max chars of the top snippet to inline into the next task. */
  maxSnippetChars?: number;
}

/**
 * Rung 6 — Search the web for the error class + task keywords. If the
 * adapter returns ≥1 result we attach the top snippet so the next attempt
 * can incorporate public knowledge (Stack Overflow answers, release notes).
 */
export class WebSearchStrategy implements FallbackStrategy {
  readonly name = "web-search";
  readonly rung = 6;
  private readonly maxSnippetChars: number;

  constructor(private readonly deps: WebSearchDeps) {
    this.maxSnippetChars = deps.maxSnippetChars ?? 400;
  }

  canHandle(_ctx: FallbackContext): boolean {
    return typeof this.deps.webSearch === "function";
  }

  async apply(ctx: FallbackContext): Promise<FallbackOutcome> {
    const query = buildFailureSignature(ctx);
    let results: SearchResult[];
    try {
      results = await this.deps.webSearch(query, { limit: 3 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { handled: false, note: `rung6: webSearch threw: ${message}` };
    }
    if (results.length === 0) {
      return { handled: false, note: "rung6: no web results" };
    }
    const top = results[0];
    const snippet = top.snippet.slice(0, this.maxSnippetChars);
    return {
      handled: true,
      nextTask:
        `${ctx.task} — web hint (${top.url}): ${snippet}`,
      nextPlan: undefined,
      note: `rung6: web hint from ${top.url}`,
    };
  }
}

// ─── Rung 7 — escalate (terminal) ─────────────────────────────────────────

export interface EscalateDeps {
  /** Invoke the `nchinda_escalate` handler. */
  escalate: (input: {
    question: string;
    level?: "info" | "question" | "blocker" | "ask";
    task_id?: string;
    agent_id?: string;
  }) => EscalateResult | Promise<EscalateResult>;
  /**
   * Flag setter the loop's Policy reads on next iteration. When set, the
   * Policy should short-circuit into ESCALATE. The caller owns the flag
   * storage (e.g. a closure variable checked inside a custom Policy).
   */
  markEscalated?: (escalationId: string, detail: string) => void;
}

/**
 * Rung 7 — Last resort. Always handles; always returns `{handled: true}`
 * with the original task preserved, but flags the escalation so the loop
 * sees it on the next iteration and short-circuits. The Policy engine
 * then surfaces this as a `ladder-exhausted`-style escalation.
 */
export class EscalateStrategy implements FallbackStrategy {
  readonly name = "escalate";
  readonly rung = 7;

  constructor(private readonly deps: EscalateDeps) {}

  canHandle(_ctx: FallbackContext): boolean {
    return true;
  }

  async apply(ctx: FallbackContext): Promise<FallbackOutcome> {
    const question =
      `Executor hit an unrecoverable error on task "${ctx.task}" ` +
      `(attempt ${ctx.attempt}): ${ctx.lastError.message}. ` +
      `Ladder exhausted — requesting human guidance.`;
    let escalationId = "(unknown)";
    try {
      const result = await this.deps.escalate({
        question,
        level: "blocker",
        task_id: ctx.taskId,
      });
      escalationId = result.escalation_id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        handled: true,
        nextTask: ctx.task,
        note: `rung7: escalate threw: ${message}; flagging anyway`,
      };
    }
    this.deps.markEscalated?.(escalationId, question);
    return {
      handled: true,
      nextTask: ctx.task,
      note: `rung7: escalation raised (id=${escalationId})`,
    };
  }
}

// ─── Factories & helpers ─────────────────────────────────────────────────

export interface LadderDeps {
  askPeer?: AskPeerDeps;
  recallMemory?: RecallMemoryDeps;
  webSearch?: WebSearchDeps;
  escalate?: EscalateDeps;
}

/**
 * Default ladder the AutonomyLoop composes when no override is given.
 *
 * With no deps supplied: rungs 1–3 (the pure transforms). Passing a
 * populated `LadderDeps` lights up the corresponding rungs 4–7. This way
 * the factory gracefully degrades to the Phase-2 behavior whenever the
 * nchinda / web-search wiring isn't available yet.
 */
export function defaultLadderStrategies(
  deps: LadderDeps = {},
): FallbackStrategy[] {
  const out: FallbackStrategy[] = [
    new RetrySameStrategy(),
    new AlternateToolStrategy(),
    new ReduceScopeStrategy(),
  ];
  if (deps.askPeer) out.push(new AskPeerStrategy(deps.askPeer));
  if (deps.recallMemory) out.push(new RecallMemoryStrategy(deps.recallMemory));
  if (deps.webSearch) out.push(new WebSearchStrategy(deps.webSearch));
  if (deps.escalate) out.push(new EscalateStrategy(deps.escalate));
  return out;
}

/** @deprecated Use `defaultLadderStrategies()` — rungs 1–3 only by default. */
export function defaultStrategies(): FallbackStrategy[] {
  return defaultLadderStrategies();
}

const TRANSIENT_MARKERS = [
  /timeout/i,
  /timed\s*out/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /rate[\s-]*limit/i,
  /429\b/,
  /503\b/,
  /temporarily/i,
];

function isTransient(message: string): boolean {
  if (!message) return false;
  return TRANSIENT_MARKERS.some((re) => re.test(message));
}

/**
 * Build a compact string signature of a failure for retrieval / search.
 * Shapes: `<error class>: <task excerpt>`. Error class is the first word
 * of the error message (e.g. "TypeError", "Error"), or the constructor
 * name if available. Task is truncated to keep the query tight.
 */
function buildFailureSignature(ctx: FallbackContext): string {
  const errName = ctx.lastError.name || "Error";
  const errMsg = ctx.lastError.message || "";
  const firstMsgWord = errMsg.split(/\s+/)[0] || "";
  const errClass = firstMsgWord.replace(/[:;,]+$/, "") || errName;
  const taskExcerpt = ctx.task.length > 200 ? ctx.task.slice(0, 200) : ctx.task;
  return `${errClass}: ${taskExcerpt}`;
}
