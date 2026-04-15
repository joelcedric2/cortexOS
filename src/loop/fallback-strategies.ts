/**
 * Built-in FallbackStrategies — the first 3 rungs of the Resourcefulness
 * ladder (Nchinda §2.1). Rungs 4–7 ship in Phase 3 when the `nchinda_*`
 * MCP tool suite (`ask_peer`, `recall`, `web_search`, `escalate`) lands.
 *
 * Each strategy is a thin, testable object — no LLM calls, no hidden state.
 * The AutonomyLoop composes them in rung order.
 */
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
    // Fires when the primary orchestrator pipeline threw (not a transient err).
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
    // Always applies as a last-resort-before-escalation rung.
    return true;
  }

  async apply(ctx: FallbackContext): Promise<FallbackOutcome> {
    const nextTask =
      `Focus on the smallest useful slice of the following task, ignore everything else: ` +
      ctx.task;
    return {
      handled: true,
      nextTask,
      // Drop the plan so the loop re-plans against the narrower task.
      nextPlan: undefined,
      note: "rung3: reduced scope to smallest useful slice",
    };
  }
}

/** Default ladder the AutonomyLoop composes when no override is given. */
export function defaultStrategies(): FallbackStrategy[] {
  return [
    new RetrySameStrategy(),
    new AlternateToolStrategy(),
    new ReduceScopeStrategy(),
  ];
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
