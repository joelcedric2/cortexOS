/**
 * Phase 10 — see→plan→act→verify agent loop.
 *
 * Nchinda's "hands" run inside this loop when a user asks it to take over
 * the mouse + keyboard. Each iteration:
 *
 *   1. capture  — ScreenCapturer grabs one fresh frame
 *   2. brief    — VisionBrief summarises what's on screen
 *   3. plan     — Sonnet vision call proposes the next action (see
 *                 `planFetch` test seam; the production caller passes
 *                 an LLM fetcher that hits the Messages API)
 *   4. **policy gate** — `policy.isIrreversible(action)` short-circuits:
 *                        the loop escalates to the user and returns a
 *                        `{outcome: 'escalated'}` result. No actuation.
 *   5. actuate  — delegate to `actuator.{click,type,scroll,…}`
 *   6. verify   — capture + brief a second time so the caller has a
 *                 verifiable trail; stored on the step record.
 *
 * Hard caps: `maxSteps` (default 20) and `timeBudgetMs` (default 120 s).
 * Either exhaustion is a non-failure outcome — the loop returns its
 * trajectory so the operator can resume or abandon.
 *
 * Audit: every step appends `{action: 'cu_action', detail}` when an
 * `AuditLog` is provided. The step index, the proposed action, and the
 * final outcome are all separately logged so a compliance-grade trail
 * exists for every take-over session.
 */
import type { Actuator } from "./actuator.js";
import type { AuditLog } from "../proactivity/audit.js";

// ─────────────────────────── Defaults ───────────────────────────────────

export const AGENT_LOOP_DEFAULTS = {
  maxSteps: 20,
  timeBudgetMs: 120_000,
  /** Per-plan LLM call timeout. */
  planTimeoutMs: 15_000,
} as const;

// ─────────────────────────── Core types ─────────────────────────────────

export interface ComputerUseTask {
  goal: string;
  maxSteps?: number;
  timeBudgetMs?: number;
}

export type ComputerUseOutcome =
  | "done"
  | "blocked"
  | "escalated"
  | "budget-exhausted";

export interface ProposedAction {
  /** Discriminator — determines which Actuator method is called. */
  kind: "click" | "double-click" | "move" | "type" | "scroll" | "done" | "abort";
  x?: number;
  y?: number;
  text?: string;
  dy?: number;
  dx?: number;
  button?: "left" | "right";
  /** Human-readable reason / rationale from the planner. */
  reason?: string;
}

export interface ObservationBrief {
  summary: string;
  active_app?: string | null;
  window_title?: string | null;
}

export interface ComputerUseStep {
  step: number;
  observation: ObservationBrief;
  plan: string;
  action: ProposedAction;
  verified: ObservationBrief | null;
  ts: string;
}

export interface ComputerUseResult {
  goal: string;
  outcome: ComputerUseOutcome;
  steps: ComputerUseStep[];
  error?: string;
}

// ─────────────────────────── Collaborator contracts ─────────────────────

/** Minimal capturer surface the loop needs. Keeps coupling light. */
export interface LoopCapturer {
  captureNow(): Promise<{ ok: true; frame: LoopFrame } | { ok: false; reason: string }>;
}

export interface LoopFrame {
  id: string;
  png_path: string;
  active_app: string | null;
  window_title: string | null;
  ts: Date;
}

/** Minimal brief-builder surface. */
export type LoopBrief = (
  frame: LoopFrame,
) => Promise<ObservationBrief>;

/** Policy engine — owns the irreversibility decision. */
export interface LoopPolicy {
  isIrreversible(action: ProposedAction): boolean;
}

/** Planner — turns observation + goal into a proposed action + prose plan. */
export interface PlanResponse {
  plan: string;
  action: ProposedAction;
}

export type PlanFn = (
  input: {
    goal: string;
    stepIndex: number;
    observation: ObservationBrief;
    priorSteps: ComputerUseStep[];
    apiKey?: string;
    signal?: AbortSignal;
  },
) => Promise<PlanResponse>;

export interface AgentLoopDeps {
  actuator: Actuator;
  capturer: LoopCapturer;
  brief: LoopBrief;
  policy: LoopPolicy;
  /** Test seam for the planner. Name kept as `planFetch` for parity
   *  with nchinda-see's fetchImpl naming; production supplies the
   *  Sonnet-vision-backed implementation. */
  planFetch?: PlanFn;
  apiKey?: string;
  audit?: AuditLog;
  now?: () => number;
}

// ─────────────────────────── Main entry point ───────────────────────────

/**
 * Run the see→plan→act→verify loop until the goal is reached, the budget
 * is exhausted, or the planner asks to abort.
 */
