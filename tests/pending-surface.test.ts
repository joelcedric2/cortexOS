import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PendingSurface } from "../src/proactivity/pending-surface.js";
import { ObservationStore } from "../src/sensors/_a-stub.js";
import type { SensorSample } from "../src/sensors/sensor.js";
import type { EventBus, AgentEvent } from "../src/ipc/event-bus.js";

function makeSample(
  sensorName: string,
  urgency: number,
  observation = "test obs",
): SensorSample {
  return {
    sensorName,
    observation,
    urgency,
    sampledAt: new Date(),
  };
}

/** Minimal EventBus mock that captures emitted events. */
function createMockBus(): EventBus & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    emit(event: AgentEvent) {
      events.push(event);
    },
    subscribe() {
      return () => {};
    },
    once() {
      return Promise.resolve({} as AgentEvent);
    },
  };
}

describe("PendingSurface", () => {
  let store: ObservationStore;
  let surface: PendingSurface;

  beforeEach(() => {
    store = new ObservationStore();
    surface = new PendingSurface(store);
  });

  describe("list()", () => {
    it("returns empty array when no observations", () => {
      assert.deepEqual(surface.list(), []);
    });

    it("returns items sorted by urgency descending", () => {
      store.insert(makeSample("sensor-a", 0.3));
      store.insert(makeSample("sensor-b", 0.9));
      store.insert(makeSample("sensor-c", 0.6));

      const items = surface.list();
      assert.equal(items.length, 3);
      assert.equal(items[0].urgency, 0.9);
      assert.equal(items[1].urgency, 0.6);
      assert.equal(items[2].urgency, 0.3);
    });

    it("respects the limit parameter", () => {
      store.insert(makeSample("a", 0.1));
      store.insert(makeSample("b", 0.2));
      store.insert(makeSample("c", 0.3));

      const items = surface.list(2);
      assert.equal(items.length, 2);
    });

    it("includes suggestedAction for known sensor types", () => {
      store.insert(makeSample("unsent-drafts", 0.4));
      store.insert(makeSample("git-dirty", 0.5));
      store.insert(makeSample("unknown-sensor", 0.3));

      const items = surface.list();
      const drafts = items.find((i) => i.sensorName === "unsent-drafts");
      const git = items.find((i) => i.sensorName === "git-dirty");
      const unknown = items.find((i) => i.sensorName === "unknown-sensor");

      assert.equal(drafts?.suggestedAction, "[Reply]");
      assert.equal(git?.suggestedAction, "[Commit]");
      assert.equal(unknown?.suggestedAction, undefined);
    });

    it("excludes acted-on observations", () => {
      const id = store.insert(makeSample("sensor-a", 0.5));
      store.markActedOn(id);

      assert.equal(surface.list().length, 0);
    });
  });

  describe("actOn()", () => {
    it("skip suppresses the item for 24 hours", () => {
      const id = store.insert(makeSample("sensor-a", 0.5));
      surface.actOn(id, "skip");

      // Item should no longer appear in pending
      assert.equal(surface.list().length, 0);
    });

    it("never suppresses the entire sensor type", () => {
      const id1 = store.insert(makeSample("noisy-sensor", 0.5));
      store.insert(makeSample("noisy-sensor", 0.6));

      surface.actOn(id1, "never");

      // Both items from same sensor should be suppressed
      const items = surface.list();
      const noisy = items.filter((i) => i.sensorName === "noisy-sensor");
      assert.equal(noisy.length, 0);
    });

    it("reply marks item as acted-on", () => {
      const bus = createMockBus();
      const surfaceWithBus = new PendingSurface(store, bus);

      const id = store.insert(makeSample("sensor-a", 0.5));
      surfaceWithBus.actOn(id, "reply");

      assert.equal(surface.list().length, 0);
    });

    it("reply emits an event on the bus", () => {
      const bus = createMockBus();
      const surfaceWithBus = new PendingSurface(store, bus);

      const id = store.insert(makeSample("sensor-a", 0.5));
      surfaceWithBus.actOn(id, "reply");

      assert.equal(bus.events.length, 1);
      const payload = bus.events[0].payload as Record<string, unknown>;
      assert.equal(payload.surfaceAction, "reply");
      assert.equal(payload.observationId, id);
    });

    it("commit emits an event on the bus", () => {
      const bus = createMockBus();
      const surfaceWithBus = new PendingSurface(store, bus);

      const id = store.insert(makeSample("sensor-a", 0.5));
      surfaceWithBus.actOn(id, "commit");

      assert.equal(bus.events.length, 1);
      const payload = bus.events[0].payload as Record<string, unknown>;
      assert.equal(payload.surfaceAction, "commit");
    });

    it("does not emit when no bus is provided", () => {
      const id = store.insert(makeSample("sensor-a", 0.5));
      // Should not throw
      surface.actOn(id, "reply");
      assert.equal(surface.list().length, 0);
    });
  });

  describe("suppressType()", () => {
    it("suppresses all observations from a sensor", () => {
      store.insert(makeSample("chatty-sensor", 0.3));
      store.insert(makeSample("chatty-sensor", 0.7));
      store.insert(makeSample("other-sensor", 0.5));

      surface.suppressType("chatty-sensor");

      const items = surface.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].sensorName, "other-sensor");
    });

    it("accepts a custom duration in hours", () => {
      store.insert(makeSample("sensor-a", 0.5));
      surface.suppressType("sensor-a", 48);

      assert.equal(surface.list().length, 0);
    });
  });
});
