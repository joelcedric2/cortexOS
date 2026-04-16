import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeUrgencyDecision,
  type UrgencyInput,
} from "../src/proactivity/urgency.js";
import type { SensorSample } from "../src/sensors/sensor.js";

function makeSample(urgency: number): SensorSample {
  return {
    sensorName: "test-sensor",
    observation: "test observation",
    urgency,
    sampledAt: new Date(),
  };
}

function makeInput(
  overrides: Partial<UrgencyInput> & { sample: SensorSample },
): UrgencyInput {
  return {
    mode: "volunteer",
    ...overrides,
  };
}

describe("computeUrgencyDecision", () => {
  describe("silent mode", () => {
    it("always returns log-only regardless of urgency", () => {
      assert.equal(
        computeUrgencyDecision(
          makeInput({ sample: makeSample(1.0), mode: "silent" }),
        ),
        "log-only",
      );
      assert.equal(
        computeUrgencyDecision(
          makeInput({ sample: makeSample(0.5), mode: "silent" }),
        ),
        "log-only",
      );
      assert.equal(
        computeUrgencyDecision(
          makeInput({ sample: makeSample(0.0), mode: "silent" }),
        ),
        "log-only",
      );
    });
  });

  describe("quiet period", () => {
    it("returns log-only when quiet timer is active", () => {
      const futureDate = new Date(Date.now() + 60_000);
      assert.equal(
        computeUrgencyDecision(
          makeInput({
            sample: makeSample(0.9),
            mode: "volunteer",
            quietUntil: futureDate,
          }),
        ),
        "log-only",
      );
    });

    it("does not suppress when quiet timer has expired", () => {
      const pastDate = new Date(Date.now() - 1000);
      assert.equal(
        computeUrgencyDecision(
          makeInput({
            sample: makeSample(0.9),
            mode: "volunteer",
            quietUntil: pastDate,
          }),
        ),
        "speak-now",
      );
    });
  });

  describe("critical urgency (>= 0.8)", () => {
    it("returns speak-now for volunteer mode", () => {
      assert.equal(
        computeUrgencyDecision(
          makeInput({ sample: makeSample(0.8), mode: "volunteer" }),
        ),
        "speak-now",
      );
    });

    it("returns speak-now for anticipatory mode", () => {
      assert.equal(
        computeUrgencyDecision(
          makeInput({ sample: makeSample(0.9), mode: "anticipatory" }),
        ),
        "speak-now",
      );
    });

    it("returns speak-now for autonomous mode", () => {
      assert.equal(
        computeUrgencyDecision(
          makeInput({ sample: makeSample(1.0), mode: "autonomous" }),
        ),
        "speak-now",
      );
    });

    it("downgrades to bundle when rate-limited", () => {
      const now = new Date();
      const recentSurfaceTimes = [
        new Date(now.getTime() - 1000),
        new Date(now.getTime() - 2000),
      ];
      assert.equal(
        computeUrgencyDecision(
          makeInput({
            sample: makeSample(0.9),
            mode: "volunteer",
            recentSurfaceTimes,
            maxSurfacePerHour: 2,
          }),
        ),
        "bundle-for-session",
      );
    });
  });

  describe("moderate urgency (>= 0.5, < 0.8)", () => {
    it("returns bundle-for-session for volunteer mode", () => {
      assert.equal(
        computeUrgencyDecision(
          makeInput({ sample: makeSample(0.5), mode: "volunteer" }),
        ),
        "bundle-for-session",
      );
    });

    it("returns bundle-for-session for anticipatory mode", () => {
      assert.equal(
        computeUrgencyDecision(
          makeInput({ sample: makeSample(0.7), mode: "anticipatory" }),
        ),
        "bundle-for-session",
      );
    });

    it("returns bundle-for-session for autonomous mode", () => {
      assert.equal(
        computeUrgencyDecision(
          makeInput({ sample: makeSample(0.6), mode: "autonomous" }),
        ),
        "bundle-for-session",
      );
    });
  });

  describe("low urgency (< 0.5)", () => {
    it("returns log-only for all non-silent modes", () => {
      for (const mode of [
        "volunteer",
        "anticipatory",
        "autonomous",
      ] as const) {
        assert.equal(
          computeUrgencyDecision(
            makeInput({ sample: makeSample(0.3), mode }),
          ),
          "log-only",
        );
      }
    });

    it("returns log-only for zero urgency", () => {
      assert.equal(
        computeUrgencyDecision(
          makeInput({ sample: makeSample(0.0), mode: "autonomous" }),
        ),
        "log-only",
      );
    });
  });

  describe("rate limiting", () => {
    it("does not rate-limit when under the threshold", () => {
      const now = new Date();
      const recentSurfaceTimes = [new Date(now.getTime() - 1000)];
      assert.equal(
        computeUrgencyDecision(
          makeInput({
            sample: makeSample(0.9),
            mode: "volunteer",
            recentSurfaceTimes,
            maxSurfacePerHour: 2,
          }),
        ),
        "speak-now",
      );
    });

    it("ignores rate limiting when no times provided", () => {
      assert.equal(
        computeUrgencyDecision(
          makeInput({
            sample: makeSample(0.9),
            mode: "volunteer",
            maxSurfacePerHour: 2,
          }),
        ),
        "speak-now",
      );
    });

    it("ignores old surface times outside the hour window", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      assert.equal(
        computeUrgencyDecision(
          makeInput({
            sample: makeSample(0.9),
            mode: "volunteer",
            recentSurfaceTimes: [twoHoursAgo, twoHoursAgo],
            maxSurfacePerHour: 2,
          }),
        ),
        "speak-now",
      );
    });
  });
});
