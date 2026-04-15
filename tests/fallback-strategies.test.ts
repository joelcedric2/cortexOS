/**
 * FallbackStrategy unit tests (Nchinda §2.1).
 *
 * Focused on strategy behavior in isolation — the integration tests in
 * autonomy-loop.test.ts exercise them through the full state machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RetrySameStrategy,
  AlternateToolStrategy,
  ReduceScopeStrategy,
  defaultStrategies,
} from "../src/loop/fallback-strategies.js";
import type { FallbackContext } from "../src/loop/types.js";
import type { Plan } from "../src/orchestrator/plan-schema.js";

const SAMPLE_PLAN: Plan = {
  task_id: "tid",
  goal: "g",
  complexity: "multi-agent",
  agents: [
    {
      role: "backend",
      color: "blue",
      task: "t",
      success_criteria: "s",
      budget: { max_tokens: 10, max_minutes: 1 },
      depends_on: [],
    },
  ],
  coordination: { checkpoints: [], reporting_to: "system-designer" },
};

function ctx(partial: Partial<FallbackContext>): FallbackContext {
  return {
    task: "original",
    taskId: "tid",
    attempt: 1,
    lastError: new Error("boom"),
    ...partial,
  };
}

// ─── retry-same ────────────────────────────────────────────────────────────

test("RetrySameStrategy handles transient timeouts", async () => {
  const s = new RetrySameStrategy();
  assert.equal(s.rung, 1);
  assert.equal(s.canHandle(ctx({ lastError: new Error("ETIMEDOUT") })), true);
  assert.equal(s.canHandle(ctx({ lastError: new Error("connection timed out") })), true);
  assert.equal(s.canHandle(ctx({ lastError: new Error("429 rate limit hit") })), true);
});

test("RetrySameStrategy refuses non-transient errors", async () => {
  const s = new RetrySameStrategy();
  assert.equal(s.canHandle(ctx({ lastError: new Error("schema mismatch") })), false);
  assert.equal(s.canHandle(ctx({ lastError: new Error("400 bad request") })), false);
});

test("RetrySameStrategy.apply returns handled with no task/plan changes", async () => {
  const s = new RetrySameStrategy();
  const outcome = await s.apply(ctx({ lastError: new Error("ETIMEDOUT") }));
  assert.equal(outcome.handled, true);
  assert.equal(outcome.nextTask, undefined);
  assert.equal(outcome.nextPlan, undefined);
});

// ─── alternate-tool ────────────────────────────────────────────────────────

test("AlternateToolStrategy only fires on non-transient + cached plan", () => {
  const s = new AlternateToolStrategy();
  assert.equal(s.rung, 2);
  assert.equal(
    s.canHandle(ctx({ lastError: new Error("400 bad"), lastPlan: SAMPLE_PLAN })),
    true,
  );
  assert.equal(
    s.canHandle(ctx({ lastError: new Error("ETIMEDOUT"), lastPlan: SAMPLE_PLAN })),
    false,
    "transient errors belong to rung 1",
  );
  assert.equal(
    s.canHandle(ctx({ lastError: new Error("400"), lastPlan: undefined })),
    false,
    "no plan → nothing to swap tools in",
  );
});

// ─── reduce-scope ──────────────────────────────────────────────────────────

test("ReduceScopeStrategy always applies and rewrites the task", async () => {
  const s = new ReduceScopeStrategy();
  assert.equal(s.rung, 3);
  assert.equal(s.canHandle(ctx({})), true);

  const out = await s.apply(ctx({ task: "write the whole book" }));
  assert.equal(out.handled, true);
  assert.ok(out.nextTask?.includes("smallest useful slice"));
  assert.ok(out.nextTask?.includes("write the whole book"));
  assert.equal(out.nextPlan, undefined, "drops cached plan to force re-planning");
});

// ─── defaultStrategies composition ─────────────────────────────────────────

test("defaultStrategies returns rungs 1–3 in ascending order", () => {
  const s = defaultStrategies();
  assert.equal(s.length, 3);
  assert.deepEqual(
    s.map((x) => [x.rung, x.name]),
    [
      [1, "retry-same"],
      [2, "alternate-tool"],
      [3, "reduce-scope"],
    ],
  );
});
