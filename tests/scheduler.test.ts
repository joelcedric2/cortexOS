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
