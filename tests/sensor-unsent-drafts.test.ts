import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createUnsentDraftsSensor } from "../src/sensors/unsent-drafts.js";

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

describe("unsent-drafts sensor", () => {
  it("has correct metadata", () => {
    const sensor = createUnsentDraftsSensor({
      execFn: mockExec(new Map()),
    });
    assert.equal(sensor.name, "unsent-drafts");
    assert.equal(sensor.privacyLevel, "llm-on-action");
    assert.equal(sensor.interval, 300_000);
  });

  it("returns null when no drafts exist", async () => {
    const responses = new Map([["count of messages", "0\n"]]);

    const sensor = createUnsentDraftsSensor({
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.equal(result, null);
  });

  it("returns null when draft is too recent", async () => {
    const recentDate = new Date(Date.now() - 60_000).toString(); // 1 min ago
    const responses = new Map([
      ["count of messages", "1\n"],
      ["date received", recentDate + "\n"],
    ]);

    const sensor = createUnsentDraftsSensor({
      ageThresholdMs: 5 * 60 * 1000,
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.equal(result, null);
  });

  it("detects drafts older than threshold", async () => {
    const oldDate = new Date(Date.now() - 10 * 60 * 1000).toString(); // 10 min ago
    const responses = new Map([
      ["count of messages", "3\n"],
      ["date received", oldDate + "\n"],
    ]);

    const sensor = createUnsentDraftsSensor({
      ageThresholdMs: 5 * 60 * 1000,
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.ok(result !== null);
    assert.equal(result.sensorName, "unsent-drafts");
    assert.equal(result.urgency, 0.4);
    assert.ok(result.observation.includes("3"));
    assert.ok(result.observation.includes("unsent draft"));
  });

  it("includes draft count and age in data", async () => {
    const oldDate = new Date(Date.now() - 15 * 60 * 1000).toString();
    const responses = new Map([
      ["count of messages", "2\n"],
      ["date received", oldDate + "\n"],
    ]);

    const sensor = createUnsentDraftsSensor({
      ageThresholdMs: 1000,
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.ok(result !== null);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.draftCount, 2);
    assert.ok((data.oldestAgeMinutes as number) >= 14);
  });

  it("returns null on osascript failure", async () => {
    const sensor = createUnsentDraftsSensor({
      execFn: async () => {
        throw new Error("osascript failed");
      },
    });

    const result = await sensor.sample();
    assert.equal(result, null);
  });

  it("returns null for negative draft count", async () => {
    const responses = new Map([["count of messages", "-1\n"]]);

    const sensor = createUnsentDraftsSensor({
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.equal(result, null);
  });

  it("uses custom age threshold", async () => {
    const slightlyOld = new Date(Date.now() - 2000).toString(); // 2 sec ago
    const responses = new Map([
      ["count of messages", "1\n"],
      ["date received", slightlyOld + "\n"],
    ]);

    const sensor = createUnsentDraftsSensor({
      ageThresholdMs: 1000, // 1 second threshold
      execFn: mockExec(responses),
    });

    const result = await sensor.sample();
    assert.ok(result !== null);
    assert.equal(result.sensorName, "unsent-drafts");
  });
});
