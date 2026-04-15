/**
 * Phase 1 Definition of Done — end-to-end smoke test (Nchinda plan §6 Phase 1).
 *
 *   "Spawn an architect, have it emit a JSON plan, spawn 2 executors, they
 *    all report via Stop hook, registry reflects it, no timeouts used."
 *
 * What this test proves:
 *  1. The Designer (RES0) is spawned via the controller, registered, and
 *     transitions to `running`.
 *  2. Its `emit_plan` output (here simulated via a `plan_emitted` bus event,
 *     which is the contract Agent A reserves for plan emission) is parsed
 *     against the zod Plan schema.
 *  3. Two executor agents are spawned per the Plan, each persisted in the
 *     AgentRegistry with status `running`.
 *  4. Stop hook events delivered via the real HTTP hooks server
 *     (`POST /hooks/stop`) drive the orchestrator to completion — no
 *     polling, no timeouts — by fanning out `done` events on the shared bus.
 *  5. The registry reflects the `running → done` transitions for every agent,
 *     including the Designer (which `markDone`s itself after consolidation).
 *
 * This test deliberately uses the real `startHooksServer`, the real
 * `AgentRegistry` (in-memory), the real `createEventBus`, and the real
 * `parsePlan` — the only fakes are `CortexController` (to avoid tmux/osascript)
 * and `TmuxManager` (ditto). That keeps the integration honest while letting
 * us run in CI without a GUI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import { openEventsDB } from "../src/ipc/events-db.js";
import { startHooksServer } from "../src/ipc/server.js";
import type { Plan } from "../src/orchestrator/plan-schema.js";
import { resetInstanceCounter } from "../src/agents/roles.js";

// ─── Fakes ──────────────────────────────────────────────────────────────────

/**
 * Minimum surface of `CortexController` that `Orchestrator` pokes at:
 *  - `spawnAgent(role, provider, slot?) → slot`
 *  - `sendMessage(slot, message)`
 *  - `handles: Map<slot, { sessionName }>`  (read via a duck-type cast)
 *
 * We also expose `onSpawn`/`onMessage` callbacks so the test can drive the
 * orchestrator forward at the right moments.
 */
class FakeController {
  public readonly handles = new Map<number, { sessionName: string }>();
  public readonly spawned: Array<{ role: string; provider: string; slot: number }> = [];
  public readonly messages: Array<{ slot: number; message: string }> = [];
  public onSpawn?: (role: string, provider: string, slot: number) => void;
  public onMessage?: (slot: number, message: string) => void;
  private nextSlot = 0;

  async spawnAgent(
    role: string,
    provider: string,
    requestedSlot?: number,
  ): Promise<number> {
    const slot = requestedSlot ?? this.nextSlot;
    this.nextSlot = Math.max(this.nextSlot, slot + 1);
    const sessionName = `slot${slot}_${role}`;
    this.handles.set(slot, { sessionName });
    this.spawned.push({ role, provider, slot });
    this.onSpawn?.(role, provider, slot);
    return slot;
  }

  async sendMessage(slot: number, message: string): Promise<void> {
    this.messages.push({ slot, message });
    this.onMessage?.(slot, message);
  }
}

/**
 * TmuxManager is only read via `capturePane` when the orchestrator falls back
 * to pane scraping. We bypass that path entirely with the `capturePaneOutput`
 * override, so this fake never actually runs.
 */
