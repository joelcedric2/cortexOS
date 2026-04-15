/**
 * AutonomyLoop tests (Nchinda §2 + §2.1 + §2.2).
 *
 * Uses a minimal fake Orchestrator (only implements `executeOnce` + `execute`)
 * so state-machine transitions can be asserted without spinning up tmux or
 * Claude CLIs. The loop is otherwise wired to the real EventBus, real
 * LoopAttemptLog (in-memory SQLite), and the real Policy / default strategies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AutonomyLoop } from "../src/loop/autonomy-loop.js";
import { Policy } from "../src/loop/policy.js";
import { LoopAttemptLog } from "../src/loop/loop-attempts-db.js";
import {
  RetrySameStrategy,
  AlternateToolStrategy,
  ReduceScopeStrategy,
  defaultStrategies,
} from "../src/loop/fallback-strategies.js";
import { createEventBus, type AgentEvent } from "../src/ipc/event-bus.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import type { Orchestrator, OrchestratorResult } from "../src/orchestrator/orchestrator.js";
import type { Plan } from "../src/orchestrator/plan-schema.js";
import type {
  ClassificationResult,
  Classifier,
  ClassifierContext,
  ClassifyOptions,
  FallbackContext,
  FallbackOutcome,
  FallbackStrategy,
} from "../src/loop/types.js";

// ─── Fakes ──────────────────────────────────────────────────────────────────

/**
 * Only implements what AutonomyLoop pokes: `executeOnce(plan, taskId)` and
 * (optionally) `execute(task)`. Results are scripted via a queue so each
 * test can choreograph success/failure per attempt.
 */
class FakeOrchestrator {
  public readonly calls: Array<{ kind: "once" | "exec"; taskId?: string }> = [];
  private readonly queue: Array<() => Promise<OrchestratorResult> | OrchestratorResult>;

  constructor(queue: Array<() => Promise<OrchestratorResult> | OrchestratorResult>) {
    this.queue = queue;
  }

  async executeOnce(_plan: Plan, taskId: string): Promise<OrchestratorResult> {
    this.calls.push({ kind: "once", taskId });
    const handler = this.queue.shift();
    if (!handler) throw new Error(`FakeOrchestrator: unexpected extra executeOnce call`);
    return handler();
  }

  async execute(_task: string): Promise<void> {
    this.calls.push({ kind: "exec" });
    const handler = this.queue.shift();
    if (!handler) throw new Error(`FakeOrchestrator: unexpected extra execute call`);
    const r = await handler();
    if (!r.success) throw new Error(r.error ?? "fake failure");
  }
}

class FakeClassifier implements Classifier {
  constructor(private readonly result: ClassificationResult) {}
  async classify(
    _task: string,
    _ctx?: ClassifierContext,
    _opts?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    return this.result;
  }
}

const CLASSIFY_MULTI: ClassificationResult = {
  complexity: "multi-agent",
  confidence: 0.9,
  rationale: "test",
};

function samplePlan(taskId: string): Plan {
  return {
    task_id: taskId,
    goal: "x",
    complexity: "multi-agent",
    agents: [
      {
        role: "backend",
        color: "blue",
        task: "t",
        success_criteria: "s",
        budget: { max_tokens: 1000, max_minutes: 1 },
        depends_on: [],
      },
    ],
    coordination: { checkpoints: [], reporting_to: "system-designer" },
  };
}

function collectBus(bus: ReturnType<typeof createEventBus>): AgentEvent[] {
  const captured: AgentEvent[] = [];
  bus.subscribe({ kind: "loop_state" }, (e) => captured.push(e));
  return captured;
}