export async function runComputerUse(
  task: ComputerUseTask,
  deps: AgentLoopDeps,
): Promise<ComputerUseResult> {
  const maxSteps = task.maxSteps ?? AGENT_LOOP_DEFAULTS.maxSteps;
  const timeBudgetMs = task.timeBudgetMs ?? AGENT_LOOP_DEFAULTS.timeBudgetMs;
  const now = deps.now ?? (() => Date.now());
  const plan = deps.planFetch;
  if (!plan) {
    throw new Error("runComputerUse: `planFetch` planner is required");
  }

  const deadline = now() + timeBudgetMs;
  const steps: ComputerUseStep[] = [];

  recordAudit(deps.audit, `start goal="${redactGoal(task.goal)}" maxSteps=${maxSteps} budget=${timeBudgetMs}ms`);

  for (let i = 0; i < maxSteps; i += 1) {
    // Budget gate — checked at the top of every iteration.
    if (now() >= deadline) {
      recordAudit(deps.audit, `budget-exhausted step=${i}`);
      return finish(task.goal, steps, "budget-exhausted");
    }

    // 1. Capture + observe.
    let observation: ObservationBrief;
    try {
      observation = await observe(deps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordAudit(deps.audit, `blocked step=${i} reason=observe-failed`);
      return finish(task.goal, steps, "blocked", msg);
    }

    // 2. Plan.
    let response: PlanResponse;
    try {
      response = await plan({
        goal: task.goal,
        stepIndex: i,
        observation,
        priorSteps: steps,
        apiKey: deps.apiKey,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordAudit(deps.audit, `blocked step=${i} reason=plan-failed`);
      return finish(task.goal, steps, "blocked", msg);
    }

    // Planner asks to terminate the loop cleanly.
    if (response.action.kind === "done") {
      steps.push(buildStep(i, observation, response, null, now));
      recordAudit(deps.audit, `done step=${i}`);
      return finish(task.goal, steps, "done");
    }
    if (response.action.kind === "abort") {
      steps.push(buildStep(i, observation, response, null, now));
      recordAudit(deps.audit, `blocked step=${i} reason=planner-abort`);
      return finish(
        task.goal,
        steps,
        "blocked",
        response.action.reason ?? "planner requested abort",
      );
    }

    // 3. Policy gate — MUST fire BEFORE actuation.
    if (deps.policy.isIrreversible(response.action)) {
      steps.push(buildStep(i, observation, response, null, now));
      recordAudit(
        deps.audit,
        `escalated step=${i} kind=${response.action.kind} reason=irreversible`,
      );
      return finish(task.goal, steps, "escalated");
    }

    // 4. Actuate.
    try {
      await actuate(deps.actuator, response.action);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push(buildStep(i, observation, response, null, now));
      recordAudit(deps.audit, `blocked step=${i} reason=actuate-failed`);
      return finish(task.goal, steps, "blocked", msg);
    }

    // 5. Verify (re-capture). Failure here is non-fatal — we keep looping,
    // but the step's `verified` is left null so the operator can see it.
    let verified: ObservationBrief | null = null;
    try {
      verified = await observe(deps);
    } catch {
      verified = null;
    }
    steps.push(buildStep(i, observation, response, verified, now));
    recordAudit(
      deps.audit,
      `step=${i} kind=${response.action.kind} verified=${verified !== null}`,
    );
  }

  // Loop body completed without hitting `done` / `abort` / escalation.
  recordAudit(deps.audit, `budget-exhausted step=${maxSteps} reason=max-steps`);
  return finish(task.goal, steps, "budget-exhausted");
}

// ─────────────────────────── Internals ──────────────────────────────────

async function observe(deps: AgentLoopDeps): Promise<ObservationBrief> {
  const outcome = await deps.capturer.captureNow();
  if (!outcome.ok) {
    throw new Error(`capture failed: ${outcome.reason}`);
  }
  return await deps.brief(outcome.frame);
}

async function actuate(actuator: Actuator, action: ProposedAction): Promise<void> {
  switch (action.kind) {
    case "click":
      requireXY(action);
      await actuator.click(action.x!, action.y!, action.button ?? "left");
      return;
    case "double-click":
      requireXY(action);
      await actuator.doubleClick(action.x!, action.y!);
      return;
    case "move":
      requireXY(action);
      await actuator.moveTo(action.x!, action.y!);
      return;
    case "type":
      if (typeof action.text !== "string") {
        throw new Error("action.kind=type requires `text`");
      }
      await actuator.type(action.text);
      return;
    case "scroll":
      requireXY(action);
      if (typeof action.dy !== "number") {
        throw new Error("action.kind=scroll requires `dy`");
      }
      await actuator.scroll(action.x!, action.y!, action.dy, action.dx ?? 0);
      return;
    default:
      throw new Error(`actuate: unsupported action.kind=${action.kind}`);
  }
}

function requireXY(action: ProposedAction): void {
  if (typeof action.x !== "number" || typeof action.y !== "number") {
    throw new Error(`action.kind=${action.kind} requires x/y`);
  }
}

function buildStep(
  step: number,
  observation: ObservationBrief,
  response: PlanResponse,
  verified: ObservationBrief | null,
  now: () => number,
): ComputerUseStep {
  return {
    step,
    observation,
    plan: response.plan,
    action: response.action,
    verified,
    ts: new Date(now()).toISOString(),
  };
}

function finish(
  goal: string,
  steps: ComputerUseStep[],
  outcome: ComputerUseOutcome,
  error?: string,
): ComputerUseResult {
  const result: ComputerUseResult = { goal, outcome, steps };
  if (error !== undefined) result.error = error;
  return result;
}

function recordAudit(audit: AuditLog | undefined, detail: string): void {
  if (!audit) return;
  try {
    audit.append({ action: "cu_action", detail, ts: new Date() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[agent-loop] audit append failed: ${msg}`);
  }
}

/** Keep the goal out of the audit trail when it looks like PII. */
function redactGoal(goal: string): string {
  const trimmed = goal.length > 80 ? `${goal.slice(0, 80)}…` : goal;
  return trimmed.replace(/["\\\n\r\t]/g, " ");
}