class FakeTmux {
  async capturePane(_session: string, _lines?: number): Promise<string> {
    return "";
  }
  async sendKeys(): Promise<void> {}
  async sendKeysRaw(): Promise<void> {}
  async setPaneBorderColor(): Promise<void> {}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPlan(taskId: string): Plan {
  return {
    task_id: taskId,
    goal: "implement the thing and test it",
    complexity: "multi-agent",
    agents: [
      {
        role: "backend",
        color: "blue",
        task: "write the backend handler",
        success_criteria: "handler returns 200 with JSON body",
        budget: { max_tokens: 80_000, max_minutes: 15 },
        depends_on: [],
      },
      {
        role: "e2e-tester",
        color: "yellow",
        task: "write an e2e test for the handler",
        success_criteria: "test passes locally",
        budget: { max_tokens: 40_000, max_minutes: 10 },
        depends_on: [],
      },
    ],
    coordination: {
      checkpoints: ["on_step_complete"],
      reporting_to: "system-designer",
    },
  };
}

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cortexos-phase1-dod-"));
  return join(dir, "events.db");
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * Resolve once `pred()` returns a truthy value, polling at a short interval.
 * Rejects after `timeoutMs` with a helpful message. Used by the harness to
 * await state changes the orchestrator makes synchronously in the registry
 * (which don't necessarily produce bus events themselves).
 */
async function waitForCondition<T>(
  pred: () => T | undefined,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitForCondition: timeout after ${timeoutMs}ms — ${description}`);
}

// ─── The DoD test ───────────────────────────────────────────────────────────

test("Phase 1 DoD: architect emits plan, 2 executors run, all report via Stop hook, no timeouts", async () => {
  // Reset role counters so agent IDs (RES0, BKD0, E2E0, ...) are deterministic.
  resetInstanceCounter("system-designer");
  resetInstanceCounter("backend");
  resetInstanceCounter("e2e-tester");

  // ── Shared infrastructure ─────────────────────────────────────────────────
  const bus = createEventBus();
  const registry = new AgentRegistry({ dbPath: ":memory:" });
  const db = await openEventsDB(tmpDbPath());
  const hooksServer = await startHooksServer({ bus, db, port: 0 });

  const tmux = new FakeTmux();
  const controller = new FakeController();

  // We'll seed the Designer's plan via `plan_emitted` once the orchestrator
  // has spawned it (and thus registered res0Slot in controller.handles).
  const TASK = "build an endpoint and test it";

  // Instead of reaching into the orchestrator's private `taskId`, we capture
  // it from the first registry row that appears (the Designer's).
  const designerReady = new Promise<string>((resolve) => {
    controller.onMessage = (slot, msg) => {
      if (slot === 0 && msg.includes("RES0") && msg.includes("Task ID")) {
        // Extract task_id from the Designer's planning prompt.
        const match = /Task ID: ([0-9a-f-]+)/i.exec(msg);
        if (match) resolve(match[1]);
      }
    };
  });

  try {
    const orchestrator = new Orchestrator(
      // duck-typed casts — we only implement the methods the orchestrator uses
      controller as unknown as import("../src/controller/cortex.js").CortexController,
      tmux as unknown as import("../src/tmux/tmux-manager.js").TmuxManager,
      {
        bus,
        registry,
        waitForReady: async () => {}, // skip tmux readiness polling
        openTerminal: async () => {}, // skip osascript / macOS Terminal
        capturePaneOutput: async () => "", // never reached — plan comes via bus
        doneTimeoutMs: 5_000,
        designerTimeoutMs: 5_000,
      },
    );

    // Kick off the orchestrator in the background.
    const run = orchestrator.execute(TASK);

    // ── 1. Wait for the Designer to be spawned and planning-prompted ───────
    const taskId = await Promise.race([
      designerReady,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("Designer planning prompt never arrived")), 3_000),
      ),
    ]);
    assert.ok(taskId, "Designer prompt should include a task_id");

    // Registry must reflect the Designer as `running`.
    const res0Row = registry.list().find((r) => r.id === "RES0");
    assert.ok(res0Row, "RES0 must be in the registry after spawn");
    assert.equal(res0Row.role, "system-designer");
    assert.equal(res0Row.status, "running");
    assert.equal(res0Row.task_id, taskId);

    // ── 2. Mock the Designer's emit_plan by publishing `plan_emitted` ──────
    // Give the orchestrator a tick to reach `awaitPlan` and subscribe via
    // `bus.once` before we emit. `bus.once` is not latched — a pre-subscribe
    // emit is lost — so we intentionally schedule this after a macrotask.
    const plan = buildPlan(taskId);
    await new Promise((r) => setImmediate(r));
    bus.emit({
      kind: "plan_emitted",
      slot: 0,
      task_id: taskId,
      payload: plan,
      ts: new Date(),
    });

    // ── 3. Wait until both executors are spawned (Plan → 2 agents) ─────────
    await waitForCondition(
      () => {
        const execs = registry.list().filter((r) => r.id !== "RES0");
        return execs.length === 2 ? execs : undefined;
      },
      3_000,
      "two executor rows should appear in the registry",
    );

    // Poll briefly for markRunning (orchestrator calls it synchronously after
    // spawn, but the async ordering means we double-check here).
    const executors = registry.list().filter((r) => r.id !== "RES0");
    assert.equal(executors.length, 2, "exactly two executors should be registered");
    for (const ex of executors) {
      assert.equal(ex.status, "running", `${ex.id} should be running`);
      assert.equal(ex.task_id, taskId);
      assert.ok(ex.tmux_session, "executor rows must carry a tmux_session");
    }

    // The plan said backend + e2e-tester.
    const planRoles = executors.map((e) => e.role).sort();
    assert.deepEqual(planRoles, ["backend", "e2e-tester"]);
    assert.deepEqual(
      executors.map((e) => e.color).sort(),
      ["blue", "yellow"],
    );

    // Controller should have been asked to spawn 3 agents total: 1 designer + 2 executors.
    assert.equal(controller.spawned.length, 3);
    assert.equal(controller.spawned[0].role, "system-designer");

    // ── 4. Each executor reports completion via the REAL Stop hook ─────────
    // This hits http://127.0.0.1:<port>/hooks/stop, which inserts into the
    // events DB and fans out a `done` event on the shared bus — exactly what
    // Claude Code would do in production.
    for (const ex of executors) {
      const slot = controller.spawned.find((s) => s.role === ex.role)!.slot;
      const { status, body } = await postJson(hooksServer.port, "/hooks/stop", {
        session_id: ex.tmux_session,
        agent_id: ex.id,
        slot,
        task_id: taskId, // critical: orchestrator filters bus.once on task_id
        transcript_tail: `${ex.id} wrote its thing`,
        exit_reason: "stop",
        ts: new Date().toISOString(),
      });
      assert.equal(status, 200);
      assert.deepEqual(body, { ok: true });
    }

    // ── 5. Wait for the orchestrator to finish; verify no timeout fired ────
    // `run` returning (as opposed to rejecting on the 5s timeout) is itself
    // evidence that Stop hook events drove completion.
    await run;

    // ── 6. Registry reflects `running → done` for everyone ─────────────────
    const final = registry.list();
    assert.equal(final.length, 3, "registry should have Designer + 2 executors");
    for (const row of final) {
      assert.equal(
        row.status,
        "done",
        `${row.id} expected status=done, got ${row.status}`,
      );
    }

    // Stop hook events must have been persisted to the events DB too.
    const stopEvents = db.byTask(taskId, 10);
    assert.equal(stopEvents.length, 2, "both Stop hook calls should be recorded");
    for (const ev of stopEvents) {
      assert.equal(ev.kind, "done");
    }
  } finally {
    await hooksServer.close();
    db.close();
    registry.close();
  }
});