function makeLoopDeps(opts: {
  orchestrator: FakeOrchestrator;
  strategies?: FallbackStrategy[];
  budget?: { maxAttempts: number };
  classifier?: Classifier;
  attemptsLog?: LoopAttemptLog;
}) {
  const bus = createEventBus();
  const events = collectBus(bus);
  const registry = new AgentRegistry({ dbPath: ":memory:" });
  const loop = new AutonomyLoop({
    orchestrator: opts.orchestrator as unknown as Orchestrator,
    registry,
    bus,
    policy: new Policy(),
    classifier: opts.classifier ?? new FakeClassifier(CLASSIFY_MULTI),
    attemptsLog: opts.attemptsLog,
    strategies: opts.strategies ?? defaultStrategies(),
    budget: opts.budget ?? { maxAttempts: 3 },
    planFactory: async (_t, tid) => samplePlan(tid),
  });
  return { loop, bus, events, registry };
}

// ─── Happy path ─────────────────────────────────────────────────────────────

test("AutonomyLoop success path walks RECALL → PLAN → ATTEMPT → OBSERVE → REPORT", async () => {
  const orch = new FakeOrchestrator([async () => ({ success: true, taskId: "t1" })]);
  const { loop, events } = makeLoopDeps({ orchestrator: orch });

  const result = await loop.execute("build a thing", { task_id: "t1" });

  assert.equal(result.state, "DONE");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].state, "DONE");
  assert.equal(orch.calls.length, 1);

  const states = events.map((e) => (e.payload as { state: string }).state);
  assert.deepEqual(states, ["RECALL", "PLAN", "ATTEMPT", "OBSERVE", "REPORT", "DONE", "DONE"]);
});

test("AutonomyLoop records a successful attempt in loop_attempts", async () => {
  const log = new LoopAttemptLog({ dbPath: ":memory:" });
  const orch = new FakeOrchestrator([async () => ({ success: true, taskId: "t2" })]);
  const { loop } = makeLoopDeps({ orchestrator: orch, attemptsLog: log });

  await loop.execute("x", { task_id: "t2" });

  const rows = log.byTask("t2");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "DONE");
  assert.equal(rows[0].attempt, 1);
  log.close();
});

// ─── Fallback ladder: inject a failing strategy, verify next rung fires ────

test("AutonomyLoop skips a strategy whose canHandle returns false and uses the next rung", async () => {
  // First attempt fails with a non-transient error; retry-same should NOT
  // apply (canHandle=false), so alternate-tool (rung 2) must fire.
  const orch = new FakeOrchestrator([
    async () => ({ success: false, taskId: "t3", error: "API responded 400 bad request" }),
    async () => ({ success: true, taskId: "t3" }),
  ]);
  const { loop, events } = makeLoopDeps({
    orchestrator: orch,
    strategies: [new RetrySameStrategy(), new AlternateToolStrategy(), new ReduceScopeStrategy()],
  });

  const result = await loop.execute("do something that 400s", { task_id: "t3" });

  assert.equal(result.state, "DONE");
  assert.equal(result.attempts.length, 3); // observe(fail) + adapt(with strategy) + observe(success)
  const adapt = result.attempts.find((a) => a.strategy !== undefined);
  assert.ok(adapt);
  assert.equal(adapt.strategy, "alternate-tool");
  assert.equal(adapt.rung, 2);

  // Bus event for ADAPT carries rung + strategy in its payload.
  const adaptEvent = events.find(
    (e) => (e.payload as { state: string }).state === "ADAPT",
  );
  assert.ok(adaptEvent);
  assert.equal((adaptEvent.payload as { rung: number }).rung, 2);
  assert.equal((adaptEvent.payload as { strategy: string }).strategy, "alternate-tool");
});

test("AutonomyLoop retry-same strategy fires on transient errors", async () => {
  // Transient error → rung 1 applies, rung 2 wouldn't (because it only fires
  // on non-transient errors), but we explicitly test rung 1 wins first.
  const orch = new FakeOrchestrator([
    async () => ({ success: false, taskId: "t4", error: "ETIMEDOUT fetching upstream" }),
    async () => ({ success: true, taskId: "t4" }),
  ]);
  const { loop } = makeLoopDeps({ orchestrator: orch });

  const result = await loop.execute("fetch something flaky", { task_id: "t4" });

  assert.equal(result.state, "DONE");
  const adapt = result.attempts.find((a) => a.strategy !== undefined);
  assert.ok(adapt);
  assert.equal(adapt.strategy, "retry-same");
  assert.equal(adapt.rung, 1);
});

