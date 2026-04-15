/**
 * Orchestrator.executeOnce — Phase 2 integration seam.
 *
 * Proves that the new single-attempt path spawns executors per the Plan,
 * waits on 'done' events, and returns a structured `OrchestratorResult`
 * without touching the Designer pipeline. This is what the AutonomyLoop
 * composes around.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import type { Plan } from "../src/orchestrator/plan-schema.js";
import { resetInstanceCounter } from "../src/agents/roles.js";

// Minimal fakes — identical shape to the Phase 1 DoD test's fakes.
class FakeController {
  public readonly handles = new Map<number, { sessionName: string }>();
  public readonly spawned: Array<{ slot: number; role: string }> = [];
  private nextSlot = 1;
  async spawnAgent(role: string, _provider: string): Promise<number> {
    const slot = this.nextSlot++;
    this.handles.set(slot, { sessionName: `slot${slot}_${role}` });
    this.spawned.push({ slot, role });
    return slot;
  }
  async sendMessage(): Promise<void> {}
}
class FakeTmux {
  async capturePane(): Promise<string> { return ""; }
  async sendKeys(): Promise<void> {}
  async sendKeysRaw(): Promise<void> {}
  async setPaneBorderColor(): Promise<void> {}
}

function makePlan(taskId: string): Plan {
  return {
    task_id: taskId,
    goal: "g",
    complexity: "multi-agent",
    agents: [
      {
        role: "backend",
        color: "blue",
        task: "write x",
        success_criteria: "y",
        budget: { max_tokens: 1000, max_minutes: 5 },
        depends_on: [],
      },
      {
        role: "e2e-tester",
        color: "yellow",
        task: "test it",
        success_criteria: "green",
        budget: { max_tokens: 500, max_minutes: 5 },
        depends_on: [],
      },
    ],
    coordination: { checkpoints: [], reporting_to: "system-designer" },
  };
}

test("Orchestrator.executeOnce returns success when every executor emits a done event", async () => {
  resetInstanceCounter("backend");
  resetInstanceCounter("e2e-tester");

  const bus = createEventBus();
  const registry = new AgentRegistry({ dbPath: ":memory:" });
  const controller = new FakeController();
  const tmux = new FakeTmux();

  const orch = new Orchestrator(
    controller as unknown as import("../src/controller/cortex.js").CortexController,
    tmux as unknown as import("../src/tmux/tmux-manager.js").TmuxManager,
    {
      bus,
      registry,
      waitForReady: async () => {},
      openTerminal: async () => {},
      capturePaneOutput: async () => "",
      doneTimeoutMs: 2_000,
    },
  );

  const plan = makePlan("tid-exec-once-1");
  const run = orch.executeOnce(plan, "tid-exec-once-1");

  // Give the orchestrator a tick to spawn + subscribe before we emit.
  await new Promise((r) => setImmediate(r));
  for (const { slot } of controller.spawned) {
    bus.emit({
      kind: "done",
      slot,
      task_id: "tid-exec-once-1",
      payload: { success: true },
      ts: new Date(),
    });
  }

  const result = await run;
  assert.equal(result.success, true);
  assert.equal(result.taskId, "tid-exec-once-1");

  const rows = registry.list();
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.status, "done");
  registry.close();
});

test("Orchestrator.executeOnce returns success:false with an error summary when an executor fails", async () => {
  resetInstanceCounter("backend");
  resetInstanceCounter("e2e-tester");

  const bus = createEventBus();
  const registry = new AgentRegistry({ dbPath: ":memory:" });
  const controller = new FakeController();
  const tmux = new FakeTmux();

  const orch = new Orchestrator(
    controller as unknown as import("../src/controller/cortex.js").CortexController,
    tmux as unknown as import("../src/tmux/tmux-manager.js").TmuxManager,
    {
      bus,
      registry,
      waitForReady: async () => {},
      openTerminal: async () => {},
      capturePaneOutput: async () => "",
      doneTimeoutMs: 2_000,
    },
  );

  const plan = makePlan("tid-exec-once-2");
  const run = orch.executeOnce(plan, "tid-exec-once-2");

  await new Promise((r) => setImmediate(r));
  const [first, second] = controller.spawned;
  bus.emit({
    kind: "done",
    slot: first.slot,
    task_id: "tid-exec-once-2",
    payload: { success: true },
    ts: new Date(),
  });
  bus.emit({
    kind: "done",
    slot: second.slot,
    task_id: "tid-exec-once-2",
    payload: { success: false, error: "broke on line 42" },
    ts: new Date(),
  });

  const result = await run;
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("broke on line 42"));

  const statuses = registry.list().map((r) => r.status).sort();
  assert.deepEqual(statuses, ["done", "error"]);
  registry.close();
});

test("Orchestrator.executeOnce short-circuits on single-shot plans", async () => {
  const bus = createEventBus();
  const registry = new AgentRegistry({ dbPath: ":memory:" });
  const controller = new FakeController();
  const tmux = new FakeTmux();

  const orch = new Orchestrator(
    controller as unknown as import("../src/controller/cortex.js").CortexController,
    tmux as unknown as import("../src/tmux/tmux-manager.js").TmuxManager,
    { bus, registry, waitForReady: async () => {}, openTerminal: async () => {}, capturePaneOutput: async () => "" },
  );

  const plan: Plan = {
    ...makePlan("tid-exec-once-3"),
    complexity: "single-shot",
    agents: [makePlan("tid-exec-once-3").agents[0]], // zod requires >=1 agent; complexity=single-shot still short-circuits
  };
  const result = await orch.executeOnce(plan, "tid-exec-once-3");
  assert.equal(result.success, true);
  assert.equal(controller.spawned.length, 0, "no executors should be spawned for single-shot");
  registry.close();
});
