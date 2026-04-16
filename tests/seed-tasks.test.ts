/**
 * Phase 7 — Coder 3
 * DEFAULT_STRESS_TASKS shape tests. Asserts the 40/40/20 distribution,
 * non-empty fields on every task, uniqueness of task ids, and the
 * presence of at least 3 escalation-acceptable entries.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STRESS_TASKS } from "../src/bench/seed-tasks.js";

describe("DEFAULT_STRESS_TASKS", () => {
  test("has exactly 100 tasks", () => {
    assert.equal(DEFAULT_STRESS_TASKS.length, 100);
  });

  test("has distribution 40 simple / 40 moderate / 20 complex", () => {
    const counts = { simple: 0, moderate: 0, complex: 0 };
    for (const t of DEFAULT_STRESS_TASKS) counts[t.complexity] += 1;
    assert.equal(counts.simple, 40);
    assert.equal(counts.moderate, 40);
    assert.equal(counts.complex, 20);
  });

  test("every task has required fields populated", () => {
    for (const t of DEFAULT_STRESS_TASKS) {
      assert.ok(typeof t.id === "string" && t.id.length > 0, `bad id: ${JSON.stringify(t)}`);
      assert.ok(typeof t.task === "string" && t.task.trim().length > 10, `task too short: ${t.id}`);
      assert.ok(["simple", "moderate", "complex"].includes(t.complexity));
      assert.ok(["success", "escalation-acceptable"].includes(t.expectedOutcome));
      assert.ok(
        Number.isInteger(t.expectedMaxAttempts) && t.expectedMaxAttempts >= 1,
        `bad expectedMaxAttempts on ${t.id}`,
      );
    }
  });

  test("task ids are unique", () => {
    const ids = new Set<string>();
    for (const t of DEFAULT_STRESS_TASKS) {
      assert.ok(!ids.has(t.id), `duplicate id: ${t.id}`);
      ids.add(t.id);
    }
  });

  test("has at least 3 escalation-acceptable tasks", () => {
    const escalations = DEFAULT_STRESS_TASKS.filter(
      (t) => t.expectedOutcome === "escalation-acceptable",
    );
    assert.ok(
      escalations.length >= 3,
      `expected ≥3 escalations, got ${escalations.length}`,
    );
    assert.ok(escalations.length <= 10, "escalations should be a minority");
  });
});
