import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAppAttentionSensor } from "../src/sensors/app-attention.js";

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

describe("app-attention sensor", () => {
  it("has correct metadata", () => {
    const sensor = createAppAttentionSensor({
      execFn: mockExec(new Map()),
    });
    assert.equal(sensor.name, "app-attention");
    assert.equal(sensor.privacyLevel, "local-only");
    assert.ok(sensor.interval > 0);
  });

  it("returns null when no apps are neglected", async () => {
    const responses = new Map([
      ["frontmost is true", "Code\n"],
      ["background only is false", "Code, Finder\n"],
    ]);

    const sensor = createAppAttentionSensor({
      thresholdMs: 30 * 60 * 1000,
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.equal(result, null);
  });

  it("detects apps open without focus past threshold", async () => {
    const responses = new Map([
      ["frontmost is true", "Code\n"],
      ["background only is false", "Code, Slack, Notes\n"],
    ]);

    const sensor = createAppAttentionSensor({
      thresholdMs: 10, // 10ms threshold for testing
      execFn: mockExec(responses),
    });

    // First sample sets baselines
    await sensor.sample();

    // Wait past threshold
    await new Promise((r) => setTimeout(r, 20));

    // Second sample should detect neglected apps
    const result = await sensor.sample();
    assert.ok(result !== null);
    assert.equal(result.sensorName, "app-attention");
    assert.equal(result.urgency, 0.2);
    assert.ok(result.observation.includes("Slack"));
    assert.ok(result.observation.includes("Notes"));
  });

  it("does not flag frontmost app as neglected", async () => {
    const responses = new Map([
      ["frontmost is true", "Slack\n"],
      ["background only is false", "Slack\n"],
    ]);

    const sensor = createAppAttentionSensor({
      thresholdMs: 1,
      execFn: mockExec(responses),
    });

    await sensor.sample();
    await new Promise((r) => setTimeout(r, 5));
    const result = await sensor.sample();
    assert.equal(result, null);
  });

  it("returns null on osascript failure", async () => {
    const sensor = createAppAttentionSensor({
      execFn: async () => {
        throw new Error("osascript failed");
      },
    });

    const result = await sensor.sample();
    assert.equal(result, null);
  });

  it("cleans up apps no longer running", async () => {
    let callCount = 0;
    const sensor = createAppAttentionSensor({
      thresholdMs: 10,
      execFn: async (_cmd: string, args: string[]) => {
        const key = args.join(" ");
        if (key.includes("frontmost")) return "Code\n";
        if (key.includes("background only")) {
          callCount++;
          // First call: 3 apps. Second call: only 2 (Notes quit).
          if (callCount <= 1) return "Code, Slack, Notes\n";
          return "Code, Slack\n";
        }
        throw new Error(`Unexpected: ${key}`);
      },
    });

    await sensor.sample();
    await new Promise((r) => setTimeout(r, 20));

    const result = await sensor.sample();
    assert.ok(result !== null);
    // Notes should NOT appear since it's no longer running
    assert.ok(!result.observation.includes("Notes"));
    assert.ok(result.observation.includes("Slack"));
  });
});
