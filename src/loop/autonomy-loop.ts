/**
 * AutonomyLoop — Nchinda §2 "the heart of the system".
 *
 *   RECALL → PLAN → ATTEMPT → OBSERVE → ADAPT → REPORT
 *
 * Wraps the existing Orchestrator without refactoring it. On failure it walks
 * the Resourcefulness ladder (§2.1) via pluggable FallbackStrategy objects and
 * escalates per the Policy engine (§2.2).
 *
 * This class is intentionally thin:
 *  - No direct tmux / claude-cli knowledge (Orchestrator owns that).
 *  - No direct SQLite writes except `loop_attempts` (via LoopAttemptLog).
 *  - All observable side-effects flow through the EventBus.
 */
import { randomUUID } from "node:crypto";
import type { Orchestrator, OrchestratorResult } from "../orchestrator/orchestrator.js";
import type { AgentRegistry } from "../registry/agent-registry.js";
import type { EventBus } from "../ipc/event-bus.js";
import type { Plan } from "../orchestrator/plan-schema.js";
import type { Policy } from "./policy.js";
import type { LoopAttemptLog } from "./loop-attempts-db.js";
import type {
  AttemptRecord,
  ClassificationResult,
  Classifier,
  EscalationDecision,
  FallbackContext,
  FallbackStrategy,
  LoopBudget,
  LoopOutcome,
  LoopResult,
  LoopState,
  SpentBudget,
} from "./types.js";

export interface AutonomyLoopDeps {
  orchestrator: Orchestrator;
  registry: AgentRegistry;
  bus: EventBus;
  policy: Policy;
  classifier: Classifier;
  /** Optional attempts log. If omitted, loop still runs — just without persistence. */
  attemptsLog?: LoopAttemptLog;
  /** Strategies walk in ascending `rung` order — caller decides composition. */
  strategies?: FallbackStrategy[];
  /** Budget applied per invocation of `execute`. Default: 3 attempts. */
  budget?: LoopBudget;
  /**
   * Escape hatch for tests: build a Plan directly instead of driving the
   * real Designer. If omitted, the loop defers to `orchestrator.execute(task)`
   * which owns its own Designer flow.
   */
  planFactory?: (task: string, taskId: string) => Promise<Plan>;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

export interface LoopExecuteCtx {
  task_id?: string;
}

const DEFAULT_BUDGET: LoopBudget = { maxAttempts: 3 };

export class AutonomyLoop {
  private readonly orchestrator: Orchestrator;
  private readonly registry: AgentRegistry;
  private readonly bus: EventBus;
  private readonly policy: Policy;
  private readonly classifier: Classifier;
  private readonly attemptsLog?: LoopAttemptLog;
  private readonly strategies: FallbackStrategy[];
  private readonly budget: LoopBudget;
  private readonly planFactory?: (task: string, taskId: string) => Promise<Plan>;
  private readonly now: () => Date;

  constructor(deps: AutonomyLoopDeps) {
    this.orchestrator = deps.orchestrator;
    this.registry = deps.registry;
    this.bus = deps.bus;
    this.policy = deps.policy;
    this.classifier = deps.classifier;
    this.attemptsLog = deps.attemptsLog;
    this.strategies = [...(deps.strategies ?? [])].sort((a, b) => a.rung - b.rung);
    this.budget = deps.budget ?? DEFAULT_BUDGET;
    this.planFactory = deps.planFactory;
    this.now = deps.now ?? (() => new Date());
    // Registry is retained for future rung-4 "ask_peer" queries.
    void this.registry;
  }

