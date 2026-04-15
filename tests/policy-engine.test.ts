import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import { PolicyEngine } from "../src/registry/policy-engine.js";

/**
 * Reusable fixture — builds a registry + bus + PolicyEngine with the
 * memory/idle knobs set to deterministic, test-friendly values.
 */
interface Fixture {
  registry: AgentRegistry;
  bus: ReturnType<typeof createEventBus>;
  engine: PolicyEngine;
  evicted: string[];
  setMemory: (freeRatio: number) => void;
  setNow: (ms: number) => void;
}

function buildFixture(opts: {
  freeRatio?: number;
  pressureThreshold?: number;
  idleStandbyMs?: number;
} = {}): Fixture {
  const registry = new AgentRegistry({ dbPath: ":memory:" });
  const bus = createEventBus();
  const evicted: string[] = [];
  const TOTAL = 16 * 1024 * 1024 * 1024; // 16GB
  let freeRatio = opts.freeRatio ?? 0.5;
  let nowMs = Date.now();

  const engine = new PolicyEngine({
    registry,
    bus,
    freemem: () => Math.floor(TOTAL * freeRatio),
    totalmem: () => TOTAL,
    onEvict: async (id) => {
      evicted.push(id);
    },
    memoryPressureThreshold: opts.pressureThreshold ?? 0.15,
    idleStandbyMs: opts.idleStandbyMs ?? 10 * 60 * 1000,
    tickIntervalMs: 60_000,
    now: () => nowMs,
  });

  return {
    registry,
    bus,
    engine,
    evicted,
    setMemory: (r: number) => {
      freeRatio = r;
    },
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

describe("PolicyEngine.onDoneEvent", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = buildFixture();
  });
  afterEach(() => {
    fx.engine.stop();
    fx.registry.close();
  });

  test("done event transitions running agent → standby", async () => {
    fx.registry.spawn({ id: "A1", role: "coder", color: "blue" });
    fx.registry.markRunning("A1");

    await fx.engine.onDoneEvent({
      kind: "done",
      agent_id: "A1",
      ts: new Date(),
    });

    assert.equal(fx.registry.getById("A1")?.status, "standby");
  });

  test("done event for terminal-state agent does not resurrect it", async () => {
    fx.registry.spawn({ id: "A2", role: "coder", color: "blue" });
    fx.registry.markRunning("A2");
    fx.registry.markError("A2");

    await fx.engine.onDoneEvent({
      kind: "done",
      agent_id: "A2",
      ts: new Date(),
    });

    assert.equal(fx.registry.getById("A2")?.status, "error");
  });

  test("done event without agent_id is ignored", async () => {
    // Must not throw. No side effects possible with no id.
    await fx.engine.onDoneEvent({ kind: "done", ts: new Date() });
  });

  test("start() wires up the bus subscription and reacts to emitted events", async () => {
    fx.registry.spawn({ id: "A3", role: "coder", color: "blue" });
    fx.registry.markRunning("A3");
    fx.engine.start();
    fx.bus.emit({ kind: "done", agent_id: "A3", ts: new Date() });
    // Give the bus microtask a chance to flush.
    await new Promise((r) => setImmediate(r));
    assert.equal(fx.registry.getById("A3")?.status, "standby");
  });
});

