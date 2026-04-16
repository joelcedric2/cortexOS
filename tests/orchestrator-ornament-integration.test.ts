/**
 * Orchestrator ↔ PaneOrnamentManager integration seam (Phase 11).
 *
 * Asserts:
 *   • `executeOnce` fire-and-forgets `syncWithAgents` after spawning executors.
 *   • After terminal transitions, it re-syncs so finished agents get cleared.
 *   • When no `ornamentManager` is provided, back-compat holds (no crash, no sync).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import type { Plan } from "../src/orchestrator/plan-schema.js";
import { resetInstanceCounter } from "../src/agents/roles.js";
import type {
  PaneOrnamentManager,
  Ornament,
  AgentRoleColor,
} from "../src/window-manager/pane-ornaments.js";

// ─── Fakes (identical shape to the Phase 2 DoD test) ─────────────────────────

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

class FakeOrnamentManager
  implements Pick<PaneOrnamentManager, "syncWithAgents" | "clear">
{
  public syncCalls: Array<Array<{ id: string; role: string; status?: string }>> = [];
  public clearCalls: number[] = [];
  async syncWithAgents(
    agents: readonly { id: string; role: string; status?: string }[],
  ): Promise<void> {
    this.syncCalls.push(agents.map((a) => ({ ...a })));
  }
  async clear(windowId: number): Promise<void> {
    this.clearCalls.push(windowId);
  }
  // Unused members that make this compatible with the full shape in tests.
  async apply(_id: number, _c: AgentRoleColor): Promise<void> {}
  list(): Ornament[] { return []; }
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Orchestrator + PaneOrnamentManager", () => {
  test("executeOnce triggers syncWithAgents after spawn and after terminal", async () => {
    resetInstanceCounter("backend");
    resetInstanceCounter("e2e-tester");

    const bus = createEventBus();
    const registry = new AgentRegistry({ dbPath: ":memory:" });
    const controller = new FakeController();
    const tmux = new FakeTmux();
    const ornaments = new FakeOrnamentManager();

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
        ornamentManager: ornaments,
      },
    );

    const plan = makePlan("tid-ornament-1");
    const run = orch.executeOnce(plan, "tid-ornament-1");

    // Let spawns + fire-and-forget sync happen before we emit done events.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    for (const { slot } of controller.spawned) {
      bus.emit({
        kind: "done",
        slot,
        task_id: "tid-ornament-1",
        payload: { success: true },
        ts: new Date(),
      });
    }

    const result = await run;
    assert.equal(result.success, true);

    // Let the post-terminal fire-and-forget sync resolve.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.ok(ornaments.syncCalls.length >= 2, `expected >=2 syncs, got ${ornaments.syncCalls.length}`);

    // First sync fired after spawn — agents should be in a non-terminal state.
    const first = ornaments.syncCalls[0];
    assert.equal(first.length, 2);
    for (const a of first) {
      assert.ok(a.status === "running" || a.status === "spawning", `unexpected early status: ${a.status}`);
    }

    // Last sync fires after terminal transitions — both agents should be done.
    const last = ornaments.syncCalls[ornaments.syncCalls.length - 1];
    const statuses = last.map((a) => a.status).sort();
    assert.deepEqual(statuses, ["done", "done"]);
    registry.close();
  });

  test("kill path: terminal transitions reach the ornament sync so stale borders clear", async () => {
    resetInstanceCounter("backend");
    resetInstanceCounter("e2e-tester");

    const bus = createEventBus();
    const registry = new AgentRegistry({ dbPath: ":memory:" });
    const controller = new FakeController();
    const tmux = new FakeTmux();
    const ornaments = new FakeOrnamentManager();

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
        ornamentManager: ornaments,
      },
    );

    const plan = makePlan("tid-ornament-2");
    const run = orch.executeOnce(plan, "tid-ornament-2");

    await new Promise((r) => setImmediate(r));
    // Kill one, succeed the other.
    const [first, second] = controller.spawned;
    bus.emit({
      kind: "done",
      slot: first.slot,
      task_id: "tid-ornament-2",
      payload: { success: false, error: "crashed" },
      ts: new Date(),
    });
    bus.emit({
      kind: "done",
      slot: second.slot,
      task_id: "tid-ornament-2",
      payload: { success: true },
      ts: new Date(),
    });

    const result = await run;
    assert.equal(result.success, false);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // The final sync should carry one 'error' and one 'done' status — both
    // non-running, so PaneOrnamentManager will clear their ornaments.
    const last = ornaments.syncCalls[ornaments.syncCalls.length - 1];
    const statuses = last.map((a) => a.status).sort();
    assert.deepEqual(statuses, ["done", "error"]);
    registry.close();
  });

  test("back-compat: no ornamentManager → orchestrator runs normally and never crashes", async () => {
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
        // ornamentManager deliberately omitted
      },
    );

    const plan = makePlan("tid-ornament-3");
    const run = orch.executeOnce(plan, "tid-ornament-3");

    await new Promise((r) => setImmediate(r));
    for (const { slot } of controller.spawned) {
      bus.emit({
        kind: "done",
        slot,
        task_id: "tid-ornament-3",
        payload: { success: true },
        ts: new Date(),
      });
    }

    const result = await run;
    assert.equal(result.success, true);
    registry.close();
  });
});
