import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GlobalHotkey } from "../src/voice/hotkey.js";

describe("GlobalHotkey", () => {
  test("fires onPress callback when simulatePress is called", () => {
    let pressed = false;
    const hotkey = new GlobalHotkey({
      onPress: () => { pressed = true; },
    });
    hotkey.register();

    hotkey.simulatePress();
    assert.equal(pressed, true);
  });

  test("fires onRelease callback when simulateRelease is called", () => {
    let released = false;
    const hotkey = new GlobalHotkey({
      onPress: () => {},
      onRelease: () => { released = true; },
    });
    hotkey.register();

    hotkey.simulateRelease();
    assert.equal(released, true);
  });

  test("defaults to cmd+shift+space combo", () => {
    const hotkey = new GlobalHotkey({ onPress: () => {} });
    assert.equal(hotkey.getCombo(), "cmd+shift+space");
  });

  test("accepts custom combo", () => {
    const hotkey = new GlobalHotkey({
      combo: "ctrl+alt+v",
      onPress: () => {},
    });
    assert.equal(hotkey.getCombo(), "ctrl+alt+v");
  });

  test("register/unregister toggle isRegistered", () => {
    const hotkey = new GlobalHotkey({ onPress: () => {} });
    assert.equal(hotkey.isRegistered(), false);

    hotkey.register();
    assert.equal(hotkey.isRegistered(), true);

    hotkey.unregister();
    assert.equal(hotkey.isRegistered(), false);
  });

  test("register is idempotent", () => {
    let pressCount = 0;
    const hotkey = new GlobalHotkey({ onPress: () => { pressCount++; } });

    hotkey.register();
    hotkey.register(); // second call is a no-op

    hotkey.simulatePress();
    assert.equal(pressCount, 1);
  });

  test("simulatePress works without register (stub behavior)", () => {
    let pressed = false;
    const hotkey = new GlobalHotkey({ onPress: () => { pressed = true; } });

    // Even without register(), the programmatic trigger should work.
    hotkey.simulatePress();
    assert.equal(pressed, true);
  });

  test("simulateRelease is a no-op when onRelease not provided", () => {
    const hotkey = new GlobalHotkey({ onPress: () => {} });
    // Should not throw.
    hotkey.simulateRelease();
  });
});
