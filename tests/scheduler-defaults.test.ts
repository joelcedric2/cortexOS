/**
 * Phase 1.5 — Agent B
 * Tests for default cron jobs + idempotent seeder.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_JOBS,
  seedDefaults,
  isValidCronExpr,
} from "../src/scheduler/defaults.js";
import { CronJobsDB } from "../src/scheduler/cron-jobs-db.js";

function makeDb(): CronJobsDB {
  return new CronJobsDB({ dbPath: ":memory:" });
}

describe("DEFAULT_JOBS", () => {
  test("ships exactly the 6 jobs from §5.6.3", () => {
    assert.equal(DEFAULT_JOBS.length, 6);
    const names = DEFAULT_JOBS.map((j) => j.name).sort();
    assert.deepEqual(names, [
      "git_watchdog",
      "inbox_zero_friday",
      "meeting_prep",
      "memory_consolidation",
      "morning_brief",
      "skill_evolution_tick",
    ]);
  });

  test("every default job has a valid cron expression", () => {
    for (const j of DEFAULT_JOBS) {
      assert.ok(
        isValidCronExpr(j.cron_expr),
        `${j.name}: "${j.cron_expr}" should be valid cron`,
      );
    }
  });

  test("every default job ships disabled", () => {
    for (const j of DEFAULT_JOBS) {
      assert.equal(j.enabled, false, `${j.name} must be disabled by default`);
    }
  });

  test("every default job has a timezone", () => {
    for (const j of DEFAULT_JOBS) {
      assert.ok(j.timezone.length > 0, `${j.name} missing timezone`);
    }
  });

  test("every default job is marked created_by=onboarding", () => {
    for (const j of DEFAULT_JOBS) {
      assert.equal(j.created_by, "onboarding");
    }
  });

  test("specific plan-prescribed expressions match §5.6.3", () => {
    const byName = new Map(DEFAULT_JOBS.map((j) => [j.name, j]));
    assert.equal(byName.get("morning_brief")?.cron_expr, "0 8 * * *");
    assert.equal(byName.get("git_watchdog")?.cron_expr, "0 */2 * * *");
    assert.equal(byName.get("inbox_zero_friday")?.cron_expr, "0 17 * * 5");
    assert.equal(byName.get("meeting_prep")?.cron_expr, "*/10 * * * *");
    assert.equal(byName.get("skill_evolution_tick")?.cron_expr, "0 3 * * *");
    assert.equal(byName.get("memory_consolidation")?.cron_expr, "0 4 * * *");
  });
});

describe("seedDefaults — idempotent", () => {
  test("first call inserts all 6 jobs", () => {
    const db = makeDb();
    const r = seedDefaults(db);
    assert.equal(r.inserted, 6);
    assert.equal(r.skipped, 0);
    assert.equal(db.list().length, 6);
  });

  test("second call is a no-op", () => {
    const db = makeDb();
    seedDefaults(db);
    const r2 = seedDefaults(db);
    assert.equal(r2.inserted, 0);
    assert.equal(r2.skipped, 6);
    assert.equal(db.list().length, 6);
  });

  test("third call also no-op (true idempotence)", () => {
    const db = makeDb();
    seedDefaults(db);
    seedDefaults(db);
    const r3 = seedDefaults(db);
    assert.equal(r3.inserted, 0);
    assert.equal(r3.skipped, 6);
  });

  test("partial pre-existing state: only missing jobs are added", () => {
    const db = makeDb();
    // Pre-insert one job under a default name.
    db.create({
      id: "user_morning_brief",
      name: "morning_brief",
      cron_expr: "0 9 * * *", // user-customized
      task: "custom",
      enabled: true,
      timezone: "UTC",
      created_by: "user",
      next_run: null,
    });
    const r = seedDefaults(db);
    assert.equal(r.inserted, 5);
    assert.equal(r.skipped, 1);
    assert.deepEqual(r.skippedNames, ["morning_brief"]);
    // User's customization survived.
    const existing = db
      .list()
      .find((j) => j.name === "morning_brief");
    assert.equal(existing?.cron_expr, "0 9 * * *");
    assert.equal(existing?.enabled, true);
  });

  test("returns names of inserted + skipped for logging", () => {
    const db = makeDb();
    const r = seedDefaults(db);
    assert.equal(r.insertedNames.length, 6);
    assert.equal(r.skippedNames.length, 0);
    assert.ok(r.insertedNames.includes("morning_brief"));
  });
});

describe("isValidCronExpr", () => {
  test("accepts standard forms", () => {
    for (const expr of [
      "* * * * *",
      "0 8 * * *",
      "0 */2 * * *",
      "*/10 * * * *",
      "0 17 * * 5",
      "30 9 1,15 * *",
      "0 9-17 * * 1-5",
      "15 10 * * 0",
    ]) {
      assert.ok(isValidCronExpr(expr), `should accept: ${expr}`);
    }
  });

  test("rejects malformed expressions", () => {
    for (const expr of [
      "",
      "not a cron",
      "0 8 * *", // 4 fields
      "0 8 * * * *", // 6 fields
      "60 8 * * *", // minute out of range
      "0 25 * * *", // hour out of range
      "0 8 32 * *", // dom out of range
      "0 8 * 13 *", // month out of range
      "0 8 * * 8.5", // non-integer
      "0 8 * * a", // non-numeric
      "0-foo 8 * * *", // bad range
      "5-1 8 * * *", // reversed range
    ]) {
      assert.equal(isValidCronExpr(expr), false, `should reject: "${expr}"`);
    }
  });

  test("day-of-week accepts 0..7 (Sunday is both 0 and 7)", () => {
    assert.ok(isValidCronExpr("0 8 * * 0"));
    assert.ok(isValidCronExpr("0 8 * * 7"));
  });
});
