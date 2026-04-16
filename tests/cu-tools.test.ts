/**
 * Tests for src/mcp/cu-tools.ts — MCP round-trip with a fake Actuator
 * and a fake AX bridge.
 *
 * Verifies zod validation, actuator delegation, response shape, and
 * null-element propagation from `cu_find_element`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CuTools } from "../src/mcp/cu-tools.js";
import type { Actuator, ScreenshotResult, NativeBridge } from "../src/computer-use/actuator.js";

// ────────────────────── Fakes ───────────────────────────────────────────

class FakeActuator implements Actuator {
  public calls: Array<{ op: string; args: unknown[] }> = [];
  public shot: ScreenshotResult = { path: "/tmp/a.png", width: 800, height: 600 };

  async click(x: number, y: number, button?: "left" | "right"): Promise<void> {
    this.calls.push({ op: "click", args: [x, y, button] });
  }
  async doubleClick(x: number, y: number): Promise<void> {
    this.calls.push({ op: "double", args: [x, y] });
  }
  async moveTo(x: number, y: number): Promise<void> {
    this.calls.push({ op: "move", args: [x, y] });
  }
  async type(text: string, delayMs?: number): Promise<void> {
    this.calls.push({ op: "type", args: [text, delayMs] });
  }
  async scroll(x: number, y: number, dy: number, dx?: number): Promise<void> {
    this.calls.push({ op: "scroll", args: [x, y, dy, dx] });
  }
  async screenshot(): Promise<ScreenshotResult> {
    this.calls.push({ op: "screenshot", args: [] });
    return this.shot;
  }
}

class FakeAxBridge implements NativeBridge {
  public calls: string[][] = [];
  public responses: string[] = [];
  async run(args: string[]): Promise<string> {
    this.calls.push(args.slice());
    return this.responses.shift() ?? "";
  }
}

// ────────────────────── cu_click ────────────────────────────────────────

describe("cu_click", () => {
  test("delegates to actuator.click with default button=left", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    const result = await tools.click({ x: 100, y: 200 });
    assert.deepEqual(result, { ok: true, x: 100, y: 200, button: "left" });
    assert.deepEqual(actuator.calls[0]!.args, [100, 200, "left"]);
  });

  test("passes button=right when supplied", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    await tools.click({ x: 1, y: 2, button: "right" });
    assert.equal(actuator.calls[0]!.args[2], "right");
  });

  test("rejects out-of-range coords", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    await assert.rejects(() => tools.click({ x: -1, y: 0 }));
    await assert.rejects(() => tools.click({ x: 0, y: 99_999 }));
    assert.equal(actuator.calls.length, 0);
  });

  test("rejects missing x", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    await assert.rejects(() => tools.click({ y: 10 }));
  });
});

// ────────────────────── cu_type ─────────────────────────────────────────

describe("cu_type", () => {
  test("delegates to actuator.type", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    const result = await tools.type({ text: "hello" });
    assert.deepEqual(result, { ok: true, length: 5 });
    assert.deepEqual(actuator.calls[0]!.args, ["hello", undefined]);
  });

  test("passes delayMs when supplied", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    await tools.type({ text: "hi", delayMs: 25 });
    assert.equal(actuator.calls[0]!.args[1], 25);
  });

  test("rejects empty text", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    await assert.rejects(() => tools.type({ text: "" }));
  });

  test("rejects text > 10000 chars at the MCP boundary", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    await assert.rejects(() => tools.type({ text: "a".repeat(10_001) }));
  });
});

// ────────────────────── cu_screenshot ───────────────────────────────────

describe("cu_screenshot", () => {
  test("returns path/width/height from actuator", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    const result = await tools.screenshot({});
    assert.deepEqual(result, {
      ok: true,
      path: "/tmp/a.png",
      width: 800,
      height: 600,
    });
  });

  test("accepts null/undefined input", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    await tools.screenshot(undefined);
    assert.equal(actuator.calls.length, 1);
  });
});

// ────────────────────── cu_find_element ─────────────────────────────────

describe("cu_find_element", () => {
  test("returns null when helper reports `{match: 'none'}`", async () => {
    const actuator = new FakeActuator();
    const bridge = new FakeAxBridge();
    bridge.responses.push(JSON.stringify({ match: "none" }));
    const tools = new CuTools({
      actuator,
      accessibilityDeps: { bridge },
    });
    const result = await tools.findElement({ role: "AXButton" });
    assert.deepEqual(result, { ok: true, element: null });
  });

  test("returns the matched element", async () => {
    const actuator = new FakeActuator();
    const bridge = new FakeAxBridge();
    bridge.responses.push(
      JSON.stringify({
        role: "AXButton",
        label: "Send",
        bbox: { x: 1, y: 2, w: 3, h: 4 },
        pid: 9,
      }),
    );
    const tools = new CuTools({
      actuator,
      accessibilityDeps: { bridge },
    });
    const result = await tools.findElement({ role: "AXButton", label: "Send" });
    assert.equal(result.element?.label, "Send");
    assert.equal(result.element?.pid, 9);
    assert.deepEqual(bridge.calls[0]!.slice(0, 4), [
      "ax",
      "find",
      "--role",
      "AXButton",
    ]);
  });

  test("rejects empty role", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    await assert.rejects(() => tools.findElement({ role: "" }));
  });
});

// ────────────────────── cu_scroll ───────────────────────────────────────

describe("cu_scroll", () => {
  test("delegates to actuator.scroll with dx defaulting to 0", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    const result = await tools.scroll({ x: 10, y: 20, dy: -3 });
    assert.deepEqual(result, { ok: true, x: 10, y: 20, dy: -3, dx: 0 });
    assert.deepEqual(actuator.calls[0]!.args, [10, 20, -3, 0]);
  });

  test("passes dx when provided", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    await tools.scroll({ x: 1, y: 2, dy: 3, dx: 4 });
    assert.equal(actuator.calls[0]!.args[3], 4);
  });

  test("rejects non-integer dy", async () => {
    const actuator = new FakeActuator();
    const tools = new CuTools({ actuator });
    await assert.rejects(() => tools.scroll({ x: 1, y: 2, dy: 1.5 }));
  });
});
