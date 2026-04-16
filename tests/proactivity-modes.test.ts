import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProactivityModeManager,
  MODE_DEFAULTS,
  type ProactivityMode,
} from "../src/proactivity/modes.js";

describe("ProactivityModeManager", () => {
  it("defaults to volunteer mode", () => {
    const mgr = new ProactivityModeManager();
    assert.equal(mgr.getMode(), "volunteer");
  });

  it("accepts an initial mode", () => {
    const mgr = new ProactivityModeManager("silent");
    assert.equal(mgr.getMode(), "silent");
  });

  it("switches modes via setMode", () => {
    const mgr = new ProactivityModeManager();
    mgr.setMode("autonomous");
    assert.equal(mgr.getMode(), "autonomous");
  });

  it("returns correct config per mode", () => {
    const modes: ProactivityMode[] = [
      "silent",
      "volunteer",
      "anticipatory",
      "autonomous",
    ];
    for (const mode of modes) {
      const mgr = new ProactivityModeManager(mode);
      const config = mgr.getConfig();
      assert.equal(config.mode, mode);
      assert.equal(config.speakAllowed, MODE_DEFAULTS[mode].speakAllowed);
      assert.equal(config.actionAllowed, MODE_DEFAULTS[mode].actionAllowed);
      assert.equal(
        config.maxSurfacePerHour,
        MODE_DEFAULTS[mode].maxSurfacePerHour,
      );
    }
  });

  it("silent mode disallows speaking and action", () => {
    const config = MODE_DEFAULTS["silent"];
    assert.equal(config.speakAllowed, false);
    assert.equal(config.actionAllowed, false);
    assert.equal(config.maxSurfacePerHour, 0);
  });

  it("volunteer mode allows speaking but not action", () => {
    const config = MODE_DEFAULTS["volunteer"];
    assert.equal(config.speakAllowed, true);
    assert.equal(config.actionAllowed, false);
  });

  it("anticipatory mode allows speaking and reversible action", () => {
    const config = MODE_DEFAULTS["anticipatory"];
    assert.equal(config.speakAllowed, true);
    assert.equal(config.actionAllowed, true);
    assert.equal(config.maxSurfacePerHour, 2);
  });

  it("autonomous mode has highest rate limit", () => {
    const config = MODE_DEFAULTS["autonomous"];
    assert.equal(config.speakAllowed, true);
    assert.equal(config.actionAllowed, true);
    assert.equal(config.maxSurfacePerHour, 10);
  });

  describe("quiet timer", () => {
    it("is not quiet by default", () => {
      const mgr = new ProactivityModeManager();
      assert.equal(mgr.isQuiet(), false);
    });

    it("goes quiet for a duration", () => {
      const mgr = new ProactivityModeManager();
      mgr.goQuiet(60_000); // 1 minute
      assert.equal(mgr.isQuiet(), true);
    });

    it("includes quietUntil in config when quiet", () => {
      const mgr = new ProactivityModeManager();
      mgr.goQuiet(60_000);
      const config = mgr.getConfig();
      assert.ok(config.quietUntil instanceof Date);
      assert.ok(config.quietUntil > new Date());
    });

    it("ignores zero or negative duration", () => {
      const mgr = new ProactivityModeManager();
      mgr.goQuiet(0);
      assert.equal(mgr.isQuiet(), false);
      mgr.goQuiet(-100);
      assert.equal(mgr.isQuiet(), false);
    });

    it("expires after the duration elapses", () => {
      const mgr = new ProactivityModeManager();
      // Set quiet to already-expired time by manipulating internals
      mgr.goQuiet(1); // 1ms
      // Wait a tick
      const start = Date.now();
      while (Date.now() - start < 5) {
        /* spin */
      }
      assert.equal(mgr.isQuiet(), false);
    });
  });
});