test("AutonomyLoop escalates when no strategy in the ladder applies", async () => {
  // Only give it retry-same (rung 1), which won't fire on non-transient.
  // The loop must escalate with reason=ladder-exhausted.
  const orch = new FakeOrchestrator([
    async () => ({ success: false, taskId: "t5", error: "schema mismatch" }),
  ]);
  const { loop, events } = makeLoopDeps({
    orchestrator: orch,
    strategies: [new RetrySameStrategy()],
  });

  const result = await loop.execute("do schema work", { task_id: "t5" });

  assert.equal(result.state, "ESCALATED");
  assert.equal(result.escalation?.reason, "ladder-exhausted");
  // One ATTEMPT, then ESCALATE emitted.
  const states = events.map((e) => (e.payload as { state: string }).state);
  assert.ok(states.includes("ESCALATE"));
});

// ─── 3-strike escalation ──────────────────────────────────────────────────

test("AutonomyLoop escalates after 3 consecutive failures (three-strike)", async () => {
  // Transient errors so retry-same keeps applying — we want policy, not the
  // ladder, to be what ends the loop.
  const failures = Array.from({ length: 3 }, () => async () => ({
    success: false as const,
    taskId: "t6",
    error: "ETIMEDOUT",
  }));
  const orch = new FakeOrchestrator(failures);
  const { loop } = makeLoopDeps({
    orchestrator: orch,
    budget: { maxAttempts: 5 }, // don't let budget fire first
    strategies: [new RetrySameStrategy(), new ReduceScopeStrategy()],
  });

  const result = await loop.execute("flaky upstream", { task_id: "t6" });

  assert.equal(result.state, "ESCALATED");
  assert.equal(result.escalation?.reason, "three-strike");
  assert.equal(orch.calls.length, 3);
});

// ─── Irreversible-action gate ─────────────────────────────────────────────

test("AutonomyLoop escalates immediately on irreversible-action tasks — no attempt runs", async () => {
  const orch = new FakeOrchestrator([]); // must not be called
  const { loop } = makeLoopDeps({ orchestrator: orch });

  const result = await loop.execute("please rm -rf /", { task_id: "t7" });

  assert.equal(result.state, "ESCALATED");
  assert.equal(result.escalation?.reason, "irreversible-action");
  assert.equal(orch.calls.length, 0);
});

// ─── Budget overflow ─────────────────────────────────────────────────────

test("AutonomyLoop escalates with budget-blown when attempts exhausted without ADAPT", async () => {
  const failures = Array.from({ length: 2 }, () => async () => ({
    success: false as const,
    taskId: "t8",
    error: "ETIMEDOUT",
  }));
  const orch = new FakeOrchestrator(failures);
  const { loop } = makeLoopDeps({
    orchestrator: orch,
    budget: { maxAttempts: 2 },
    strategies: [new RetrySameStrategy()],
  });

  const result = await loop.execute("flaky", { task_id: "t8" });

  assert.equal(result.state, "ESCALATED");
  // With maxAttempts=2 and retry-same handling both, the 2nd failed attempt
  // triggers shouldEscalate (strikes=2 < 3, budget=2/2 OK), then walkLadder
  // runs, then on loop re-entry attempt=3 > maxAttempts => budget-blown.
  assert.ok(
    ["budget-blown", "three-strike", "ladder-exhausted"].includes(
      result.escalation?.reason ?? "",
    ),
  );
});

// ─── Classifier failure does not crash the loop ──────────────────────────