describe("PolicyEngine.periodicTick — memory pressure", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = buildFixture({ pressureThreshold: 0.15 });
  });
  afterEach(() => {
    fx.engine.stop();
    fx.registry.close();
  });

  test("memory pressure evicts the oldest-heartbeat standby agent", async () => {
    fx.registry.spawn({ id: "OLD", role: "coder", color: "blue" });
    fx.registry.markRunning("OLD");
    fx.registry.markStandby("OLD"); // heartbeat bumped first → oldest.

    // Delay so heartbeats are distinguishable in SQLite's second-precision.
    await new Promise((r) => setTimeout(r, 1100));

    fx.registry.spawn({ id: "NEW", role: "coder", color: "blue" });
    fx.registry.markRunning("NEW");
    fx.registry.markStandby("NEW");

    fx.setMemory(0.05); // 5% free — way below 15% threshold.
    await fx.engine.periodicTick();

    assert.deepEqual(fx.evicted, ["OLD"]);
    assert.equal(fx.registry.getById("OLD")?.status, "error");
    assert.equal(fx.registry.getById("NEW")?.status, "standby");
  });

  test("healthy memory → no eviction", async () => {
    fx.registry.spawn({ id: "HAPPY", role: "coder", color: "blue" });
    fx.registry.markRunning("HAPPY");
    fx.registry.markStandby("HAPPY");

    fx.setMemory(0.8); // plenty of headroom.
    await fx.engine.periodicTick();

    assert.deepEqual(fx.evicted, []);
    assert.equal(fx.registry.getById("HAPPY")?.status, "standby");
  });

  test("memory pressure with no standby agents is a no-op", async () => {
    fx.registry.spawn({ id: "RUN", role: "coder", color: "blue" });
    fx.registry.markRunning("RUN");

    fx.setMemory(0.01);
    await fx.engine.periodicTick();

    assert.deepEqual(fx.evicted, []);
    assert.equal(fx.registry.getById("RUN")?.status, "running");
  });
});

describe("PolicyEngine.periodicTick — idle sweep", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = buildFixture({
      idleStandbyMs: 5 * 60 * 1000,
      pressureThreshold: 0.01, // effectively disable memory pressure
    });
  });
  afterEach(() => {
    fx.engine.stop();
    fx.registry.close();
  });

  test("standby agent idle longer than threshold gets evicted", async () => {
    fx.registry.spawn({ id: "IDLE", role: "coder", color: "blue" });
    fx.registry.markRunning("IDLE");
    fx.registry.markStandby("IDLE");

    // Pretend the wall clock has jumped 10 minutes forward — well past the
    // 5-minute idle threshold.
    fx.setNow(Date.now() + 10 * 60 * 1000);
    fx.setMemory(0.9); // healthy — isolate idle logic.
    await fx.engine.periodicTick();

    assert.deepEqual(fx.evicted, ["IDLE"]);
    assert.equal(fx.registry.getById("IDLE")?.status, "error");
  });

  test("recently-heartbeating standby agent is NOT evicted", async () => {
    fx.registry.spawn({ id: "FRESH", role: "coder", color: "blue" });
    fx.registry.markRunning("FRESH");
    fx.registry.markStandby("FRESH");

    // Tick "now" forward only 1 minute — below the 5-minute cutoff.
    fx.setNow(Date.now() + 60 * 1000);
    fx.setMemory(0.9);
    await fx.engine.periodicTick();

    assert.deepEqual(fx.evicted, []);
    assert.equal(fx.registry.getById("FRESH")?.status, "standby");
  });

  test("running (non-standby) agent is never idle-evicted", async () => {
    fx.registry.spawn({ id: "RUN", role: "coder", color: "blue" });
    fx.registry.markRunning("RUN");

    fx.setNow(Date.now() + 24 * 60 * 60 * 1000); // a full day later.
    fx.setMemory(0.9);
    await fx.engine.periodicTick();

    assert.deepEqual(fx.evicted, []);
    assert.equal(fx.registry.getById("RUN")?.status, "running");
  });
});

describe("PolicyEngine.stop", () => {
  test("stop() is idempotent and unsubscribes the bus listener", async () => {
    const fx = buildFixture();
    fx.registry.spawn({ id: "S1", role: "coder", color: "blue" });
    fx.registry.markRunning("S1");
    fx.engine.start();
    fx.engine.stop();
    fx.engine.stop(); // must not throw.

    // After stop, emitted events are ignored.
    fx.bus.emit({ kind: "done", agent_id: "S1", ts: new Date() });
    await new Promise((r) => setImmediate(r));
    assert.equal(fx.registry.getById("S1")?.status, "running");

    fx.registry.close();
  });
});
