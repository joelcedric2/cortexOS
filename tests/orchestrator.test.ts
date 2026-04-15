import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parsePlan,
  PlanValidationError,
  type Plan,
} from "../src/orchestrator/plan-schema.js";
import {
  extractEmittedPlan,
  EMIT_PLAN_TOOL,
} from "../src/agents/claude-agent.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import { colorForRole } from "../src/config/roles.js";

// ─── parsePlan ──────────────────────────────────────────────────────────────

const VALID_PLAN: Plan = {
  task_id: "task-1",
  goal: "ship the thing",
  complexity: "multi-agent",
  agents: [
    {
      role: "coder",
      color: "blue",
      task: "implement X",
      success_criteria: "tests pass",
      budget: { max_tokens: 80_000, max_minutes: 15 },
      depends_on: [],
    },
  ],
  coordination: { checkpoints: ["on_step_complete"], reporting_to: "system-designer" },
};

describe("parsePlan", () => {
  test("accepts a valid plan", () => {
    const plan = parsePlan(VALID_PLAN);
    assert.equal(plan.task_id, "task-1");
    assert.equal(plan.agents.length, 1);
    assert.equal(plan.agents[0].color, "blue");
  });

  test("accepts optional worktree and system_prompt", () => {
    const plan = parsePlan({
      ...VALID_PLAN,
      agents: [
        {
          ...VALID_PLAN.agents[0],
          worktree: "feature/x",
          system_prompt: "be concise",
        },
      ],
    });
    assert.equal(plan.agents[0].worktree, "feature/x");
    assert.equal(plan.agents[0].system_prompt, "be concise");
  });

  test("rejects a missing top-level field", () => {
    const bad = { ...VALID_PLAN };
    // @ts-expect-error — deliberately invalid
    delete bad.goal;
    assert.throws(
      () => parsePlan(bad),
      (err: unknown) => err instanceof PlanValidationError,
    );
  });

  test("rejects an unknown color", () => {
    const bad = {
      ...VALID_PLAN,
      agents: [{ ...VALID_PLAN.agents[0], color: "chartreuse" }],
    };
    assert.throws(() => parsePlan(bad), PlanValidationError);
  });

  test("rejects an empty agents array", () => {
    const bad = { ...VALID_PLAN, agents: [] };
    assert.throws(() => parsePlan(bad), PlanValidationError);
  });

  test("rejects budget with non-positive values", () => {
    const bad = {
      ...VALID_PLAN,
      agents: [
        {
          ...VALID_PLAN.agents[0],
          budget: { max_tokens: 0, max_minutes: 10 },
        },
      ],
    };
    assert.throws(() => parsePlan(bad), PlanValidationError);
  });
});

// ─── extractEmittedPlan ─────────────────────────────────────────────────────

describe("extractEmittedPlan", () => {
  test("extracts plan JSON wrapped in emit_plan fences", () => {
    const pane = `
Some prose from the Designer.

${EMIT_PLAN_TOOL.open_tag}
${JSON.stringify(VALID_PLAN)}
${EMIT_PLAN_TOOL.close_tag}

thanks!
`;
    const plan = extractEmittedPlan(pane);
    assert.equal(plan.task_id, "task-1");
  });

  test("prefers the last emit_plan block when the Designer retries", () => {
    const second: Plan = { ...VALID_PLAN, task_id: "task-2" };
    const pane =
      `${EMIT_PLAN_TOOL.open_tag}${JSON.stringify(VALID_PLAN)}${EMIT_PLAN_TOOL.close_tag}` +
      `\n later...\n` +
      `${EMIT_PLAN_TOOL.open_tag}${JSON.stringify(second)}${EMIT_PLAN_TOOL.close_tag}`;
    const plan = extractEmittedPlan(pane);
    assert.equal(plan.task_id, "task-2");
  });

  test("throws PlanValidationError if no block present", () => {
    assert.throws(
      () => extractEmittedPlan("nothing to see"),
      PlanValidationError,
    );
  });

  test("throws PlanValidationError on malformed JSON", () => {
    const pane = `${EMIT_PLAN_TOOL.open_tag}not json at all${EMIT_PLAN_TOOL.close_tag}`;
    assert.throws(() => extractEmittedPlan(pane), PlanValidationError);
  });
});

// ─── EventBus-driven wait (orchestrator inlined) ────────────────────────────

describe("event-driven completion wait", () => {
  test("orchestrator's awaitExecutorsDone pattern resolves on 'done' events", async () => {
    const bus = createEventBus();

    const waits = [0, 1, 2].map((slot) =>
      bus.once({ kind: "done", slot, task_id: "T" }, 2_000),
    );

    // Emit `done` events for all three slots.
    for (const slot of [0, 1, 2]) {
      bus.emit({ kind: "done", slot, task_id: "T", ts: new Date() });
    }

    const events = await Promise.all(waits);
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((e) => e.slot).sort(),
      [0, 1, 2],
    );
  });

  test("bus.once rejects on timeout when no matching event arrives", async () => {
    const bus = createEventBus();
    await assert.rejects(
      bus.once({ kind: "done", slot: 99, task_id: "nope" }, 50),
      /timed out/,
    );
  });

  test("filter discriminates by task_id", async () => {
    const bus = createEventBus();
    const p = bus.once({ kind: "done", slot: 1, task_id: "wanted" }, 2_000);

    bus.emit({ kind: "done", slot: 1, task_id: "other", ts: new Date() });
    bus.emit({ kind: "done", slot: 1, task_id: "wanted", payload: { success: true }, ts: new Date() });

    const event = await p;
    assert.equal(event.task_id, "wanted");
    assert.deepEqual(event.payload, { success: true });
  });
});

// ─── colorForRole ───────────────────────────────────────────────────────────

describe("colorForRole", () => {
  test("architect and researcher → cyan", () => {
    assert.equal(colorForRole("architect"), "cyan");
    assert.equal(colorForRole("researcher"), "cyan");
    assert.equal(colorForRole("system-designer"), "cyan");
  });

  test("coder-family → blue", () => {
    assert.equal(colorForRole("coder"), "blue");
    assert.equal(colorForRole("backend"), "blue");
    assert.equal(colorForRole("frontend"), "blue");
  });

  test("tester-family → yellow", () => {
    assert.equal(colorForRole("tester"), "yellow");
    assert.equal(colorForRole("e2e-tester"), "yellow");
  });

  test("pentester → red", () => {
    assert.equal(colorForRole("pentester"), "red");
    assert.equal(colorForRole("pen-tester"), "red");
  });

  test("operator → magenta", () => {
    assert.equal(colorForRole("operator"), "magenta");
    assert.equal(colorForRole("devops-mlops"), "magenta");
  });

  test("unknown → white", () => {
    assert.equal(colorForRole("mystery-role"), "white");
    assert.equal(colorForRole(""), "white");
  });

  test("is case-insensitive", () => {
    assert.equal(colorForRole("CODER"), "blue");
    assert.equal(colorForRole("  Researcher  "), "cyan");
  });
});