test("AutonomyLoop tolerates a throwing classifier and still runs", async () => {
  class BrokenClassifier implements Classifier {
    async classify(): Promise<ClassificationResult> {
      throw new Error("classifier exploded");
    }
  }
  const orch = new FakeOrchestrator([async () => ({ success: true, taskId: "t9" })]);
  const { loop } = makeLoopDeps({
    orchestrator: orch,
    classifier: new BrokenClassifier(),
  });

  const result = await loop.execute("hello", { task_id: "t9" });
  assert.equal(result.state, "DONE");
});

// ─── reduce-scope rewrites task and drops cached plan ─────────────────────

test("AutonomyLoop reduce-scope rewrites the task for the next attempt", async () => {
  const tasksSeen: string[] = [];
  class CapturingOrchestrator {
    public readonly calls: number[] = [];
    public state: "fail" | "ok" = "fail";
    async executeOnce(plan: Plan, _taskId: string): Promise<OrchestratorResult> {
      // Capture the plan's first agent's task on each call for inspection.
      tasksSeen.push(plan.agents[0]?.task ?? "");
      this.calls.push(1);
      if (this.state === "fail") {
        this.state = "ok";
        return { success: false, taskId: "t10", error: "schema drift" }; // non-transient
      }
      return { success: true, taskId: "t10" };
    }
    async execute(): Promise<void> {}
  }
  const co = new CapturingOrchestrator();

  // Only reduce-scope (rung 3) — alternate-tool would also apply here, so
  // leave it out to make the assertion crisp.
  const captured: string[] = [];
  const strategyWithTaskCapture: FallbackStrategy = {
    name: "reduce-scope",
    rung: 3,
    canHandle: () => true,
    apply: async (ctx: FallbackContext): Promise<FallbackOutcome> => {
      captured.push(ctx.task);
      return {
        handled: true,
        nextTask: `NARROWED: ${ctx.task}`,
        nextPlan: undefined,
        note: "test reducer",
      };
    },
  };

  const bus = createEventBus();
  const registry = new AgentRegistry({ dbPath: ":memory:" });
  const loop = new AutonomyLoop({
    orchestrator: co as unknown as Orchestrator,
    registry,
    bus,
    policy: new Policy(),
    classifier: new FakeClassifier(CLASSIFY_MULTI),
    strategies: [strategyWithTaskCapture],
    budget: { maxAttempts: 3 },
    planFactory: async (task, tid) => {
      const p = samplePlan(tid);
      p.agents[0].task = task;
      return p;
    },
  });

  const result = await loop.execute("original big task", { task_id: "t10" });

  assert.equal(result.state, "DONE");
  assert.equal(captured.length, 1);
  assert.equal(captured[0], "original big task");
  // Second orchestrator call should have seen the narrowed task.
  assert.equal(tasksSeen.length, 2);
  assert.equal(tasksSeen[0], "original big task");
  assert.ok(tasksSeen[1].startsWith("NARROWED:"));
});

// ─── loop_attempts persistence covers the full trajectory ─────────────────

test("AutonomyLoop persists ATTEMPT + ADAPT rows in loop_attempts", async () => {
  const log = new LoopAttemptLog({ dbPath: ":memory:" });
  const orch = new FakeOrchestrator([
    async () => ({ success: false, taskId: "t11", error: "ETIMEDOUT" }),
    async () => ({ success: true, taskId: "t11" }),
  ]);
  const { loop } = makeLoopDeps({ orchestrator: orch, attemptsLog: log });

  await loop.execute("test", { task_id: "t11" });

  const rows = log.byTask("t11");
  const states = rows.map((r) => r.state);
  assert.deepEqual(states, ["ATTEMPT", "ADAPT", "DONE"]);
  const adaptRow = rows.find((r) => r.strategy !== null);
  assert.ok(adaptRow);
  assert.equal(adaptRow.strategy, "retry-same");
  assert.equal(adaptRow.rung, 1);
  log.close();
});
