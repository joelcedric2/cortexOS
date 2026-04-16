import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ObservationStore } from "../src/sensors/observation-store.js";
import type { SensorSample } from "../src/sensors/sensor.js";

function makeSample(overrides?: Partial<SensorSample>): SensorSample {
  return {
    sensorName: "test-sensor",
    observation: "something happened",
    urgency: 0.5,
    sampledAt: new Date(),
    ...overrides,
  };
}

describe("ObservationStore", () => {
  let store: ObservationStore;

  beforeEach(() => {
    store = new ObservationStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  // ─── insert ────────────────────────────────────────────────────────────────

  test("insert returns auto-incremented id", () => {
    const id1 = store.insert(makeSample());
    const id2 = store.insert(makeSample());
    assert.equal(id1, 1);
    assert.equal(id2, 2);
  });

  test("insert stores data_json when data is present", () => {
    store.insert(makeSample({ data: { files: 3 } }));
    const rows = store.pending();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data_json, '{"files":3}');
  });

  test("insert stores null data_json when data is absent", () => {
    store.insert(makeSample());
    const rows = store.pending();
    assert.equal(rows[0].data_json, null);
  });

  // ─── pending ───────────────────────────────────────────────────────────────

  test("pending returns observations not acted on", () => {
    store.insert(makeSample({ observation: "a" }));
    store.insert(makeSample({ observation: "b" }));
    const rows = store.pending();
    assert.equal(rows.length, 2);
  });

  test("pending excludes acted-on observations", () => {
    const id = store.insert(makeSample());
    store.markActedOn(id);
    const rows = store.pending();
    assert.equal(rows.length, 0);
  });

  test("pending excludes suppressed observations", () => {
    const id = store.insert(makeSample());
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    store.suppress(id, tomorrow);
    const rows = store.pending();
    assert.equal(rows.length, 0);
  });

  test("pending includes observations past suppression window", () => {
    const id = store.insert(makeSample());
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    store.suppress(id, yesterday);
    const rows = store.pending();
    assert.equal(rows.length, 1);
  });

  test("pending orders by urgency DESC then id DESC", () => {
    store.insert(makeSample({ urgency: 0.3, observation: "low" }));
    store.insert(makeSample({ urgency: 0.9, observation: "high" }));
    store.insert(makeSample({ urgency: 0.9, observation: "high2" }));
    const rows = store.pending();
    assert.equal(rows[0].observation, "high2"); // higher id, same urgency
    assert.equal(rows[1].observation, "high");
    assert.equal(rows[2].observation, "low");
  });

  test("pending respects limit", () => {
    for (let i = 0; i < 5; i++) {
      store.insert(makeSample());
    }
    const rows = store.pending(2);
    assert.equal(rows.length, 2);
  });

  // ─── markActedOn ───────────────────────────────────────────────────────────

  test("markActedOn sets acted_on flag", () => {
    const id = store.insert(makeSample());
    store.markActedOn(id);
    const rows = store.pending();
    assert.equal(rows.length, 0);
  });

  // ─── suppress ──────────────────────────────────────────────────────────────

  test("suppress sets suppressed_until on a single observation", () => {
    const id = store.insert(makeSample());
    const future = new Date();
    future.setDate(future.getDate() + 7);
    store.suppress(id, future);
    const rows = store.pending();
    assert.equal(rows.length, 0);
  });

  // ─── suppressByType ────────────────────────────────────────────────────────

  test("suppressByType suppresses all pending from a sensor", () => {
    store.insert(makeSample({ sensorName: "alpha" }));
    store.insert(makeSample({ sensorName: "alpha" }));
    store.insert(makeSample({ sensorName: "beta" }));

    const future = new Date();
    future.setDate(future.getDate() + 1);
    store.suppressByType("alpha", future);

    const rows = store.pending();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sensor_name, "beta");
  });

  test("suppressByType does not affect acted-on observations", () => {
    const id = store.insert(makeSample({ sensorName: "alpha" }));
    store.markActedOn(id);
    store.insert(makeSample({ sensorName: "alpha" }));

    const future = new Date();
    future.setDate(future.getDate() + 1);
    store.suppressByType("alpha", future);

    // The acted-on one was already excluded; the second is now suppressed
    const rows = store.pending();
    assert.equal(rows.length, 0);
  });

  // ─── cleanup ───────────────────────────────────────────────────────────────

  test("cleanup deletes observations older than retentionDays", () => {
    // Insert an observation with a past date
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    store.insert(makeSample({ sampledAt: oldDate }));
    store.insert(makeSample()); // fresh one

    const deleted = store.cleanup(5); // retain 5 days
    assert.equal(deleted, 1);

    const rows = store.pending();
    assert.equal(rows.length, 1);
  });

  test("cleanup returns 0 when nothing to delete", () => {
    store.insert(makeSample());
    const deleted = store.cleanup(30);
    assert.equal(deleted, 0);
  });
});
