/**
 * Phase 7 — Per-role success-rate tests.
 *
 * Seeds loop_attempts + agents fixtures on :memory: DBs, then asserts the
 * aggregate + trend output. The join is done in-memory so we exercise it
 * end-to-end via the real LoopAttemptLog / AgentRegistry classes.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LoopAttemptLog } from "../src/loop/loop-attempts-db.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { computeSuccessRate } from "../src/analytics/success-rate.js";

interface ScriptedAttempt {
  taskId: string;
  attempt: number;
  state: "ATTEMPT" | "DONE" | "ADAPT" | "ESCALATED";
  error?: string;
  strategy?: string;
  minutesAgo?: number;
  durationMs?: number;
}

function seed(log: LoopAttemptLog, rows: ScriptedAttempt[]): void {
  for (const r of rows) {
    const duration = r.durationMs ?? 100;
    const start = new Date(Date.now() - (r.minutesAgo ?? 5) * 60_000);
    const end = new Date(start.getTime() + duration);
    log.record({
      taskId: r.taskId,
      attempt: r.attempt,
      state: r.state,
      error: r.error,
      strategy: r.strategy,
      startedAt: start,
      endedAt: end,
    });
  }
}

describe("computeSuccessRate", () => {
  let tmpDir: string;
  let log: LoopAttemptLog;
  let registry: AgentRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "success-rate-"));
    log = new LoopAttemptLog({ dbPath: join(tmpDir, "loop.db") });
    registry = new AgentRegistry({ dbPath: join(tmpDir, "registry.db") });
  });

  afterEach(() => {
    log.close();
    registry.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("empty data returns zero stats and a zero-filled trend", async () => {
    const report = await computeSuccessRate({ attemptsLog: log, registry }, { windowDays: 3 });
    assert.equal(report.byRole.length, 0);
    assert.equal(report.byOverall.totalAttempts, 0);
    assert.equal(report.byOverall.successRate, 0);
    assert.equal(report.byOverall.autonomyRate, 0);
    assert.equal(report.trend.length, 3);
    for (const pt of report.trend) {
      assert.equal(pt.totalAttempts, 0);
      assert.equal(pt.successRate, 0);
    }
  });

  test("first-attempt DONE is a clean success; autonomyRate=1", async () => {
    registry.spawn({ id: "a1", role: "coder", color: "#fff", task_id: "task-1" });
    seed(log, [
      { taskId: "task-1", attempt: 1, state: "DONE", durationMs: 250 },
    ]);

    const report = await computeSuccessRate({ attemptsLog: log, registry }, { windowDays: 7 });
    assert.equal(report.byRole.length, 1);
    const [coder] = report.byRole;
    assert.equal(coder.role, "coder");
    assert.equal(coder.totalAttempts, 1);
    assert.equal(coder.successCount, 1);
    assert.equal(coder.recoveredCount, 0);
    assert.equal(coder.successRate, 1);
    assert.equal(coder.autonomyRate, 1);
    assert.equal(coder.avgAttemptsToResolve, 1);
    assert.ok(coder.avgDurationMs >= 250);
  });

  test("DONE after an ADAPT counts as recovered, not success", async () => {
    registry.spawn({ id: "a2", role: "coder", color: "#f00", task_id: "task-r" });
    seed(log, [
      { taskId: "task-r", attempt: 1, state: "ATTEMPT", error: "TIMEOUT" },
      { taskId: "task-r", attempt: 1, state: "ADAPT", strategy: "retry_same" },
      { taskId: "task-r", attempt: 2, state: "DONE" },
    ]);

    const report = await computeSuccessRate({ attemptsLog: log, registry });
    const coder = report.byRole.find((r) => r.role === "coder");
    assert.ok(coder);
    assert.equal(coder!.successCount, 0);
    assert.equal(coder!.recoveredCount, 1);
    // autonomyRate includes recovered — "no human asked".
    assert.equal(coder!.autonomyRate, 1);
    assert.equal(coder!.successRate, 0);
  });

  test("ESCALATED pulls autonomyRate down", async () => {
    registry.spawn({ id: "a3", role: "researcher", color: "#00f", task_id: "task-esc" });
    seed(log, [
      { taskId: "task-esc", attempt: 1, state: "ATTEMPT", error: "AUTH" },
      { taskId: "task-esc", attempt: 2, state: "ATTEMPT", error: "AUTH" },
      { taskId: "task-esc", attempt: 3, state: "ATTEMPT", error: "AUTH" },
      { taskId: "task-esc", attempt: 3, state: "ESCALATED" },
    ]);

    const report = await computeSuccessRate({ attemptsLog: log, registry });
    const r = report.byRole.find((x) => x.role === "researcher");
    assert.ok(r);
    assert.equal(r!.escalatedCount, 1);
    assert.equal(r!.autonomyRate, 0);
    assert.equal(r!.successRate, 0);
  });

  test("aggregates per-role with multiple agents + tasks", async () => {
    registry.spawn({ id: "a1", role: "coder", color: "#000", task_id: "t-c1" });
    registry.spawn({ id: "a2", role: "coder", color: "#000", task_id: "t-c2" });
    registry.spawn({ id: "a3", role: "researcher", color: "#000", task_id: "t-r1" });

    seed(log, [
      // coder: 1 success, 1 recovered
      { taskId: "t-c1", attempt: 1, state: "DONE" },
      { taskId: "t-c2", attempt: 1, state: "ATTEMPT", error: "NETWORK" },
      { taskId: "t-c2", attempt: 1, state: "ADAPT", strategy: "retry_same" },
      { taskId: "t-c2", attempt: 2, state: "DONE" },
      // researcher: 1 escalated
      { taskId: "t-r1", attempt: 1, state: "ATTEMPT", error: "AUTH" },
      { taskId: "t-r1", attempt: 1, state: "ESCALATED" },
    ]);

    const report = await computeSuccessRate({ attemptsLog: log, registry });
    // Sorted alphabetically
    assert.deepEqual(report.byRole.map((r) => r.role), ["coder", "researcher"]);
    const coder = report.byRole[0];
    assert.equal(coder.totalAttempts, 2);
    assert.equal(coder.successCount, 1);
    assert.equal(coder.recoveredCount, 1);
    assert.equal(coder.autonomyRate, 1);
    assert.equal(coder.successRate, 0.5);

    const res = report.byRole[1];
    assert.equal(res.totalAttempts, 1);
    assert.equal(res.escalatedCount, 1);
    assert.equal(res.autonomyRate, 0);

    // Overall rolls up 3 tasks.
    assert.equal(report.byOverall.totalAttempts, 3);
    assert.equal(report.byOverall.successCount, 1);
    assert.equal(report.byOverall.recoveredCount, 1);
    assert.equal(report.byOverall.escalatedCount, 1);
  });

  test("tasks without a registered agent bucket under role='unknown'", async () => {
    seed(log, [{ taskId: "orphan", attempt: 1, state: "DONE" }]);
    const report = await computeSuccessRate({ attemptsLog: log, registry });
    const unknown = report.byRole.find((r) => r.role === "unknown");
    assert.ok(unknown);
    assert.equal(unknown!.totalAttempts, 1);
  });

  test("trend emits one point per day in the window, sorted chronologically", async () => {
    registry.spawn({ id: "a1", role: "coder", color: "#000", task_id: "t-1" });
    seed(log, [{ taskId: "t-1", attempt: 1, state: "DONE", minutesAgo: 60 }]);

    const report = await computeSuccessRate({ attemptsLog: log, registry }, { windowDays: 5 });
    assert.equal(report.trend.length, 5);
    // Days are strictly increasing YYYY-MM-DD strings.
    for (let i = 1; i < report.trend.length; i++) {
      assert.ok(
        report.trend[i - 1].day <= report.trend[i].day,
        `trend days must be sorted: ${report.trend[i - 1].day} !< ${report.trend[i].day}`,
      );
    }
    // The task landed today — one of the points should reflect that.
    const withActivity = report.trend.filter((p) => p.totalAttempts > 0);
    assert.equal(withActivity.length, 1);
    assert.equal(withActivity[0].successRate, 1);
  });

  test("windowDays excludes old tasks from the aggregates", async () => {
    registry.spawn({ id: "a1", role: "coder", color: "#000", task_id: "t-old" });
    // ended_at outside window
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    log.record({
      taskId: "t-old",
      attempt: 1,
      state: "DONE",
      startedAt: old,
      endedAt: old,
    });
    const report = await computeSuccessRate({ attemptsLog: log, registry }, { windowDays: 7 });
    assert.equal(report.byRole.length, 0);
    assert.equal(report.byOverall.totalAttempts, 0);
  });
});