  /**
   * Drive a task through the autonomy loop. Runs at most `budget.maxAttempts`
   * iterations, walking the fallback ladder between failed attempts. Always
   * returns a `LoopResult` — never throws — so callers can `await` deterministically.
   */
  async execute(task: string, ctx: LoopExecuteCtx = {}): Promise<LoopResult> {
    const taskId = ctx.task_id ?? randomUUID();
    const attempts: AttemptRecord[] = [];
    const spent: SpentBudget = { attempts: 0 };

    let currentTask = task;
    let currentPlan: Plan | undefined;
    let classification: ClassificationResult | undefined;
    let lastError: Error | undefined;

    // ── RECALL ────────────────────────────────────────────────────────────
    this.emitState("RECALL", taskId, 0);
    // Phase 2: RECALL is a no-op placeholder until `nchinda_recall` lands
    // in Phase 3. We still emit the transition so downstream telemetry sees it.

    // ── PLAN (classification + initial Plan) ──────────────────────────────
    this.emitState("PLAN", taskId, 0);
    try {
      classification = await this.classifier.classify(currentTask);
    } catch (err) {
      // Classification failure is non-fatal — the ladder may still recover.
      lastError = toError(err);
    }

    // Main attempt loop. Each iteration: ATTEMPT → OBSERVE → (ADAPT|REPORT).
    for (let attempt = 1; attempt <= this.budget.maxAttempts; attempt++) {
      spent.attempts = attempt;

      // §2.2: budget check BEFORE the attempt burns resources.
      if (!this.policy.withinBudget(spent, this.budget)) {
        const decision: EscalationDecision = {
          escalate: true,
          reason: "budget-blown",
          detail: `attempts=${spent.attempts} exceeds max=${this.budget.maxAttempts}`,
        };
        return this.finalize({ task, taskId, attempts, state: "ESCALATED", escalation: decision, classification, finalError: lastError?.message });
      }

      // §2.2: irreversible-action gate. The task string itself is scanned so
      // a user saying "rm -rf /" never runs autonomously even on attempt 1.
      if (this.policy.isIrreversible(currentTask)) {
        const decision: EscalationDecision = {
          escalate: true,
          reason: "irreversible-action",
          detail: `task contains an irreversible action pattern`,
        };
        return this.finalize({ task, taskId, attempts, state: "ESCALATED", escalation: decision, classification });
      }

      // ── ATTEMPT ─────────────────────────────────────────────────────────
      this.emitState("ATTEMPT", taskId, attempt);
      const startedAt = this.now();
      let outcome: OrchestratorResult | null = null;
      let attemptError: Error | undefined;

      try {
        if (currentPlan) {
          outcome = await this.orchestrator.executeOnce(currentPlan, taskId);
        } else if (this.planFactory) {
          const plan = await this.planFactory(currentTask, taskId);
          currentPlan = plan;
          outcome = await this.orchestrator.executeOnce(plan, taskId);
        } else {
          // No cached plan + no factory: drive the real Designer via execute().
          // This is the production path; tests typically wire planFactory.
          await this.orchestrator.execute(currentTask);
          outcome = { success: true, taskId };
        }
      } catch (err) {
        attemptError = toError(err);
      }

      // ── OBSERVE ─────────────────────────────────────────────────────────
      this.emitState("OBSERVE", taskId, attempt);
      const attemptSucceeded = !attemptError && (outcome?.success ?? false);
      const endedAt = this.now();

      // The observed attempt itself is always state=ATTEMPT on success OR
      // failure; ADAPT is a separate row written below when a strategy runs.
      const record: AttemptRecord = {
        attempt,
        state: attemptSucceeded ? "DONE" : "ATTEMPT",
        error: attemptError?.message ?? (outcome && !outcome.success ? outcome.error : undefined),
        startedAt,
        endedAt,
      };
      attempts.push(record);
      this.attemptsLog?.record({
        taskId,
        attempt,
        state: record.state,
        error: record.error,
        startedAt,
        endedAt,
      });

      if (attemptSucceeded) {
        // ── REPORT ────────────────────────────────────────────────────────
        this.emitState("REPORT", taskId, attempt);
        this.emitState("DONE", taskId, attempt);
        return this.finalize({ task, taskId, attempts, state: "DONE", classification });
      }

      lastError = attemptError ?? new Error(record.error ?? "unknown attempt failure");

      // §2.2: 3-strike / policy escalation evaluated AFTER observation.
      const decision = this.policy.shouldEscalate({
        attempts: spent.attempts,
        lastErrorMessage: lastError.message,
        budget: this.budget,
        spent,
        task: currentTask,
      });
      if (decision.escalate) {
        this.emitState("ESCALATE", taskId, attempt);
        return this.finalize({ task, taskId, attempts, state: "ESCALATED", escalation: decision, classification, finalError: lastError.message });
      }

      // ── ADAPT ───────────────────────────────────────────────────────────
      // Walk the ladder until a strategy handles this failure or we run out.
      // The ADAPT event is emitted once, after walkLadder picks a strategy,
      // so its payload can include the rung + strategy name. If the ladder
      // is exhausted, we escalate instead and skip the ADAPT emission.
      const next = await this.walkLadder({
        task: currentTask,
        taskId,
        attempt,
        lastError,
        lastPlan: currentPlan,
        classification,
      });

      if (!next) {
        // Ladder exhausted — escalate.
        const esc: EscalationDecision = {
          escalate: true,
          reason: "ladder-exhausted",
          detail: `no strategy handled attempt ${attempt}: ${lastError.message}`,
        };
        this.emitState("ESCALATE", taskId, attempt);
        return this.finalize({ task, taskId, attempts, state: "ESCALATED", escalation: esc, classification, finalError: lastError.message });
      }

      // Persist the ADAPT decision and prepare for the next ATTEMPT.
      const adaptEnd = this.now();
      this.attemptsLog?.record({
        taskId,
        attempt,
        state: "ADAPT",
        rung: next.strategy.rung,
        strategy: next.strategy.name,
        note: next.outcome.note,
        startedAt: endedAt,
        endedAt: adaptEnd,
      });
      attempts.push({
        attempt,
        state: "ADAPT",
        rung: next.strategy.rung,
        strategy: next.strategy.name,
        note: next.outcome.note,
        startedAt: endedAt,
        endedAt: adaptEnd,
      });
      this.bus.emit({
        kind: "loop_state",
        task_id: taskId,
        ts: adaptEnd,
        payload: { state: "ADAPT", attempt, rung: next.strategy.rung, strategy: next.strategy.name },
      });

      if (next.outcome.nextTask) currentTask = next.outcome.nextTask;
      currentPlan = next.outcome.nextPlan;
    }

    // Fell off the end of the loop — treat as ladder-exhausted.
    const esc: EscalationDecision = {
      escalate: true,
      reason: "ladder-exhausted",
      detail: `exhausted ${this.budget.maxAttempts} attempts`,
    };
    return this.finalize({ task, taskId, attempts, state: "ESCALATED", escalation: esc, classification, finalError: lastError?.message });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async walkLadder(
    ctx: FallbackContext,
  ): Promise<{ strategy: FallbackStrategy; outcome: { note?: string; nextTask?: string; nextPlan?: Plan } } | null> {
    for (const strategy of this.strategies) {
      let applies = false;
      try {
        applies = Boolean(await strategy.canHandle(ctx));
      } catch (err) {
        // A buggy canHandle must not silently skip — trace it so a debugger
        // can see why this rung never applies. Still degrade-to-continue.
        const msg = err instanceof Error ? err.message : String(err);
        this.bus.emit({
          kind: "error",
          task_id: ctx.taskId,
          payload: { where: "walkLadder.canHandle", rung: strategy.name, message: msg },
          ts: new Date(),
        });
        this.attemptsLog?.recordStrategyError?.(ctx.taskId, strategy.name, "canHandle", msg);
        applies = false;
      }
      if (!applies) continue;

      try {
        const outcome = await strategy.apply(ctx);
        if (outcome.handled) {
          return { strategy, outcome };
        }
      } catch (err) {
        // Strategy blew up mid-apply. Emit + persist so failures are debuggable.
        const msg = err instanceof Error ? err.message : String(err);
        this.bus.emit({
          kind: "error",
          task_id: ctx.taskId,
          payload: { where: "walkLadder.apply", rung: strategy.name, message: msg },
          ts: new Date(),
        });
        this.attemptsLog?.recordStrategyError?.(ctx.taskId, strategy.name, "apply", msg);
        continue;
      }
    }
    return null;
  }

  private emitState(state: LoopState, taskId: string, attempt: number, rung?: number): void {
    this.bus.emit({
      kind: "loop_state",
      task_id: taskId,
      ts: this.now(),
      payload: rung === undefined ? { state, attempt } : { state, attempt, rung },
    });
  }

  private finalize(result: Omit<LoopResult, "outcome">): LoopResult {
    const outcome: LoopOutcome = deriveOutcome(result.state, result.attempts);
    const full: LoopResult = { ...result, outcome };
    this.bus.emit({
      kind: "loop_state",
      task_id: full.taskId,
      ts: this.now(),
      payload: { state: full.state, attempt: full.attempts.length },
    });
    return full;
  }
}

/**
 * Derive the user-facing `outcome` from terminal `state` + attempt history.
 * A DONE state after at least one ADAPT entry is the Phase-2 DoD "recovered"
 * case; a DONE with no ADAPTs is a clean first-attempt win.
 */
function deriveOutcome(
  state: "DONE" | "FAILED" | "ESCALATED",
  attempts: AttemptRecord[],
): LoopOutcome {
  if (state === "ESCALATED") return "escalated";
  if (state === "FAILED") return "failed";
  // DONE: differentiate first-attempt success vs recovery-after-adapt.
  return attempts.some((a) => a.state === "ADAPT") ? "recovered" : "done";
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : JSON.stringify(err));
}
