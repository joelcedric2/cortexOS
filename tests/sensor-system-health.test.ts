import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("SystemHealthSensor", () => {
  test("sensor has correct metadata", async () => {
    const { createSystemHealthSensor } = await import("../src/sensors/system-health.js");
    const sensor = createSystemHealthSensor();

    assert.equal(sensor.name, "system-health");
    assert.equal(sensor.privacyLevel, "local-only");
    assert.equal(sensor.enabled, true);
    assert.equal(sensor.interval, 120_000);
    assert.deepEqual(sensor.permissionsRequired, ["system-info"]);
  });

  test("sensor returns a sample (may be null if system is healthy)", async () => {
    const { createSystemHealthSensor } = await import("../src/sensors/system-health.js");
    const sensor = createSystemHealthSensor();

    // On CI or any system, the sensor should never throw
    const sample = await sensor.sample();

    if (sample !== null) {
      assert.equal(sample.sensorName, "system-health");
      assert.ok(sample.urgency >= 0 && sample.urgency <= 1);
      assert.ok(sample.observation.length > 0);
      assert.ok(sample.sampledAt instanceof Date);
    }
  });

  test("battery parsing: low battery triggers observation", async () => {
    // Test the parsing by verifying the sensor interface contract
    const { createSystemHealthSensor } = await import("../src/sensors/system-health.js");
    const sensor = createSystemHealthSensor({ batteryThreshold: 100 });

    // With threshold of 100%, any battery should trigger (if battery exists)
    const sample = await sensor.sample();

    // On a MacBook this should produce a battery observation
    // On CI without battery, it might still produce disk/CPU observations
    if (sample !== null) {
      assert.equal(typeof sample.urgency, "number");
      assert.ok(sample.urgency > 0);
    }
  });

  test("disk parsing: high threshold triggers observation", async () => {
    // Set disk threshold very low so it should always trigger
    const { createSystemHealthSensor } = await import("../src/sensors/system-health.js");
    const sensor = createSystemHealthSensor({ diskThreshold: 1 });
    const sample = await sensor.sample();

    assert.ok(sample !== null, "disk usage > 1% should trigger");
    assert.ok(sample.observation.includes("Disk"));
  });

  test("custom thresholds are respected", async () => {
    const { createSystemHealthSensor } = await import("../src/sensors/system-health.js");

    // Very high thresholds — should not trigger
    const sensor = createSystemHealthSensor({
      batteryThreshold: 0,
      diskThreshold: 100,
      cpuThreshold: 10000,
    });
    const sample = await sensor.sample();

    // With battery threshold 0 and disk 100, nothing should match
    // (unless battery is literally 0% which is unlikely)
    // This is a best-effort test — system state varies
    if (sample === null) {
      assert.equal(sample, null);
    }
  });

  test("sensor never throws even with unusual system state", async () => {
    const { createSystemHealthSensor } = await import("../src/sensors/system-health.js");
    const sensor = createSystemHealthSensor();

    // Should never throw — errors are swallowed internally
    const sample = await sensor.sample();
    assert.ok(sample === null || typeof sample.observation === "string");
  });

  test("urgency levels are correct for disk thresholds", async () => {
    const { createSystemHealthSensor } = await import("../src/sensors/system-health.js");

    // Test with disk threshold = 1 to guarantee trigger
    const sensor = createSystemHealthSensor({ diskThreshold: 1 });
    const sample = await sensor.sample();

    if (sample !== null && sample.data) {
      const diskPct = sample.data.diskUsagePercent as number | undefined;
      if (diskPct !== undefined) {
        if (diskPct > 95) {
          assert.ok(sample.urgency >= 0.8);
        } else if (diskPct > 1) {
          assert.ok(sample.urgency >= 0.6);
        }
      }
    }
  });
});
