/**
 * Phase 1.5 — Definition of Done smoke test.
 *
 * Proves the end-to-end scheduler wiring:
 *   1. A real CronJobsDB (:memory:), real Scheduler, real EventBus.
 *   2. Insert a minute-granularity job with next_run=now, enabled=true.
 *   3. Drive a single tick with a fake clock.
 *   4. Assert cron_fire hit the bus, run(job) was called exactly once,
 *      markRan recorded outcome=success with duration_ms > 0, and the
 *      cron_runs row persisted.
 *   5. Seed the 6 defaults, assert they all land disabled, then call
 *      nchinda_schedule({utterance:"every Friday at 5pm", autoEnable:true})
 *      and assert a new row with cron_expr="0 17 * * 5" is enabled=true.
 *
 * Corresponds to NCHINDA_PLAN §6 Phase 1.5 DoD.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CronJobsDB } from "../src/scheduler/cron-jobs-db.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import {
  createEventBus,
  type AgentEvent,
} from "../src/ipc/event-bus.js";
import { seedDefaults, DEFAULT_JOBS } from "../src/scheduler/defaults.js";
import { NchindaTools } from "../src/mcp/nchinda-tools.js";

test("Phase 1.5 DoD — single tick fires, emits, markRan, persists", async () => {
  const db = new CronJobsDB({ dbPath: ":memory:" });
  try {
    const bus = createEventBus();
    const fired: AgentEvent[] = [];
    bus.subscribe({ kind: "cron_fire" }, (e) => fired.push(e));

    const now = new Date("2026-05-01T12:00:00.000Z");
    db.create({
      id: "dod-job",
      name: "every-minute-alive",
      cron_expr: "* * * * *",
      task: "print 'alive'",
      enabled: true,
      timezone: "UTC",
      created_by: "user",
      next_run: now,
    });

    const runCalls: string[] = [];
    const run = async (job: { id: string }) => {
      runCalls.push(job.id);
      // Simulate real work so duration_ms > 0.
      await new Promise((r) => setTimeout(r, 5));
    };

    // Fake clock — first reads at the insert "now", subsequent reads
    // advance by 10ms per call so finishedAt - startedAt > 0.
    let clockMs = now.getTime();
    const scheduler = new Scheduler({
      db,
      bus,
      run,
      now: () => {
        const t = new Date(clockMs);
        clockMs += 10;
        return t;
      },
    });

    // Drive one tick manually — do NOT call start() to avoid setInterval.
    scheduler.tick();
    // Give the in-flight runJob microtask + setTimeout chain a chance to settle.
    await scheduler.stop();

    // 1. cron_fire emitted exactly once.
    assert.equal(fired.length, 1, "expected one cron_fire event");
    assert.equal(fired[0]?.kind, "cron_fire");
    assert.equal(fired[0]?.task_id, "dod-job");
    assert.deepEqual(fired[0]?.payload, {
      name: "every-minute-alive",
      task: "print 'alive'",
    });

    // 2. run(job) called exactly once.
    assert.deepEqual(runCalls, ["dod-job"]);

    // 3. cron_runs row persists with outcome=success, duration_ms > 0.
    const runs = db.runsByJob("dod-job");
    assert.equal(runs.length, 1, "expected one cron_runs row");
    assert.equal(runs[0]?.outcome, "success");
    assert.ok(
      (runs[0]?.duration_ms ?? 0) > 0,
      `duration_ms must be > 0, got ${runs[0]?.duration_ms}`,
    );

    // 4. last_run got stamped on the job.
    const job = db.getById("dod-job");
    assert.ok(job);
    assert.ok(job?.last_run, "last_run must be populated after markRan");
  } finally {
    db.close();
  }
});

test("Phase 1.5 DoD — defaults seed + nchinda_schedule autoEnable", async () => {
  const db = new CronJobsDB({ dbPath: ":memory:" });
  try {
    // Seed the 6 defaults.
    const seedResult = seedDefaults(db);
    assert.equal(seedResult.inserted, 6);
    assert.equal(seedResult.skipped, 0);

    const rows = db.list();
    assert.equal(rows.length, 6, "expected 6 default rows");
    const names = new Set(rows.map((r) => r.name));
    for (const d of DEFAULT_JOBS) {
      assert.ok(names.has(d.name), `missing seeded default: ${d.name}`);
    }
    // All seeded jobs must be disabled.
    for (const r of rows) {
      assert.equal(r.enabled, false, `${r.name} should ship disabled`);
    }

    // Call nchinda_schedule("every Friday at 5pm", autoEnable:true).
    const tools = new NchindaTools({
      vectorStore: {
        storeMemory: async () => "unused",
        searchMemories: async () => [],
      },
      embedder: { embed: async () => new Array(384).fill(0) },
      cronDb: db,
      // Force heuristic path (no API key).
      parseNlOptions: { apiKey: "" },
    });

    const result = await tools.schedule({
      utterance: "every Friday at 5pm",
      autoEnable: true,
    });

    assert.equal(result.cron_expr, "0 17 * * 5");
    assert.equal(result.enabled, true);

    const fresh = db.getById(result.job_id);
    assert.ok(fresh, "new scheduled row must exist");
    assert.equal(fresh?.cron_expr, "0 17 * * 5");
    assert.equal(fresh?.enabled, true);

    // 6 defaults + 1 scheduled = 7 rows, 1 enabled.
    const all = db.list();
    assert.equal(all.length, 7);
    const enabled = all.filter((r) => r.enabled);
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0]?.id, result.job_id);
  } finally {
    db.close();
  }
});
