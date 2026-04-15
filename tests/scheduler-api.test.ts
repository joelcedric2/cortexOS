/**
 * Phase 1.5 — Agent B
 * Unit tests for src/scheduler/api.ts CRUD surface.
 * Round-trips go through the handler functions directly (no socket).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  cronList,
  cronCreate,
  cronUpdate,
  cronEnable,
  cronDisable,
  cronDelete,
  cronHistory,
} from "../src/scheduler/api.js";
import { CronJobsDB } from "../src/scheduler/cron-jobs-db.js";

function makeDb(): CronJobsDB {
  return new CronJobsDB({ dbPath: ":memory:" });
}

const validInput = {
  name: "hourly_check",
  cron_expr: "0 * * * *",
  task: "do a thing",
  enabled: false,
  timezone: "UTC",
  created_by: "user" as const,
};

describe("cronCreate", () => {
  test("inserts a valid job and returns the row", () => {
    const db = makeDb();
    const row = cronCreate(db, validInput);
    assert.equal(row.name, "hourly_check");
    assert.equal(row.cron_expr, "0 * * * *");
    assert.ok(row.id.startsWith("cron_"));
  });

  test("rejects invalid cron_expr", () => {
    const db = makeDb();
    assert.throws(() => cronCreate(db, { ...validInput, cron_expr: "bad cron" }));
  });

  test("rejects empty task", () => {
    const db = makeDb();
    assert.throws(() => cronCreate(db, { ...validInput, task: "" }));
  });

  test("rejects unknown created_by", () => {
    const db = makeDb();
    assert.throws(() =>
      cronCreate(db, { ...validInput, created_by: "random_source" }),
    );
  });

  test("defaults enabled=false and timezone when omitted", () => {
    const db = makeDb();
    const { enabled, timezone, ...rest } = validInput;
    void enabled;
    void timezone;
    const row = cronCreate(db, rest);
    assert.equal(row.enabled, false);
    assert.equal(row.timezone, "America/New_York");
  });
});

describe("cronList", () => {
  test("returns all persisted rows", () => {
    const db = makeDb();
    cronCreate(db, validInput);
    cronCreate(db, { ...validInput, name: "other" });
    const all = cronList(db);
    assert.equal(all.length, 2);
  });
});

describe("cronUpdate", () => {
  test("patches an existing job", () => {
    const db = makeDb();
    const row = cronCreate(db, validInput);
    const updated = cronUpdate(db, row.id, { task: "new task" });
    assert.equal(updated.task, "new task");
    assert.equal(updated.cron_expr, "0 * * * *");
  });

  test("rejects empty patch", () => {
    const db = makeDb();
    const row = cronCreate(db, validInput);
    assert.throws(() => cronUpdate(db, row.id, {}));
  });

  test("rejects unknown id", () => {
    const db = makeDb();
    assert.throws(() => cronUpdate(db, "cron_nope", { task: "x" }));
  });

  test("validates cron_expr on update", () => {
    const db = makeDb();
    const row = cronCreate(db, validInput);
    assert.throws(() => cronUpdate(db, row.id, { cron_expr: "trash" }));
  });
});

describe("cronEnable / cronDisable", () => {
  test("toggle enabled flag", () => {
    const db = makeDb();
    const row = cronCreate(db, validInput);
    assert.equal(row.enabled, false);
    const on = cronEnable(db, row.id);
    assert.equal(on.enabled, true);
    const off = cronDisable(db, row.id);
    assert.equal(off.enabled, false);
  });
});

describe("cronDelete", () => {
  test("removes a row", () => {
    const db = makeDb();
    const row = cronCreate(db, validInput);
    const out = cronDelete(db, row.id);
    assert.equal(out.id, row.id);
    assert.equal(cronList(db).length, 0);
  });

  test("throws on unknown id", () => {
    const db = makeDb();
    assert.throws(() => cronDelete(db, "cron_nope"));
  });
});

describe("cronHistory", () => {
  test("returns job + run history (most-recent first)", () => {
    const db = makeDb();
    const row = cronCreate(db, validInput);
    const t1 = new Date("2026-05-01T12:00:00Z");
    const t2 = new Date("2026-05-01T12:05:00Z");
    db.markRan(row.id, "success", 120, "ok", t1);
    db.markRan(row.id, "fail", 500, "boom", t2);
    const h = cronHistory(db, row.id);
    assert.equal(h.job.id, row.id);
    assert.equal(h.runs.length, 2);
    // runsByJob returns most recent first.
    assert.equal(h.runs[0]?.outcome, "fail");
    assert.equal(h.runs[0]?.duration_ms, 500);
    assert.equal(h.runs[1]?.outcome, "success");
    assert.match(h.runs[0]?.run_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  });

  test("empty history for fresh job", () => {
    const db = makeDb();
    const row = cronCreate(db, validInput);
    const h = cronHistory(db, row.id);
    assert.equal(h.runs.length, 0);
  });

  test("throws on unknown id", () => {
    const db = makeDb();
    assert.throws(() => cronHistory(db, "cron_nope"));
  });
});
