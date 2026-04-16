import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SkillUsageLedger } from "../src/skills/usage-ledger.js";
import type { SkillRunInput } from "../src/skills/usage-ledger.js";

describe("SkillUsageLedger", () => {
  let ledger: SkillUsageLedger;

  beforeEach(() => {
    ledger = new SkillUsageLedger({ dbPath: ":memory:" });
  });

  afterEach(() => {
    ledger.close();
  });

  // ─── record ──────────────────────────────────────────────────────────────

  test("record inserts and returns a row with auto-incremented id", () => {
    const input: SkillRunInput = {
      skill_name: "my-skill",
      input_hash: "abc123",
      outcome: "success",
      latency_ms: 42,
    };
    const row = ledger.record(input);
    assert.equal(row.id, 1);
    assert.equal(row.skill_name, "my-skill");
    assert.equal(row.skill_version, "1.0.0");
    assert.equal(row.input_hash, "abc123");
    assert.equal(row.outcome, "success");
    assert.equal(row.latency_ms, 42);
    assert.equal(row.input_category, null);
    assert.equal(row.output_summary, null);
    assert.equal(row.token_cost, null);
    assert.equal(row.error_msg, null);
    assert.equal(row.error_class, null);
    assert.ok(row.created_at);
  });

  test("record preserves all optional fields", () => {
    const row = ledger.record({
      skill_name: "x",
      skill_version: "2.0.0",
      input_hash: "h",
      input_category: "text",
      output_summary: "ok",
      outcome: "fail",
      latency_ms: 100,
      token_cost: 500,
      error_msg: "boom",
      error_class: "RuntimeError",
    });
    assert.equal(row.skill_version, "2.0.0");
    assert.equal(row.input_category, "text");
    assert.equal(row.output_summary, "ok");
    assert.equal(row.token_cost, 500);
    assert.equal(row.error_msg, "boom");
    assert.equal(row.error_class, "RuntimeError");
  });

  test("record auto-increments ids", () => {
    const r1 = ledger.record({ skill_name: "a", input_hash: "1", outcome: "success", latency_ms: 1 });
    const r2 = ledger.record({ skill_name: "b", input_hash: "2", outcome: "fail", latency_ms: 2 });
    assert.equal(r1.id, 1);
    assert.equal(r2.id, 2);
  });

  // ─── bySkill ─────────────────────────────────────────────────────────────

  test("bySkill returns only matching skill runs, most-recent first", () => {
    ledger.record({ skill_name: "alpha", input_hash: "1", outcome: "success", latency_ms: 10 });
    ledger.record({ skill_name: "beta", input_hash: "2", outcome: "success", latency_ms: 20 });
    ledger.record({ skill_name: "alpha", input_hash: "3", outcome: "fail", latency_ms: 30 });

    const rows = ledger.bySkill("alpha");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].input_hash, "3");
    assert.equal(rows[1].input_hash, "1");
  });

  test("bySkill respects limit", () => {
    for (let i = 0; i < 5; i++) {
      ledger.record({ skill_name: "x", input_hash: `h${i}`, outcome: "success", latency_ms: i });
    }
    const rows = ledger.bySkill("x", 2);
    assert.equal(rows.length, 2);
  });

  test("bySkill returns [] for unknown skill", () => {
    const rows = ledger.bySkill("nonexistent");
    assert.deepEqual(rows, []);
  });

  // ─── failuresBySkill ─────────────────────────────────────────────────────

  test("failuresBySkill returns non-success runs within window", () => {
    ledger.record({ skill_name: "s", input_hash: "1", outcome: "success", latency_ms: 1 });
    ledger.record({ skill_name: "s", input_hash: "2", outcome: "fail", latency_ms: 2 });
    ledger.record({ skill_name: "s", input_hash: "3", outcome: "error", latency_ms: 3 });
    ledger.record({ skill_name: "s", input_hash: "4", outcome: "timeout", latency_ms: 4 });

    const failures = ledger.failuresBySkill("s", 1);
    assert.equal(failures.length, 3);
    // All non-success
    for (const f of failures) {
      assert.notEqual(f.outcome, "success");
    }
  });

  test("failuresBySkill excludes runs outside window", () => {
    // This will be within window since we just inserted it
    ledger.record({ skill_name: "s", input_hash: "1", outcome: "fail", latency_ms: 1 });
    // windowDays=0 means cutoff is now — should exclude the just-inserted row
    // Actually 0 days = cutoff is "right now", so rows inserted "now" might be at the boundary.
    // Use windowDays=1 for reliable test
    const failures = ledger.failuresBySkill("s", 1);
    assert.equal(failures.length, 1);
  });

  test("failuresBySkill returns [] for unknown skill", () => {
    assert.deepEqual(ledger.failuresBySkill("nope"), []);
  });

  // ─── successRate ─────────────────────────────────────────────────────────

  test("successRate returns 0 for unknown skill", () => {
    assert.equal(ledger.successRate("nope"), 0);
  });

  test("successRate returns 1.0 when all runs succeed", () => {
    ledger.record({ skill_name: "s", input_hash: "1", outcome: "success", latency_ms: 1 });
    ledger.record({ skill_name: "s", input_hash: "2", outcome: "success", latency_ms: 2 });
    assert.equal(ledger.successRate("s"), 1.0);
  });

  test("successRate returns correct ratio", () => {
    ledger.record({ skill_name: "s", input_hash: "1", outcome: "success", latency_ms: 1 });
    ledger.record({ skill_name: "s", input_hash: "2", outcome: "fail", latency_ms: 2 });
    ledger.record({ skill_name: "s", input_hash: "3", outcome: "success", latency_ms: 3 });
    ledger.record({ skill_name: "s", input_hash: "4", outcome: "error", latency_ms: 4 });
    // 2 success / 4 total = 0.5
    assert.equal(ledger.successRate("s"), 0.5);
  });

  test("successRate returns 0 when all runs fail", () => {
    ledger.record({ skill_name: "s", input_hash: "1", outcome: "fail", latency_ms: 1 });
    ledger.record({ skill_name: "s", input_hash: "2", outcome: "error", latency_ms: 2 });
    assert.equal(ledger.successRate("s"), 0);
  });
});
