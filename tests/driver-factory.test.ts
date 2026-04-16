import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetDriverCache,
  selectDriver,
  WMUnavailableError,
  type WMDriver,
} from "../src/window-manager/driver-factory.js";

// --------------------------- Stub drivers --------------------------------

function stubDriver(label: string, available: boolean, throwOnProbe = false): WMDriver {
  return {
    async isAvailable(): Promise<boolean> {
      if (throwOnProbe) throw new Error(`${label} probe failed`);
      return available;
    },
    async listWindows() {
      return [];
    },
    async listSpaces() {
      return [];
    },
    async focusWindow() {
      // Mark which stub got selected so tests can assert on identity.
      (this as { probed?: string }).probed = label;
    },
    async moveWindow() {
      /* no-op */
    },
    async tile() {
      /* no-op */
    },
    async spaceSwitch() {
      /* no-op */
    },
  };
}

// --------------------------- Tests ---------------------------------------

describe("selectDriver", () => {
  beforeEach(() => resetDriverCache());

  test("prefers yabai when both probes succeed", async () => {
    const yabai = stubDriver("yabai", true);
    const applescript = stubDriver("applescript", true);
    const driver = await selectDriver({
      yabaiFactory: () => yabai,
      appleScriptFactory: () => applescript,
    });
    assert.equal(driver, yabai);
  });

  test("falls back to AppleScript when yabai probe fails", async () => {
    const yabai = stubDriver("yabai", false);
    const applescript = stubDriver("applescript", true);
    const driver = await selectDriver({
      yabaiFactory: () => yabai,
      appleScriptFactory: () => applescript,
    });
    assert.equal(driver, applescript);
  });

  test("falls back to AppleScript when yabai probe throws", async () => {
    const yabai = stubDriver("yabai", false, /* throwOnProbe */ true);
    const applescript = stubDriver("applescript", true);
    const driver = await selectDriver({
      yabaiFactory: () => yabai,
      appleScriptFactory: () => applescript,
    });
    assert.equal(driver, applescript);
  });

  test("returns unavailable driver when both probes fail", async () => {
    const yabai = stubDriver("yabai", false);
    const applescript = stubDriver("applescript", false);
    const driver = await selectDriver({
      yabaiFactory: () => yabai,
      appleScriptFactory: () => applescript,
    });
    assert.equal(await driver.isAvailable(), false);
    await assert.rejects(
      () => driver.listWindows(),
      (err: unknown) => err instanceof WMUnavailableError,
    );
    await assert.rejects(
      () => driver.tile("full"),
      (err: unknown) => err instanceof WMUnavailableError,
    );
    await assert.rejects(
      () => driver.spaceSwitch(1),
      (err: unknown) => err instanceof WMUnavailableError,
    );
  });

  test("caches the selected driver for the process lifetime", async () => {
    let yabaiCalls = 0;
    const yabaiFactory = () => {
      yabaiCalls++;
      return stubDriver("yabai", true);
    };
    const first = await selectDriver({ yabaiFactory });
    const second = await selectDriver({ yabaiFactory });
    assert.equal(first, second);
    assert.equal(yabaiCalls, 1, "factory called only on first selectDriver()");
  });

  test("resetDriverCache forces re-probe", async () => {
    let yabaiCalls = 0;
    const yabaiFactory = () => {
      yabaiCalls++;
      return stubDriver("yabai", true);
    };
    await selectDriver({ yabaiFactory });
    resetDriverCache();
    await selectDriver({ yabaiFactory });
    assert.equal(yabaiCalls, 2);
  });

  test("unavailable driver's isAvailable() returns false (not a throw)", async () => {
    const yabai = stubDriver("yabai", false);
    const applescript = stubDriver("applescript", false);
    const driver = await selectDriver({
      yabaiFactory: () => yabai,
      appleScriptFactory: () => applescript,
    });
    // Never throws from isAvailable — only action methods throw.
    assert.equal(await driver.isAvailable(), false);
  });

  test("yabai-present path doesn't construct the AppleScript driver", async () => {
    let appleScriptConstructed = false;
    const yabai = stubDriver("yabai", true);
    const driver = await selectDriver({
      yabaiFactory: () => yabai,
      appleScriptFactory: () => {
        appleScriptConstructed = true;
        return stubDriver("applescript", true);
      },
    });
    assert.equal(driver, yabai);
    assert.equal(appleScriptConstructed, false, "AppleScript factory should not run");
  });
});
