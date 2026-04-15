/**
 * Shared types for the Autonomy Loop (Nchinda §2).
 *
 * The loop is the outer shell that wraps the orchestrator:
 *
 *   RECALL → PLAN → ATTEMPT → OBSERVE → ADAPT → REPORT
 *
 * On failure it walks the Resourcefulness ladder (§2.1) and escalates via
 * the rules in §2.2.
 */
import type { Plan } from "../orchestrator/plan-schema.js";
import type { ClassificationResult } from "../classifier/classifier.js";

// ─── Classifier contract (canonical home: `src/classifier/classifier.ts`) ───
// Re-exported from the classifier module so the loop and the classifier agree
// on a single definition. Prior to the Phase-2 integration merge this block
// was a verbatim duplicate per DECISIONS.md §D6; it is now consolidated to
// the canonical source to eliminate any possibility of drift.
export type {
  Classifier,
  ClassificationResult,
  ClassifierContext,
  ClassifyOptions,
  TaskComplexity,
} from "../classifier/classifier.js";

/** Every state the loop transitions through. Plan §2 diagram. */
export type LoopState =
  | "RECALL"
  | "PLAN"
  | "ATTEMPT"
  | "OBSERVE"
  | "ADAPT"
  | "REPORT"
  | "ESCALATE"
  | "DONE"
  | "FAILED";

/**
 * Context the loop hands to a FallbackStrategy so it can decide whether it
 * knows how to recover from a given failure, and — if so — how to mutate the
 * plan or task before the next attempt.
 */
export interface FallbackContext {
  task: string;
  taskId: string;
  attempt: number;
  lastError: Error;
  lastPlan?: Plan;
  classification?: ClassificationResult;
}

/**
 * One rung on the Resourcefulness ladder (§2.1). The loop walks strategies
 * in order; the first one whose `canHandle` returns true gets to execute.
 */
export interface FallbackStrategy {
  /** Stable name — shows up in events + logs. */
  readonly name: string;
  /** Ladder rung, 1..7 per §2.1. */
  readonly rung: number;
  canHandle(ctx: FallbackContext): boolean | Promise<boolean>;
  apply(ctx: FallbackContext): Promise<FallbackOutcome>;
}

export interface FallbackOutcome {
  handled: boolean;
  /** Updated task description (scope reduction, retry with different phrasing). */
  nextTask?: string;
  /** A pre-built Plan to execute directly on the next ATTEMPT. */
  nextPlan?: Plan;
  /** Human-readable note persisted to `loop_attempts`. */
  note?: string;
}

/** Why the loop decided to hand off to a human. §2.2 */
export type EscalationReason =
  | "three-strike"
  | "irreversible-action"
  | "credential-touch"
  | "budget-blown"
  | "ladder-exhausted";

export interface EscalationDecision {
  escalate: boolean;
  reason?: EscalationReason;
  detail?: string;
}

export interface AttemptRecord {
  attempt: number;
  state: LoopState;
  rung?: number;
  strategy?: string;
  error?: string;
  note?: string;
  startedAt: Date;
  endedAt: Date;
}

/**
 * Outcome descriptor — derived from `state` + attempt history.
 *
 *   "done"       — completed on the first ATTEMPT (no fallback needed)
 *   "recovered"  — completed AFTER at least one ADAPT (the Phase 2 DoD case)
 *   "failed"     — terminated without escalation (reserved for future use)
 *   "escalated"  — handed off to the user per policy
 */
export type LoopOutcome = "done" | "recovered" | "failed" | "escalated";

export interface LoopResult {
  task: string;
  taskId: string;
  state: "DONE" | "FAILED" | "ESCALATED";
  /** Derived descriptor — see LoopOutcome. Populated by the loop on finalize. */
  outcome: LoopOutcome;
  attempts: AttemptRecord[];
  escalation?: EscalationDecision;
  finalError?: string;
  classification?: ClassificationResult;
}

/** Budget tracked by the Policy engine. Numeric units are caller-defined. */
export interface LoopBudget {
  maxAttempts: number;
  maxTokens?: number;
  maxSeconds?: number;
}

export interface SpentBudget {
  attempts: number;
  tokens?: number;
  seconds?: number;
}
