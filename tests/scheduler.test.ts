/**
 * Phase 1.5 — Persistent Scheduler tests.
 *
 * Covers CronJobsDB CRUD + listDue filtering (this file),
 * Scheduler ticker semantics are appended below once Scheduler lands.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CronJobsDB } from "../src/scheduler/cron-jobs-db.js";

function futureIso(ms: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + ms);
}

describe("CronJobsDB", () => {
  let db: CronJobsDB;

  beforeEach(() => {
    db = new CronJobsDB({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
  });

  test("create round-trip persists all fields", () => {
    const next = new Date("2026-05-01T12:00:00.000Z");
    const job = db.create({
      id: "job-1",
      name: "morning brief",
      cron_expr: "0 8 * * *",
      task: "summarize overnight emails",
      role_hint: "system-designer",
      depth: "multi-agent",
      enabled: true,
      timezone: "America/New_York",
      next_run: next,
      created_by: "onboarding",
    });
    assert.equal(job.id, "job-1");
    assert.equal(job.name, "morning brief");
    assert.equal(job.cron_expr, "0 8 * * *");
    assert.equal(job.task, "summarize overnight emails");
    assert.equal(job.role_hint, "system-designer");
    assert.equal(job.depth, "multi-agent");
    assert.equal(job.enabled, true);
    assert.equal(job.timezone, "America/New_York");
    assert.equal(job.next_run, next.toISOString());
    assert.equal(job.created_by, "onboarding");
    assert.equal(job.last_run, null);
  });

  test("create defaults enabled=false, timezone=America/New_York", () => {
    const job = db.create({
      id: "job-defaults",
      name: "defaults",
      cron_expr: "* * * * *",
      task: "print alive",
      created_by: "user",
    });
    assert.equal(job.enabled, false);
    assert.equal(job.timezone, "America/New_York");
    assert.equal(job.next_run, null);
    assert.equal(job.depth, null);
    assert.equal(job.role_hint, null);
  });

  test("getById returns undefined for missing", () => {
    assert.equal(db.getById("missing"), undefined);
  });

  test("list returns jobs in creation order", () => {
    db.create({ id: "a", name: "a", cron_expr: "* * * * *", task: "t", created_by: "user" });
    db.create({ id: "b", name: "b", cron_expr: "* * * * *", task: "t", created_by: "user" });
    const all = db.list();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((j) => j.id), ["a", "b"]);
  });

  test("update patches only provided fields", () => {
    db.create({
      id: "u1",
      name: "before",
      cron_expr: "* * * * *",
      task: "t",
      enabled: false,
      created_by: "user",
    });
    const updated = db.update("u1", { name: "after", enabled: true });
    assert.equal(updated.name, "after");
    assert.equal(updated.enabled, true);
    assert.equal(updated.cron_expr, "* * * * *");
  });

  test("update with empty patch returns existing row", () => {
    db.create({ id: "u2", name: "n", cron_expr: "* * * * *", task: "t", created_by: "user" });
    const same = db.update("u2", {});
    assert.equal(same.id, "u2");
  });

  test("update on missing id throws", () => {
    assert.throws(() => db.update("missing", { name: "x" }), /no job with id/);
  });

  test("delete removes the job and its runs", () => {
    db.create({ id: "d1", name: "d", cron_expr: "* * * * *", task: "t", created_by: "user" });
    db.markRan("d1", "success", 12);
    db.delete("d1");
    assert.equal(db.getById("d1"), undefined);
    assert.deepEqual(db.runsByJob("d1"), []);
  });

  test("delete on missing id throws", () => {
    assert.throws(() => db.delete("missing"), /no job with id/);
  });

  test("listDue returns only enabled jobs whose next_run <= now", () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    db.create({
      id: "due-past",
      name: "due-past",
      cron_expr: "* * * * *",
      task: "t",
      enabled: true,
      next_run: new Date(now.getTime() - 60_000),
      created_by: "user",
    });
    db.create({
      id: "due-now",
      name: "due-now",
      cron_expr: "* * * * *",
      task: "t",
      enabled: true,
      next_run: now,
      created_by: "user",
    });
    db.create({
      id: "future",
      name: "future",
      cron_expr: "* * * * *",
      task: "t",
      enabled: true,
      next_run: futureIso(60_000, now),
      created_by: "user",
    });
    db.create({
      id: "disabled-due",
      name: "disabled",
      cron_expr: "* * * * *",
      task: "t",
      enabled: false,
      next_run: new Date(now.getTime() - 60_000),
      created_by: "user",
    });
    db.create({
      id: "unscheduled",
      name: "unscheduled",
      cron_expr: "* * * * *",
      task: "t",
      enabled: true,
      created_by: "user",
    });

    const due = db.listDue(now);
    assert.deepEqual(due.map((j) => j.id).sort(), ["due-now", "due-past"]);
  });

  test("markRan updates last_run and appends cron_runs row", () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    db.create({
      id: "r1",
      name: "r1",
      cron_expr: "* * * * *",
      task: "t",
      created_by: "user",
    });
    const run = db.markRan("r1", "success", 42, "ok", now);
    assert.equal(run.job_id, "r1");
    assert.equal(run.outcome, "success");
    assert.equal(run.duration_ms, 42);
    assert.equal(run.summary, "ok");
    assert.equal(run.run_at, now.toISOString());

    const job = db.getById("r1");
    assert.equal(job?.last_run, now.toISOString());

    const history = db.runsByJob("r1");
    assert.equal(history.length, 1);
    assert.equal(history[0].id, run.id);
  });

  test("markRan on missing id throws", () => {
    assert.throws(() => db.markRan("missing", "success", 1), /no job with id/);
  });
});

// ============================================================================
// Scheduler ticker tests.
// ============================================================================
import { Scheduler, type SchedulerRun } from "../src/scheduler/scheduler.js";
import type { CronJob, CronOutcome, CronRun } from "../src/scheduler/cron-jobs-db.js";
import { createEventBus } from "../src/ipc/event-bus.js";

interface FakeCronDB {
  listDue: (now: Date) => CronJob[];
  markRan: (
    id: string,
    outcome: CronOutcome,
    durationMs: number,
    summary?: string,
    runAt?: Date,
  ) => CronRun;
  calls: Array<{
    id: string;
    outcome: CronOutcome;
    durationMs: number;
    summary?: string;
  }>;
  due: CronJob[];
}

function makeJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: `job-${id}`,
    cron_expr: "* * * * *",
    task: `task-${id}`,
    role_hint: null,
    depth: null,
    enabled: true,
    timezone: "America/New_York",
    last_run: null,
    next_run: new Date("2026-05-01T12:00:00.000Z").toISOString(),
    created_by: "user",
    created_at: new Date("2026-04-01T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

function makeFakeDB(initialDue: CronJob[] = []): FakeCronDB {
  const db: FakeCronDB = {
    due: [...initialDue],
    calls: [],
    listDue() {
      return [...db.due];
    },
    markRan(id, outcome, durationMs, summary) {
      db.calls.push({ id, outcome, durationMs, summary });
      // Mimic post-run: jobs drop out of the due list once fired.
      db.due = db.due.filter((j) => j.id !== id);
      return {
        id: db.calls.length,
        job_id: id,
        run_at: new Date().toISOString(),
        outcome,
        duration_ms: durationMs,
        summary: summary ?? null,
      };
    },
  };
  return db;
}

describe("Scheduler", () => {
  test("dispatches a due job, emits cron_fire once, markRan success", async () => {
    const db = makeFakeDB([makeJob("j1")]);
    const bus = createEventBus();
    const fireEvents: string[] = [];
    bus.subscribe({ kind: "cron_fire" }, (e) => {
      fireEvents.push(e.task_id ?? "");
    });

    const runCalls: string[] = [];
    const run: SchedulerRun = async (job) => {
      runCalls.push(job.id);
    };

    const now = () => new Date("2026-05-01T12:00:05.000Z");
    const sched = new Scheduler({ db: db as unknown as import("../src/scheduler/cron-jobs-db.js").CronJobsDB, bus, run, now });
    sched.tick();
    // Let the runJob microtask settle so markRan fires.
    await new Promise<void>((r) => setImmediate(r));
    await sched.stop();

    assert.deepEqual(fireEvents, ["j1"]);
    assert.deepEqual(runCalls, ["j1"]);
    assert.equal(db.calls.length, 1);
    assert.equal(db.calls[0].id, "j1");
    assert.equal(db.calls[0].outcome, "success");
    assert.ok(db.calls[0].durationMs >= 0);
  });

  test("dedup: slow job does not double-fire on re-tick", async () => {
    const db = makeFakeDB([makeJob("slow")]);
    const bus = createEventBus();
    const fires: string[] = [];
    bus.subscribe({ kind: "cron_fire" }, (e) => {
      fires.push(e.task_id ?? "");
    });

    // Job never resolves within the test.
    let resolveRun: () => void = () => {};
    const runPromise = new Promise<void>((r) => {
      resolveRun = r;
    });
    const run: SchedulerRun = () => runPromise;

    const sched = new Scheduler({ db: db as unknown as import("../src/scheduler/cron-jobs-db.js").CronJobsDB, bus, run });

    // Inject the job back on the due list between ticks — the Scheduler
    // must still skip because inFlight blocks it.
    sched.tick();
    db.due = [makeJob("slow")];
    sched.tick();
    sched.tick();

    assert.equal(fires.length, 1, `expected 1 fire, got ${fires.length}`);
    assert.equal(sched.inFlightCount, 1);

    // Let the job complete so stop() can return cleanly.
    resolveRun();
    await sched.stop();
    assert.equal(db.calls.length, 1);
  });

  test("stop() is idempotent", async () => {
    const db = makeFakeDB([]);
    const bus = createEventBus();
    const run: SchedulerRun = async () => {};
    const sched = new Scheduler({ db: db as unknown as import("../src/scheduler/cron-jobs-db.js").CronJobsDB, bus, run });
    sched.start(1);
    await sched.stop();
    // Second stop must not throw.
    await sched.stop();
    assert.equal(sched.inFlightCount, 0);
  });

  test("stop() awaits in-flight runs", async () => {
    const db = makeFakeDB([makeJob("long")]);
    const bus = createEventBus();

    let resolveRun: () => void = () => {};
    const runStarted = new Promise<void>((runStartResolve) => {
      const run: SchedulerRun = () => {
        runStartResolve();
        return new Promise<void>((r) => {
          resolveRun = r;
        });
      };
      const sched = new Scheduler({ db: db as unknown as import("../src/scheduler/cron-jobs-db.js").CronJobsDB, bus, run });
      sched.tick();
      // Kick off stop() — it should block until we resolve the run.
      runStarted.then(async () => {
        let stopSettled = false;
        const stopPromise = sched.stop().then(() => {
          stopSettled = true;
        });
        // Give stop() a tick to observe the in-flight map; it must still be pending.
        await new Promise<void>((r) => setImmediate(r));
        assert.equal(stopSettled, false, "stop() resolved before in-flight run finished");
        resolveRun();
        await stopPromise;
        assert.equal(stopSettled, true);
        assert.equal(db.calls.length, 1, "markRan must have been called once");
      });
    });
    await runStarted;
    // Make sure the awaiting handler finishes before the test ends.
    await new Promise<void>((r) => setTimeout(r, 50));
  });

  test("executor rejection surfaces as markRan outcome='fail' with summary", async () => {
    const db = makeFakeDB([makeJob("bad")]);
    const bus = createEventBus();
    const run: SchedulerRun = async () => {
      throw new Error("boom");
    };

    const sched = new Scheduler({ db: db as unknown as import("../src/scheduler/cron-jobs-db.js").CronJobsDB, bus, run });
    sched.tick();
    await new Promise<void>((r) => setImmediate(r));
    await sched.stop();

    assert.equal(db.calls.length, 1);
    assert.equal(db.calls[0].outcome, "fail");
    assert.equal(db.calls[0].summary, "boom");
  });

  test("start() is a no-op when already running", () => {
    const db = makeFakeDB([]);
    const bus = createEventBus();
    const run: SchedulerRun = async () => {};
    const sched = new Scheduler({ db: db as unknown as import("../src/scheduler/cron-jobs-db.js").CronJobsDB, bus, run });
    sched.start(60);
    // Second start must not throw or create a second timer — we just verify no error.
    sched.start(60);
    // Clean up. stop() should handle the single timer cleanly.
    return sched.stop();
  });
});
