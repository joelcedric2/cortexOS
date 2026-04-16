import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SensorManager } from "../src/sensors/sensor-manager.js";
import { ObservationStore } from "../src/sensors/observation-store.js";
import type { Sensor, SensorSample } from "../src/sensors/sensor.js";
import type { EventBus, AgentEvent, EventFilter } from "../src/ipc/event-bus.js";

// ─── Fakes ───────────────────────────────────────────────────────────────────

function fakeBus(): EventBus & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    emit(event: AgentEvent) {
      events.push(event);
    },
    subscribe(_filter: EventFilter, _handler: (e: AgentEvent) => void) {
      return () => {};
    },
    once(_filter: EventFilter, _timeoutMs?: number) {
      return Promise.resolve({} as AgentEvent);
    },
  };
}

function fakeSensor(overrides?: Partial<Sensor> & { sampleFn?: () => Promise<SensorSample | null> }): Sensor {
  const { sampleFn, ...rest } = overrides ?? {};
  return {
    name: "fake-sensor",
    description: "A test sensor",
    permissionsRequired: [],
    privacyLevel: "local-only",
    interval: 0, // always eligible
    enabled: true,
    sample: sampleFn ?? (() => Promise.resolve(null)),
    ...rest,
  };
}

function makeSample(name = "fake-sensor"): SensorSample {
  return {
    sensorName: name,
    observation: "test observation",
    urgency: 0.5,
    sampledAt: new Date(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SensorManager", () => {
  let store: ObservationStore;
  let bus: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    store = new ObservationStore({ dbPath: ":memory:" });
    bus = fakeBus();
  });

  afterEach(() => {
    store.close();
  });

  test("tick fires sample on enabled sensor and stores result", async () => {
    const sensor = fakeSensor({
      sampleFn: () => Promise.resolve(makeSample()),
    });

    const mgr = new SensorManager({
      bus,
      sensors: [sensor],
      store,
      tickIntervalMs: 100_000, // won't auto-fire
    });

    // start() fires one immediate tick
    mgr.start();
    // Give async tick time to complete
    await new Promise((r) => setTimeout(r, 50));
    mgr.stop();

    const pending = store.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sensor_name, "fake-sensor");
    assert.equal(pending[0].observation, "test observation");
  });

  test("tick emits plan_emitted event on non-null sample", async () => {
    const sensor = fakeSensor({
      sampleFn: () => Promise.resolve(makeSample()),
    });

    const mgr = new SensorManager({
      bus,
      sensors: [sensor],
      store,
      tickIntervalMs: 100_000,
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 50));
    mgr.stop();

    assert.equal(bus.events.length, 1);
    assert.equal(bus.events[0].kind, "plan_emitted");
    const payload = bus.events[0].payload as Record<string, unknown>;
    assert.equal(payload.phase, "SENSOR_OBSERVATION");
    assert.equal(payload.sensorName, "fake-sensor");
  });

  test("tick skips sensor that returns null", async () => {
    const sensor = fakeSensor({
      sampleFn: () => Promise.resolve(null),
    });

    const mgr = new SensorManager({
      bus,
      sensors: [sensor],
      store,
      tickIntervalMs: 100_000,
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 50));
    mgr.stop();

    assert.equal(store.pending().length, 0);
    assert.equal(bus.events.length, 0);
  });

  test("disabled sensors are skipped", async () => {
    let called = false;
    const sensor = fakeSensor({
      enabled: false,
      sampleFn: () => {
        called = true;
        return Promise.resolve(makeSample());
      },
    });

    const mgr = new SensorManager({
      bus,
      sensors: [sensor],
      store,
      tickIntervalMs: 100_000,
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 50));
    mgr.stop();

    assert.equal(called, false);
    assert.equal(store.pending().length, 0);
  });

  test("pauseAll stops all sampling, resumeAll restarts", async () => {
    let callCount = 0;
    const sensor = fakeSensor({
      sampleFn: () => {
        callCount++;
        return Promise.resolve(makeSample());
      },
    });

    const mgr = new SensorManager({
      bus,
      sensors: [sensor],
      store,
      tickIntervalMs: 30,
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 50));
    const countBefore = callCount;

    mgr.pauseAll();
    await new Promise((r) => setTimeout(r, 80));
    const countDuringPause = callCount;
    assert.equal(countDuringPause, countBefore, "no new samples while paused");

    mgr.resumeAll();
    await new Promise((r) => setTimeout(r, 80));
    mgr.stop();

    assert.ok(callCount > countDuringPause, "samples resumed after resumeAll");
  });

  test("enableSensor and disableSensor toggle sensor state", () => {
    const sensor = fakeSensor({ name: "toggleable", enabled: false });

    const mgr = new SensorManager({
      bus,
      sensors: [sensor],
      store,
    });

    const statesBefore = mgr.getSensorStates();
    assert.equal(statesBefore[0].enabled, false);

    mgr.enableSensor("toggleable");
    const statesAfter = mgr.getSensorStates();
    assert.equal(statesAfter[0].enabled, true);

    mgr.disableSensor("toggleable");
    const statesFinal = mgr.getSensorStates();
    assert.equal(statesFinal[0].enabled, false);
  });

  test("sensor failure is logged, not thrown", async () => {
    const logs: string[] = [];
    const sensor = fakeSensor({
      name: "bad-sensor",
      sampleFn: () => Promise.reject(new Error("boom")),
    });

    const mgr = new SensorManager({
      bus,
      sensors: [sensor],
      store,
      tickIntervalMs: 100_000,
      log: (msg) => logs.push(msg),
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 50));
    mgr.stop();

    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes("bad-sensor"));
    assert.ok(logs[0].includes("boom"));
  });

  test("getSensorStates returns all sensors with lastSample", async () => {
    const s1 = fakeSensor({ name: "a", sampleFn: () => Promise.resolve(makeSample("a")) });
    const s2 = fakeSensor({ name: "b", enabled: false });

    const mgr = new SensorManager({
      bus,
      sensors: [s1, s2],
      store,
      tickIntervalMs: 100_000,
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 50));
    mgr.stop();

    const states = mgr.getSensorStates();
    assert.equal(states.length, 2);

    const stateA = states.find((s) => s.name === "a");
    assert.ok(stateA);
    assert.equal(stateA.enabled, true);
    assert.ok(stateA.lastSample instanceof Date);

    const stateB = states.find((s) => s.name === "b");
    assert.ok(stateB);
    assert.equal(stateB.enabled, false);
    assert.equal(stateB.lastSample, undefined);
  });

  test("sensor interval is respected — skips if not enough time elapsed", async () => {
    let callCount = 0;
    const sensor = fakeSensor({
      interval: 999_999, // very long interval
      sampleFn: () => {
        callCount++;
        return Promise.resolve(makeSample());
      },
    });

    const mgr = new SensorManager({
      bus,
      sensors: [sensor],
      store,
      tickIntervalMs: 20,
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 100));
    mgr.stop();

    // Should only have been called once (the first tick)
    assert.equal(callCount, 1);
  });
});
