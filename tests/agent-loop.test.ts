/**
 * Tests for src/computer-use/agent-loop.ts — see→plan→act→verify loop.
 *
 * Exercises the happy path (done), irreversible escalation, budget
 * exhaustion, and max-steps exhaustion — all with fakes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runComputerUse,
  AGENT_LOOP_DEFAULTS,
  type Actuator as _Actuator, // re-export chain sanity
  type AgentLoopDeps,
  type LoopCapturer,
  type LoopFrame,
  type ObservationBrief,
  type PlanResponse,
  type ProposedAction,
} from "../src/computer-use/agent-loop.js";
import type { Actuator } from "../src/computer-use/actuator.js";
import type { AuditEntry } from "../src/proactivity/audit.js";

// ────────────────────── Fakes ───────────────────────────────────────────

function makeFrame(id: string): LoopFrame {
  return {
    id,
    png_path: `/tmp/${id}.png`,
    active_app: "TestApp",
    window_title: "TestWindow",
    ts: new Date(0),
  };
}

class FakeCapturer implements LoopCapturer {
  public calls = 0;
  async captureNow(): Promise<{ ok: true; frame: LoopFrame }> {
    this.calls += 1;
    return { ok: true, frame: makeFrame(`f${this.calls}`) };
  }
}

function makeBrief(): (f: LoopFrame) => Promise<ObservationBrief> {
  return async (frame: LoopFrame): Promise<ObservationBrief> => ({
    summary: `summary for ${frame.id}`,
    active_app: frame.active_app,
    window_title: frame.window_title,
  });
}

class FakeActuator implements Actuator {
  public actions: string[] = [];
  async click(x: number, y: number, button?: "left" | "right"): Promise<void> {
    this.actions.push(`click ${x} ${y} ${button ?? "left"}`);
  }
  async doubleClick(x: number, y: number): Promise<void> {
    this.actions.push(`double ${x} ${y}`);
  }
  async moveTo(x: number, y: number): Promise<void> {
    this.actions.push(`move ${x} ${y}`);
  }
  async type(text: string): Promise<void> {
    this.actions.push(`type ${text}`);
  }
  async scroll(x: number, y: number, dy: number): Promise<void> {
    this.actions.push(`scroll ${x} ${y} ${dy}`);
  }
  async screenshot(): Promise<{ path: string; width: number; height: number }> {
    this.actions.push("screenshot");
    return { path: "/tmp/x.png", width: 1, height: 2 };
  }
}

class FakeAudit {
  public entries: AuditEntry[] = [];
  append(e: AuditEntry): void {
    this.entries.push(e);
  }
}

function scriptedPlanner(
  plans: PlanResponse[],
): AgentLoopDeps["haikuFetch"] {
  let i = 0;
  return async (): Promise<PlanResponse> => {
    if (i >= plans.length) {
      throw new Error("scriptedPlanner: ran out of scripted responses");
    }
    return plans[i++]!;
  };
}

function neverIrreversible(): AgentLoopDeps["policy"] {
  return { isIrreversible: () => false };
}

// ────────────────────── Happy path ──────────────────────────────────────

describe("runComputerUse — 3-step happy path → done", () => {
  test("executes click → type → done and returns `done`", async () => {
    const actuator = new FakeActuator();
    const capturer = new FakeCapturer();
    const audit = new FakeAudit();
    const result = await runComputerUse(
      { goal: "type hello and finish" },
      {
        actuator,
        capturer,
        brief: makeBrief(),
        policy: neverIrreversible(),
        audit,
        haikuFetch: scriptedPlanner([
          {
            plan: "click the text field first",
            action: { kind: "click", x: 10, y: 20 },
          },
          {
            plan: "type the goal into the field",
            action: { kind: "type", text: "hello" },
          },
          { plan: "goal reached", action: { kind: "done" } },
        ]),
      },
    );

    assert.equal(result.outcome, "done");
    assert.equal(result.steps.length, 3);
    assert.deepEqual(actuator.actions, ["click 10 20 left", "type hello"]);
    // Observation on step 0 → f1. Verification → f2. Step 1 re-captures f3, f4. Step 2 (done) uses f5.
    assert.equal(capturer.calls, 5);
    // Audit fires for start, each step, and done.
    const actions = audit.entries.map((e) => e.action);
    assert.ok(actions.every((a) => a === "cu_action"));
    assert.ok(audit.entries.some((e) => e.detail.includes("start goal=")));
    assert.ok(audit.entries.some((e) => e.detail.includes("done step=2")));
  });
});

// ────────────────────── Policy → escalate ───────────────────────────────

describe("runComputerUse — irreversible action → escalated", () => {
  test("policy gate fires BEFORE actuate; no actuator call", async () => {
    const actuator = new FakeActuator();
    const capturer = new FakeCapturer();
    const audit = new FakeAudit();

    // Policy treats any `type` action as irreversible for this test.
    const policy = {
      isIrreversible: (a: ProposedAction): boolean => a.kind === "type",
    };

    const result = await runComputerUse(
      { goal: "send the email" },
      {
        actuator,
        capturer,
        brief: makeBrief(),
        policy,
        audit,
        haikuFetch: scriptedPlanner([
          {
            plan: "type 'I quit' into the compose window",
            action: { kind: "type", text: "I quit" },
          },
        ]),
      },
    );

    assert.equal(result.outcome, "escalated");
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]!.verified, null); // never actuated → never verified
    assert.deepEqual(actuator.actions, []); // no actuation
    assert.ok(
      audit.entries.some((e) => e.detail.includes("escalated step=0")),
      "escalation is audited",
    );
  });
});

// ────────────────────── Budget exhaustion ──────────────────────────────

describe("runComputerUse — budget exhaustion", () => {
  test("returns `budget-exhausted` before the first action", async () => {
    const actuator = new FakeActuator();
    const capturer = new FakeCapturer();

    // `now` advances past the deadline before the first iteration.
    let t = 0;
    const result = await runComputerUse(
      { goal: "x", timeBudgetMs: 100 },
      {
        actuator,
        capturer,
        brief: makeBrief(),
        policy: neverIrreversible(),
        now: () => {
          t += 200;
          return t;
        },
        haikuFetch: scriptedPlanner([
          { plan: "n/a", action: { kind: "click", x: 0, y: 0 } },
        ]),
      },
    );

    assert.equal(result.outcome, "budget-exhausted");
    assert.equal(result.steps.length, 0);
    assert.deepEqual(actuator.actions, []);
  });
});

// ────────────────────── Max-steps enforcement ───────────────────────────

describe("runComputerUse — maxSteps enforcement", () => {
  test("stops after maxSteps with `budget-exhausted`", async () => {
    const actuator = new FakeActuator();
    const capturer = new FakeCapturer();

    const clickForever: PlanResponse[] = Array.from({ length: 50 }).map(
      (_, i) => ({
        plan: `step ${i}`,
        action: { kind: "click", x: i, y: i } as ProposedAction,
      }),
    );

    const result = await runComputerUse(
      { goal: "forever", maxSteps: 3 },
      {
        actuator,
        capturer,
        brief: makeBrief(),
        policy: neverIrreversible(),
        haikuFetch: scriptedPlanner(clickForever),
      },
    );

    assert.equal(result.outcome, "budget-exhausted");
    assert.equal(result.steps.length, 3);
    assert.equal(actuator.actions.length, 3);
  });

  test("default maxSteps is 20", async () => {
    assert.equal(AGENT_LOOP_DEFAULTS.maxSteps, 20);
  });

  test("default timeBudgetMs is 120_000", async () => {
    assert.equal(AGENT_LOOP_DEFAULTS.timeBudgetMs, 120_000);
  });
});

// ────────────────────── Planner error → blocked ─────────────────────────

describe("runComputerUse — planner failure → blocked", () => {
  test("plan throw surfaces as outcome=blocked with error", async () => {
    const actuator = new FakeActuator();
    const capturer = new FakeCapturer();

    const result = await runComputerUse(
      { goal: "x" },
      {
        actuator,
        capturer,
        brief: makeBrief(),
        policy: neverIrreversible(),
        haikuFetch: async (): Promise<PlanResponse> => {
          throw new Error("llm timeout");
        },
      },
    );

    assert.equal(result.outcome, "blocked");
    assert.match(result.error ?? "", /llm timeout/);
  });
});

// ────────────────────── Missing planner ─────────────────────────────────

describe("runComputerUse — deps validation", () => {
  test("throws when no planner is supplied", async () => {
    const actuator = new FakeActuator();
    const capturer = new FakeCapturer();
    await assert.rejects(
      () =>
        runComputerUse(
          { goal: "x" },
          {
            actuator,
            capturer,
            brief: makeBrief(),
            policy: neverIrreversible(),
          },
        ),
      /haikuFetch/,
    );
  });
});
