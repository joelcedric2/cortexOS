/**
 * Phase 3 — Agent A
 * Tests for the `escalations` SQLite wrapper. In-memory DB only; exercises
 * CRUD + resolve lifecycle.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EscalationsDB } from "../src/mcp/escalations-db.js";

describe("EscalationsDB", () => {
  let db: EscalationsDB;

  beforeEach(() => {
    db = new EscalationsDB({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
  });

  test("create inserts a pending row with defaulted level", () => {
    const row = db.create({ question: "Is the EU AI Act rollout on track?" });
    assert.ok(row.id.startsWith("esc_"), "id should carry the esc_ prefix");
    assert.equal(row.question, "Is the EU AI Act rollout on track?");
    assert.equal(row.level, "question");
    assert.equal(row.resolved, false);
    assert.equal(row.resolved_by, null);
    assert.equal(row.resolution, null);
    assert.equal(row.resolved_at, null);
    assert.equal(row.task_id, null);
    assert.equal(row.agent_id, null);
    assert.ok(row.created_at, "created_at should be populated");
  });

  test("create persists explicit level + task_id + agent_id", () => {
    const row = db.create({
      question: "Production DB is down, retry?",
      level: "blocker",
      task_id: "task-42",
      agent_id: "DEV0",
    });
    assert.equal(row.level, "blocker");
    assert.equal(row.task_id, "task-42");
    assert.equal(row.agent_id, "DEV0");
  });

  test("getById returns the same shape as create", () => {
    const inserted = db.create({ question: "Commit or stash?", level: "info" });
    const fetched = db.getById(inserted.id);
    assert.deepEqual(fetched, inserted);
  });

  test("getById returns undefined for an unknown id", () => {
    assert.equal(db.getById("esc_missing"), undefined);
  });

  test("list returns rows most-recent-first", async () => {
    db.create({ id: "esc_a", question: "first" });
    // Small delay so CURRENT_TIMESTAMP moves (SQLite second-precision).
    await new Promise((r) => setTimeout(r, 1100));
    db.create({ id: "esc_b", question: "second" });
    const all = db.list();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, "esc_b");
    assert.equal(all[1].id, "esc_a");
  });

  test("listPending omits resolved rows", () => {
    const r1 = db.create({ id: "esc_p1", question: "pending-1" });
    const r2 = db.create({ id: "esc_p2", question: "to-resolve" });
    db.create({ id: "esc_p3", question: "pending-3" });
    db.resolve(r2.id, { resolution: "yes", resolved_by: "user" });

    const pending = db.listPending();
    const ids = pending.map((p) => p.id).sort();
    assert.deepEqual(ids, ["esc_p1", "esc_p3"]);
    // Sanity: r1 + r2 still visible via list()
    assert.equal(db.list().length, 3);
  });

  test("resolve marks the row resolved and stamps resolution + resolver", () => {
    const inserted = db.create({ question: "deploy staging?" });
    const resolved = db.resolve(inserted.id, {
      resolution: "yes, proceed",
      resolved_by: "user",
    });
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.resolution, "yes, proceed");
    assert.equal(resolved.resolved_by, "user");
    assert.ok(resolved.resolved_at, "resolved_at should be populated");
  });

  test("resolve on a missing id throws", () => {
    assert.throws(
      () => db.resolve("esc_nope", { resolution: "x", resolved_by: "user" }),
      /no escalation with id/,
    );
  });

  test("explicit id is honored", () => {
    const row = db.create({ id: "esc_custom", question: "..." });
    assert.equal(row.id, "esc_custom");
    assert.equal(db.getById("esc_custom")?.question, "...");
  });
});
