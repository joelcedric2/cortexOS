/**
 * Tests for src/computer-use/actuator.ts — mocked NativeBridge.
 *
 * Verifies:
 *   - each primitive shells the correct `cortexos-vision input <op>` arg array
 *   - bounds clamping raises `OutOfBoundsError` (not a silent clamp)
 *   - type() length cap raises `TextTooLongError`
 *   - audit append fires `{action: 'cu_action', detail}` on every op
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createActuator,
  ACTUATOR_DEFAULTS,
  OutOfBoundsError,
  TextTooLongError,
  ActuatorError,
  type NativeBridge,
} from "../src/computer-use/actuator.js";
import type { AuditAction, AuditEntry } from "../src/proactivity/audit.js";

// ─────────────── Fakes ──────────────────────────────────────────────────

class FakeBridge implements NativeBridge {
  public calls: string[][] = [];
  public responses: string[] = [];
  async run(args: string[]): Promise<string> {
    this.calls.push(args.slice());
    return this.responses.shift() ?? "";
  }
}

class FakeAudit {
  public entries: AuditEntry[] = [];
  append(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}

// ─────────────── Primitives → subcommand ────────────────────────────────

describe("actuator.click", () => {
  test("issues `input click --x --y --button left` by default", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await actuator.click(100, 200);
    assert.deepEqual(bridge.calls, [
      ["input", "click", "--x", "100", "--y", "200", "--button", "left"],
    ]);
  });

  test("passes button=right when requested", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await actuator.click(1, 2, "right");
    assert.equal(bridge.calls[0]![7], "right");
  });

  test("rejects invalid button", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await assert.rejects(
      () => actuator.click(1, 2, "middle" as "left"),
      ActuatorError,
    );
    assert.equal(bridge.calls.length, 0); // never shelled
  });
});

describe("actuator.doubleClick", () => {
  test("issues `input double-click --x --y`", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await actuator.doubleClick(50, 60);
    assert.deepEqual(bridge.calls, [
      ["input", "double-click", "--x", "50", "--y", "60"],
    ]);
  });
});

describe("actuator.moveTo", () => {
  test("issues `input move --x --y`", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await actuator.moveTo(10, 20);
    assert.deepEqual(bridge.calls, [
      ["input", "move", "--x", "10", "--y", "20"],
    ]);
  });
});

describe("actuator.type", () => {
  test("issues `input type --text <text>`", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await actuator.type("hello world");
    assert.deepEqual(bridge.calls, [["input", "type", "--text", "hello world"]]);
  });

  test("appends --delay-ms when provided", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await actuator.type("hi", 25);
    assert.deepEqual(bridge.calls, [
      ["input", "type", "--text", "hi", "--delay-ms", "25"],
    ]);
  });

  test("rejects text longer than maxTypeLength", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    const huge = "a".repeat(ACTUATOR_DEFAULTS.maxTypeLength + 1);
    await assert.rejects(() => actuator.type(huge), TextTooLongError);
    assert.equal(bridge.calls.length, 0);
  });

  test("accepts text exactly at the cap", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    const exact = "a".repeat(ACTUATOR_DEFAULTS.maxTypeLength);
    await actuator.type(exact);
    assert.equal(bridge.calls.length, 1);
  });

  test("rejects negative delayMs", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await assert.rejects(() => actuator.type("x", -1), ActuatorError);
  });
});

describe("actuator.scroll", () => {
  test("issues `input scroll --x --y --dy --dx`", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await actuator.scroll(100, 200, -3);
    assert.deepEqual(bridge.calls, [
      ["input", "scroll", "--x", "100", "--y", "200", "--dy", "-3", "--dx", "0"],
    ]);
  });

  test("passes dx when provided", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await actuator.scroll(1, 2, 3, 4);
    assert.equal(bridge.calls[0]![9], "4");
  });
});

describe("actuator.screenshot", () => {
  test("parses `{path,width,height}` JSON from the helper", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(
      JSON.stringify({ path: "/tmp/foo.png", width: 2560, height: 1440 }),
    );
    const actuator = createActuator({ bridge });
    const out = await actuator.screenshot();
    assert.deepEqual(out, { path: "/tmp/foo.png", width: 2560, height: 1440 });
  });

  test("accepts `png_path` alias (matches CaptureCommand JSON shape)", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push(
      JSON.stringify({ png_path: "/tmp/b.png", width: 100, height: 200 }),
    );
    const actuator = createActuator({ bridge });
    const out = await actuator.screenshot();
    assert.equal(out.path, "/tmp/b.png");
  });

  test("throws on invalid JSON", async () => {
    const bridge = new FakeBridge();
    bridge.responses.push("not-json");
    const actuator = createActuator({ bridge });
    await assert.rejects(() => actuator.screenshot(), ActuatorError);
  });
});

// ─────────────── Bounds clamping ────────────────────────────────────────

describe("bounds clamping (OutOfBoundsError, not silent)", () => {
  test("rejects negative x", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await assert.rejects(() => actuator.click(-1, 0), OutOfBoundsError);
    assert.equal(bridge.calls.length, 0);
  });

  test("rejects y > maxCoord", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await assert.rejects(
      () => actuator.click(0, ACTUATOR_DEFAULTS.maxCoord + 1),
      OutOfBoundsError,
    );
  });

  test("rejects NaN / non-integer", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await assert.rejects(() => actuator.click(Number.NaN, 0), OutOfBoundsError);
    await assert.rejects(() => actuator.click(1.5, 0), OutOfBoundsError);
  });

  test("accepts boundary values 0 and maxCoord", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await actuator.click(0, 0);
    await actuator.click(
      ACTUATOR_DEFAULTS.maxCoord,
      ACTUATOR_DEFAULTS.maxCoord,
    );
    assert.equal(bridge.calls.length, 2);
  });

  test("scroll + moveTo + doubleClick all enforce bounds", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await assert.rejects(() => actuator.moveTo(-1, 0), OutOfBoundsError);
    await assert.rejects(() => actuator.doubleClick(0, 99_999), OutOfBoundsError);
    await assert.rejects(() => actuator.scroll(-5, 0, 0), OutOfBoundsError);
  });
});

// ─────────────── Audit wiring ───────────────────────────────────────────

describe("audit wiring", () => {
  test("every primitive appends a `cu_action` entry", async () => {
    const bridge = new FakeBridge();
    const audit = new FakeAudit();
    const actuator = createActuator({ bridge, audit });

    await actuator.click(1, 2);
    await actuator.doubleClick(3, 4);
    await actuator.moveTo(5, 6);
    await actuator.type("abc");
    await actuator.scroll(7, 8, -2);

    // Prime the screenshot JSON only — other primitives ignore stdout.
    bridge.responses.push(
      JSON.stringify({ path: "/tmp/x.png", width: 1, height: 2 }),
    );
    await actuator.screenshot();

    assert.equal(audit.entries.length, 6);
    const actions = new Set(audit.entries.map((e) => e.action as AuditAction));
    assert.deepEqual([...actions], ["cu_action"]);
    assert.match(audit.entries[0]!.detail, /click x=1 y=2 button=left/);
    assert.match(audit.entries[3]!.detail, /type length=3/);
  });

  test("audit append failure is logged but does not break actuation", async () => {
    const bridge = new FakeBridge();
    const brokenAudit = {
      append(): void {
        throw new Error("disk full");
      },
    };
    const actuator = createActuator({ bridge, audit: brokenAudit });
    // Swallow the warning log for clean test output.
    const origWarn = console.warn;
    console.warn = (): void => undefined;
    try {
      await actuator.click(1, 2); // must resolve, not reject
    } finally {
      console.warn = origWarn;
    }
    assert.equal(bridge.calls.length, 1);
  });

  test("no audit sink → no crash", async () => {
    const bridge = new FakeBridge();
    const actuator = createActuator({ bridge });
    await actuator.click(1, 2);
    assert.equal(bridge.calls.length, 1);
  });
});
