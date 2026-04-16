/**
 * Phase 7 — Coder 3
 * Stress harness tests. We drive `runStressBattery` with deterministic
 * scripted runners to exercise every code path: success, recovered,
 * failed, escalated, timeout; concurrency bounding; p95; byComplexity;
 * token aggregation; never-throws contract.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runStressBattery,
  type StressResult,
  type StressTask,
} from "../src/bench/stress-harness.js";

function mkTask(
  id: string,
  complexity: StressTask["complexity"],
  opts: Partial<Pick<StressTask, "expectedOutcome" | "expectedMaxAttempts">> = {},
): StressTask {
  return {
    id,
    complexity,
    task: `task-${id}`,
    expectedOutcome: opts.expectedOutcome ?? "success",
    expectedMaxAttempts: opts.expectedMaxAttempts ?? 2,
  };
}

describe("runStressBattery", () => {
  test("computes autonomy, outcomes, tokens, and byComplexity correctly", async () => {
    const tasks: StressTask[] = [
      mkTask("s1", "simple"),
      mkTask("s2", "simple"),
      mkTask("s3", "simple"),
      mkTask("s4", "simple"),
      mkTask("m1", "moderate"),
      mkTask("m2", "moderate"),
      mkTask("m3", "moderate"),
      mkTask("c1", "complex"),
      mkTask("c2", "complex"),
      mkTask("e1", "moderate", { expectedOutcome: "escalation-acceptable" }),
    ];

    const outcomes: Record<string, StressResult> = {
      s1: { taskId: "s1", outcome: "success", attempts: 1, duration_ms: 100, tokens_in: 10, tokens_out: 5 },
      s2: { taskId: "s2", outcome: "success", attempts: 1, duration_ms: 120, tokens_in: 12, tokens_out: 6 },
      s3: { taskId: "s3", outcome: "recovered", attempts: 2, duration_ms: 200, tokens_in: 20, tokens_out: 10 },
      s4: { taskId: "s4", outcome: "failed", attempts: 3, duration_ms: 300, error: "boom" },
      m1: { taskId: "m1", outcome: "success", attempts: 1, duration_ms: 400, tokens_in: 40, tokens_out: 20 },
      m2: { taskId: "m2", outcome: "recovered", attempts: 2, duration_ms: 500, tokens_in: 50, tokens_out: 25 },
      m3: { taskId: "m3", outcome: "failed", attempts: 2, duration_ms: 600, error: "nope" },
      c1: { taskId: "c1", outcome: "success", attempts: 1, duration_ms: 700, tokens_in: 70, tokens_out: 35 },
      c2: { taskId: "c2", outcome: "escalated", attempts: 1, duration_ms: 800 }, // NOT escalation-acceptable → counts as non-autonomy
      e1: { taskId: "e1", outcome: "escalated", attempts: 1, duration_ms: 900 }, // acceptable → counts as autonomy
    };

    const report = await runStressBattery({
      tasks,
      concurrency: 3,
      runTaskFn: async (t) => outcomes[t.id],
    });

    assert.equal(report.total, 10);
    assert.equal(report.byOutcome.success, 4);
    assert.equal(report.byOutcome.recovered, 2);
    assert.equal(report.byOutcome.failed, 2);
    assert.equal(report.byOutcome.escalated, 2);
    assert.equal(report.byOutcome.timeout, 0);

    // autonomy = success(4) + recovered(2) + escalation-acceptable escalated(1) = 7/10
    assert.equal(report.autonomyPct, 70);
    assert.equal(report.successPct, 40);

    assert.equal(report.totalTokens.in, 10 + 12 + 20 + 40 + 50 + 70);
    assert.equal(report.totalTokens.out, 5 + 6 + 10 + 20 + 25 + 35);

    // byComplexity
    assert.equal(report.byComplexity.simple.total, 4);
    // simple: 2 success + 1 recovered = 3 autonomy / 4 = 75
    assert.equal(report.byComplexity.simple.autonomyPct, 75);

    assert.equal(report.byComplexity.moderate.total, 4);
    // moderate: 1 success + 1 recovered + 1 escalate-acceptable escalated = 3/4 = 75
    assert.equal(report.byComplexity.moderate.autonomyPct, 75);

    assert.equal(report.byComplexity.complex.total, 2);
    // complex: 1 success + 1 non-acceptable escalated → 1/2 = 50
    assert.equal(report.byComplexity.complex.autonomyPct, 50);

    // failures bucket = everything non-autonomy: s4, m3, c2 = 3
    assert.equal(report.failures.length, 3);
    const failureIds = report.failures.map((r) => r.taskId).sort();
    assert.deepEqual(failureIds, ["c2", "m3", "s4"]);

    // p95 is nearest-rank over 10 durations → rank = ceil(0.95*10)=10 → max = 900
    assert.equal(report.p95Duration_ms, 900);

    // avg = (100+120+200+300+400+500+600+700+800+900)/10 = 462
    assert.equal(report.avgDuration_ms, 462);
  });

  test("respects concurrency: at most N tasks in-flight simultaneously", async () => {
    const concurrency = 3;
    const n = 20;
    let inFlight = 0;
    let peak = 0;
    const tasks: StressTask[] = Array.from({ length: n }, (_, i) =>
      mkTask(`t${i}`, "simple"),
    );

    const report = await runStressBattery({
      tasks,
      concurrency,
      runTaskFn: async (t) => {
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        await new Promise((r) => setImmediate(r));
        inFlight--;
        return {
          taskId: t.id,
          outcome: "success",
          attempts: 1,
          duration_ms: 1,
        };
      },
    });

    assert.ok(peak <= concurrency, `peak ${peak} exceeded concurrency ${concurrency}`);
    assert.equal(report.total, n);
    assert.equal(report.byOutcome.success, n);
  });

  test("treats runner exceptions as failed outcomes (never throws)", async () => {
    const tasks = [mkTask("x1", "simple"), mkTask("x2", "simple")];
    const report = await runStressBattery({
      tasks,
      runTaskFn: async (t) => {
        if (t.id === "x1") throw new Error("kaboom");
        return { taskId: t.id, outcome: "success", attempts: 1, duration_ms: 5 };
      },
    });
    assert.equal(report.byOutcome.success, 1);
    assert.equal(report.byOutcome.failed, 1);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].taskId, "x1");
    assert.match(report.failures[0].error ?? "", /kaboom/);
  });

  test("enforces perTaskTimeoutMs and records timeout outcome", async () => {
    const tasks = [mkTask("hang", "simple")];
    const report = await runStressBattery({
      tasks,
      perTaskTimeoutMs: 25,
      runTaskFn: () => new Promise(() => {}), // never resolves
    });
    assert.equal(report.byOutcome.timeout, 1);
    assert.equal(report.total, 1);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].outcome, "timeout");
  });

  test("empty task list returns a well-formed zeroed report", async () => {
    const report = await runStressBattery({
      tasks: [],
      runTaskFn: async () => {
        throw new Error("should not be called");
      },
    });
    assert.equal(report.total, 0);
    assert.equal(report.autonomyPct, 0);
    assert.equal(report.successPct, 0);
    assert.equal(report.p95Duration_ms, 0);
    assert.equal(report.failures.length, 0);
  });

  test("invokes onProgress for every completed task", async () => {
    const tasks = [mkTask("a", "simple"), mkTask("b", "simple"), mkTask("c", "simple")];
    const seen: number[] = [];
    await runStressBattery({
      tasks,
      concurrency: 1,
      runTaskFn: async (t) => ({
        taskId: t.id,
        outcome: "success",
        attempts: 1,
        duration_ms: 1,
      }),
      onProgress: (_r, completed, total) => {
        assert.equal(total, 3);
        seen.push(completed);
      },
    });
    assert.deepEqual(seen, [1, 2, 3]);
  });
});
