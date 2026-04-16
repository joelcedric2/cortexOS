/**
 * MCP window-manager tools — handler unit tests.
 *
 * Asserts each tool:
 *   • Round-trips through a fake driver.
 *   • Rejects malformed input with a structured `invalid-input` envelope.
 *   • Surfaces WMUnavailableError cleanly as `{ok:false,error:"wm-unavailable"}`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { WmTools } from "../src/mcp/wm-tools.js";
import {
  WMUnavailableError,
  type WMDriver,
  type Window as WMWindow,
  type Space as WMSpace,
  type Layout as WMTileLayout,
  type MoveTarget,
} from "../src/window-manager/driver-factory.js";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface MoveCall {
  windowId: number;
  space?: number;
  display?: number;
  frame?: { x?: number; y?: number; w?: number; h?: number };
}

class FakeDriver implements WMDriver {
  public moveCalls: MoveCall[] = [];
  public focusCalls: number[] = [];
  public tileCalls: WMTileLayout[] = [];
  public spaceCalls: number[] = [];
  public windows: WMWindow[] = [];
  public spaces: WMSpace[] = [];
  public failTile = false;

  async isAvailable(): Promise<boolean> { return true; }
  async listWindows(): Promise<WMWindow[]> { return this.windows; }
  async listSpaces(): Promise<WMSpace[]> { return this.spaces; }
  async focusWindow(id: number): Promise<void> { this.focusCalls.push(id); }
  async moveWindow(
    id: number,
    to: MoveTarget,
  ): Promise<void> {
    this.moveCalls.push({ windowId: id, ...to });
  }
  async tile(layout: WMTileLayout): Promise<void> {
    if (this.failTile) throw new Error("yabai: space has no leaf");
    this.tileCalls.push(layout);
  }
  async spaceSwitch(index: number): Promise<void> { this.spaceCalls.push(index); }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WmTools.moveWindow", () => {
  test("round-trips valid input through the driver", async () => {
    const driver = new FakeDriver();
    const tools = new WmTools({ driver });
    const res = await tools.moveWindow({
      windowId: 42,
      space: 2,
      x: 100,
      y: 200,
      w: 640,
      h: 480,
    });
    assert.deepEqual(res, { ok: true, windowId: 42 });
    assert.equal(driver.moveCalls.length, 1);
    assert.deepEqual(driver.moveCalls[0], {
      windowId: 42,
      space: 2,
      display: undefined,
      frame: { x: 100, y: 200, w: 640, h: 480 },
    });
  });

  test("rejects missing windowId with invalid-input", async () => {
    const driver = new FakeDriver();
    const tools = new WmTools({ driver });
    const res = await tools.moveWindow({ x: 1 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "invalid-input");
    assert.equal(driver.moveCalls.length, 0);
  });

  test("rejects non-integer windowId", async () => {
    const driver = new FakeDriver();
    const tools = new WmTools({ driver });
    const res = await tools.moveWindow({ windowId: 3.14 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "invalid-input");
  });
});

describe("WmTools.tile", () => {
  test("grid-2x2 calls through to driver.tile", async () => {
    const driver = new FakeDriver();
    const tools = new WmTools({ driver });
    const res = await tools.tile({ layout: "grid-2x2" });
    assert.deepEqual(res, { ok: true, layout: "grid-2x2" });
    assert.deepEqual(driver.tileCalls, ["grid-2x2"]);
  });

  test("rejects unknown layout with invalid-input", async () => {
    const driver = new FakeDriver();
    const tools = new WmTools({ driver });
    const res = await tools.tile({ layout: "spiral" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "invalid-input");
    assert.equal(driver.tileCalls.length, 0);
  });

  test("driver failure surfaces as driver-failure envelope", async () => {
    const driver = new FakeDriver();
    driver.failTile = true;
    const tools = new WmTools({ driver });
    const res = await tools.tile({ layout: "full" });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, "driver-failure");
      assert.match(res.message ?? "", /yabai/);
    }
  });
});

describe("WmTools.focus", () => {
  test("calls driver.focusWindow with the given id", async () => {
    const driver = new FakeDriver();
    const tools = new WmTools({ driver });
    const res = await tools.focus({ windowId: 7 });
    assert.deepEqual(res, { ok: true, windowId: 7 });
    assert.deepEqual(driver.focusCalls, [7]);
  });

  test("rejects non-positive windowId", async () => {
    const driver = new FakeDriver();
    const tools = new WmTools({ driver });
    const res = await tools.focus({ windowId: 0 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "invalid-input");
  });
});

describe("WmTools.spaceSwitch", () => {
  test("calls driver.spaceSwitch with 1-indexed space", async () => {
    const driver = new FakeDriver();
    const tools = new WmTools({ driver });
    const res = await tools.spaceSwitch({ index: 3 });
    assert.deepEqual(res, { ok: true, index: 3 });
    assert.deepEqual(driver.spaceCalls, [3]);
  });

  test("rejects zero index", async () => {
    const driver = new FakeDriver();
    const tools = new WmTools({ driver });
    const res = await tools.spaceSwitch({ index: 0 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "invalid-input");
  });
});

describe("WmTools.listWindows", () => {
  test("returns windows + spaces from the driver", async () => {
    const driver = new FakeDriver();
    driver.windows = [
      {
        id: 1,
        app: "Terminal",
        title: "agent-coder-1",
        space: 1,
        display: 1,
        frame: { x: 0, y: 0, w: 800, h: 600 },
        focused: true,
      },
    ];
    driver.spaces = [{ index: 1, display: 1, type: "bsp" }];
    const tools = new WmTools({ driver });
    const res = await tools.listWindows();
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.windows.length, 1);
      assert.equal(res.spaces[0].index, 1);
    }
  });

  test("rejects extraneous properties", async () => {
    const driver = new FakeDriver();
    const tools = new WmTools({ driver });
    const res = await tools.listWindows({ foo: "bar" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "invalid-input");
  });
});

describe("WmTools — WMUnavailableError handling", () => {
  test("surfaces wm-unavailable when selectDriver throws WMUnavailableError", async () => {
    const tools = new WmTools({
      selectDriver: async () => {
        throw new WMUnavailableError("neither yabai nor applescript");
      },
    });
    const res = await tools.listWindows();
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, "wm-unavailable");
      assert.match(res.message ?? "", /yabai/);
    }
  });

  test("all five tools surface wm-unavailable consistently", async () => {
    const selectDriver = async () => {
      throw new WMUnavailableError();
    };
    const tools = new WmTools({ selectDriver });
    const results = await Promise.all([
      tools.moveWindow({ windowId: 1 }),
      tools.tile({ layout: "full" }),
      tools.focus({ windowId: 1 }),
      tools.spaceSwitch({ index: 1 }),
      tools.listWindows(),
    ]);
    for (const r of results) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, "wm-unavailable");
    }
  });

  test("unexpected selector errors surface as driver-failure", async () => {
    const tools = new WmTools({
      selectDriver: async () => {
        throw new Error("boom");
      },
    });
    const res = await tools.focus({ windowId: 1 });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error, "driver-failure");
      assert.match(res.message ?? "", /boom/);
    }
  });
});
