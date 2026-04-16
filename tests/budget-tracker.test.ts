/**
 * Phase 7 — Coder 3
 * BudgetTracker tests — record + snapshot round-trip, cost computation
 * per model, window totals, and listActive ordering.
 *
 * All tests use in-memory SQLite via better-sqlite3 (":memory:") through
 * the BudgetDB injection seam.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  BudgetTracker,
  costForDelta,
  MODEL_PRICES_PER_1M,
  type BudgetDB,
} from "../src/observability/budget-tracker.js";

function mkDb(): BudgetDB {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = MEMORY");
  return sqlite as unknown as BudgetDB;
}

describe("BudgetTracker", () => {
  let db: BudgetDB;
  let tracker: BudgetTracker;
  let clock: number;

  beforeEach(() => {
    db = mkDb();
    clock = Date.parse("2026-04-15T12:00:00.000Z");
    tracker = new BudgetTracker({ db, now: () => clock });
  });

  afterEach(() => {
    tracker.close();
  });

  test("record + snapshot round-trips a single event", () => {
    tracker.record({
      agentId: "A1",
      role: "coder",
      tokens_in: 1000,
      tokens_out: 500,
      duration_ms: 1234,
      tool_call: true,
      model: "haiku",
    });
    const snap = tracker.snapshot("A1");
    assert.ok(snap, "snapshot should exist");
    assert.equal(snap!.agentId, "A1");
    assert.equal(snap!.role, "coder");
    assert.equal(snap!.tokens_in, 1000);
    assert.equal(snap!.tokens_out, 500);
    assert.equal(snap!.wall_time_ms, 1234);
    assert.equal(snap!.tool_calls, 1);
    // 1000 in @ $0.80/1M + 500 out @ $4/1M = 0.0008 + 0.002 = 0.0028
    assert.equal(snap!.cost_usd, 0.0028);
  });

  test("snapshot returns null for unknown agent", () => {
    assert.equal(tracker.snapshot("nope"), null);
  });

  test("multiple records accumulate into a rolling budget", () => {
    tracker.record({
      agentId: "A2",
      role: "tester",
      tokens_in: 100,
      tokens_out: 50,
      duration_ms: 200,
      tool_call: true,
      model: "sonnet",
    });
    tracker.record({
      agentId: "A2",
      role: "tester",
      tokens_in: 400,
      tokens_out: 200,
      duration_ms: 800,
      tool_call: true,
      model: "sonnet",
    });

    const snap = tracker.snapshot("A2");
    assert.ok(snap);
    assert.equal(snap!.tokens_in, 500);
    assert.equal(snap!.tokens_out, 250);
    assert.equal(snap!.wall_time_ms, 1000);
    assert.equal(snap!.tool_calls, 2);
    // 500 in @ $3/1M + 250 out @ $15/1M = 0.0015 + 0.00375 = 0.00525
    assert.equal(snap!.cost_usd, 0.00525);
  });

  test("cost computation is model-aware", () => {
    assert.equal(costForDelta(1_000_000, 0, "haiku"), MODEL_PRICES_PER_1M.haiku.in);
    assert.equal(costForDelta(0, 1_000_000, "haiku"), MODEL_PRICES_PER_1M.haiku.out);
    assert.equal(costForDelta(1_000_000, 0, "sonnet"), MODEL_PRICES_PER_1M.sonnet.in);
    assert.equal(costForDelta(0, 1_000_000, "sonnet"), MODEL_PRICES_PER_1M.sonnet.out);
    assert.equal(costForDelta(1_000_000, 0, "opus"), MODEL_PRICES_PER_1M.opus.in);
    assert.equal(costForDelta(0, 1_000_000, "opus"), MODEL_PRICES_PER_1M.opus.out);
  });

  test("listActive returns most-recently-updated first", () => {
    tracker.record({ agentId: "older", role: "coder", tokens_in: 1, model: "haiku" });
    clock += 5_000;
    tracker.record({ agentId: "newer", role: "coder", tokens_in: 1, model: "haiku" });
    const list = tracker.listActive();
    assert.equal(list.length, 2);
    assert.equal(list[0].agentId, "newer");
    assert.equal(list[1].agentId, "older");
  });

  test("totalsInWindow sums recent activity and excludes stale rows", () => {
    // Old row, updated 10 days ago
    clock = Date.parse("2026-04-05T12:00:00.000Z");
    tracker.record({ agentId: "old", role: "coder", tokens_in: 999, tokens_out: 999, model: "opus" });

    // Recent row, updated today
    clock = Date.parse("2026-04-15T12:00:00.000Z");
    tracker.record({ agentId: "fresh", role: "coder", tokens_in: 1000, tokens_out: 500, model: "haiku" });

    const last3 = tracker.totalsInWindow(3);
    assert.equal(last3.tokens_in, 1000);
    assert.equal(last3.tokens_out, 500);
    assert.equal(last3.cost_usd, 0.0028);

    const last30 = tracker.totalsInWindow(30);
    assert.equal(last30.tokens_in, 1999);
    assert.equal(last30.tokens_out, 1499);
    // Old row: 999 @ $15/1M in + 999 @ $75/1M out = 0.00001499 + 0.000074925 ≈ 0.089915 (wait: 999/1M = 0.000999)
    // 0.000999 * 15 = 0.014985; 0.000999 * 75 = 0.074925; total = 0.08991
    // + fresh 0.0028 = 0.09271
    assert.ok(Math.abs(last30.cost_usd - 0.09271) < 1e-5, `unexpected cost ${last30.cost_usd}`);
  });

  test("record without a model still accumulates tokens at zero cost", () => {
    tracker.record({ agentId: "B", role: "planner", tokens_in: 100, tokens_out: 50 });
    const snap = tracker.snapshot("B");
    assert.ok(snap);
    assert.equal(snap!.tokens_in, 100);
    assert.equal(snap!.tokens_out, 50);
    assert.equal(snap!.cost_usd, 0);
  });

  test("record rejects missing agentId or role", () => {
    assert.throws(() =>
      tracker.record({ agentId: "", role: "coder" }),
    );
    assert.throws(() =>
      tracker.record({ agentId: "x", role: "" }),
    );
  });
});
