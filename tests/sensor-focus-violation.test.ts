import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFocusViolationSensor } from "../src/sensors/focus-violation.js";

/** Creates a mock execFn that returns canned responses. */
function mockExec(responses: Map<string, string>) {
  return async (_cmd: string, args: string[]): Promise<string> => {
    const key = args.join(" ");
    for (const [pattern, response] of responses) {
      if (key.includes(pattern)) return response;
    }
    throw new Error(`No mock for: ${key}`);
  };
}

describe("focus-violation sensor", () => {
  it("has correct metadata", () => {
    const sensor = createFocusViolationSensor({
      execFn: mockExec(new Map()),
    });
    assert.equal(sensor.name, "focus-violation");
    assert.equal(sensor.privacyLevel, "local-only");
    assert.equal(sensor.interval, 30_000);
  });

  it("returns null when Focus mode is off", async () => {
    const responses = new Map([["FocusModes", "0\n"]]);

    const sensor = createFocusViolationSensor({
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.equal(result, null);
  });

  it("returns null when Focus is on but app is not distracting", async () => {
    const responses = new Map([
      ["FocusModes", "1\n"],
      ["frontmost is true", "Code\n"],
    ]);

    const sensor = createFocusViolationSensor({
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.equal(result, null);
  });

  it("detects distracting app during Focus mode", async () => {
    const responses = new Map([
      ["FocusModes", "1\n"],
      ["frontmost is true", "Twitter\n"],
    ]);

    const sensor = createFocusViolationSensor({
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.ok(result !== null);
    assert.equal(result.sensorName, "focus-violation");
    assert.equal(result.urgency, 0.6);
    assert.ok(result.observation.includes("Twitter"));
    assert.ok(result.observation.includes("Focus mode"));
  });

  it("matches distraction apps case-insensitively", async () => {
    const responses = new Map([
      ["FocusModes", "1\n"],
      ["frontmost is true", "REDDIT\n"],
    ]);

    const sensor = createFocusViolationSensor({
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.ok(result !== null);
    assert.equal(result.sensorName, "focus-violation");
  });

  it("accepts custom distraction list", async () => {
    const responses = new Map([
      ["FocusModes", "1\n"],
      ["frontmost is true", "Slack\n"],
    ]);

    const sensor = createFocusViolationSensor({
      distractionApps: ["Slack", "Discord"],
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.ok(result !== null);
    assert.ok(result.observation.includes("Slack"));
  });

  it("returns null on osascript failure", async () => {
    const sensor = createFocusViolationSensor({
      execFn: async () => {
        throw new Error("defaults read failed");
      },
    });

    const result = await sensor.sample();
    assert.equal(result, null);
  });

  it("includes app and focus data in sample data", async () => {
    const responses = new Map([
      ["FocusModes", "1\n"],
      ["frontmost is true", "YouTube\n"],
    ]);

    const sensor = createFocusViolationSensor({
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.ok(result !== null);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.app, "YouTube");
    assert.equal(data.focusModeActive, true);
  });
});
