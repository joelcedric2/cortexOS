import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createYabaiDriver,
  YabaiCommandError,
  type YabaiExec,
} from "../src/window-manager/yabai-bridge.js";

// --------------------------- fake exec helper ----------------------------

interface FakeExecCall {
  args: string[];
}

interface FakeExecSetup {
  /**
   * Map from argv-joined-with-space → response. Missing keys throw a
   * YabaiCommandError so tests fail loudly on unexpected calls.
   */
  responses?: Record<string, string>;
  /** If provided, every call fails with this error (simulates missing yabai). */
  alwaysFail?: boolean;
}

function makeFakeExec(setup: FakeExecSetup): {
  exec: YabaiExec;
  calls: FakeExecCall[];
} {
  const calls: FakeExecCall[] = [];
  const exec: YabaiExec = async (args) => {
    calls.push({ args: [...args] });
    if (setup.alwaysFail) {
      throw new YabaiCommandError(args, 127, "yabai: command not found");
    }
    const key = args.join(" ");
    const response = setup.responses?.[key];
    if (response === undefined) {
      throw new YabaiCommandError(args, 1, `no fake response registered for: ${key}`);
    }
    return response;
  };
  return { exec, calls };
}

// --------------------------- JSON fixtures -------------------------------

const WINDOWS_JSON = JSON.stringify([
  {
    id: 101,
    app: "iTerm2",
    title: "coder-1 — tmux",
    space: 1,
    display: 1,
    frame: { x: 0, y: 0, w: 800, h: 500 },
    "has-focus": true,
  },
  {
    id: 102,
    app: "iTerm2",
    title: "coder-2 — tmux",
    space: 1,
    display: 1,
    frame: { x: 800, y: 0, w: 800, h: 500 },
    "has-focus": false,
  },
]);

const SPACES_JSON = JSON.stringify([
  { index: 1, display: 1, type: "bsp" },
  { index: 2, display: 1, type: "stack" },
  { index: 3, display: 2, type: "float" },
]);

// --------------------------- isAvailable ---------------------------------

describe("createYabaiDriver — isAvailable", () => {
  test("returns true when `query --spaces` succeeds", async () => {
    const { exec } = makeFakeExec({
      responses: { "-m query --spaces": SPACES_JSON },
    });
    const driver = createYabaiDriver(exec);
    assert.equal(await driver.isAvailable(), true);
  });

  test("returns false when yabai is missing", async () => {
    const { exec } = makeFakeExec({ alwaysFail: true });
    const driver = createYabaiDriver(exec);
    assert.equal(await driver.isAvailable(), false);
  });
});

// --------------------------- listWindows ---------------------------------

describe("createYabaiDriver — listWindows", () => {
  test("parses typed Window[] from yabai JSON", async () => {
    const { exec } = makeFakeExec({
      responses: { "-m query --windows": WINDOWS_JSON },
    });
    const driver = createYabaiDriver(exec);
    const windows = await driver.listWindows();
    assert.equal(windows.length, 2);
    assert.equal(windows[0].id, 101);
    assert.equal(windows[0].app, "iTerm2");
    assert.equal(windows[0].focused, true);
    assert.equal(windows[0].frame.w, 800);
    assert.equal(windows[1].focused, false);
  });

  test("throws when JSON payload is not an array", async () => {
    const { exec } = makeFakeExec({
      responses: { "-m query --windows": '{"not":"array"}' },
    });
    const driver = createYabaiDriver(exec);
    await assert.rejects(() => driver.listWindows(), /expected JSON array/);
  });

  test("throws when window entry is missing fields", async () => {
    const { exec } = makeFakeExec({
      responses: {
        "-m query --windows": JSON.stringify([{ id: 1, app: "x" }]), // no frame
      },
    });
    const driver = createYabaiDriver(exec);
    await assert.rejects(() => driver.listWindows(), /missing frame/);
  });

  test("surfaces YabaiCommandError on CLI failure", async () => {
    const { exec } = makeFakeExec({ alwaysFail: true });
    const driver = createYabaiDriver(exec);
    await assert.rejects(
      () => driver.listWindows(),
      (err: unknown) => err instanceof YabaiCommandError,
    );
  });
});

// --------------------------- listSpaces ----------------------------------

describe("createYabaiDriver — listSpaces", () => {
  test("parses typed Space[] including type enum", async () => {
    const { exec } = makeFakeExec({
      responses: { "-m query --spaces": SPACES_JSON },
    });
    const driver = createYabaiDriver(exec);
    const spaces = await driver.listSpaces();
    assert.deepEqual(spaces, [
      { index: 1, display: 1, type: "bsp" },
      { index: 2, display: 1, type: "stack" },
      { index: 3, display: 2, type: "float" },
    ]);
  });

  test("unknown space types normalise to 'float'", async () => {
    const { exec } = makeFakeExec({
      responses: {
        "-m query --spaces": JSON.stringify([
          { index: 1, display: 1, type: "weird-custom" },
        ]),
      },
    });
    const driver = createYabaiDriver(exec);
    const spaces = await driver.listSpaces();
    assert.equal(spaces[0].type, "float");
  });
});

// --------------------------- focusWindow / spaceSwitch -------------------

describe("createYabaiDriver — focus + spaceSwitch", () => {
  test("focusWindow issues `window <id> --focus`", async () => {
    const { exec, calls } = makeFakeExec({
      responses: { "-m window 101 --focus": "" },
    });
    await createYabaiDriver(exec).focusWindow(101);
    assert.deepEqual(calls[0].args, ["-m", "window", "101", "--focus"]);
  });

  test("focusWindow rejects non-integer ids", async () => {
    const driver = createYabaiDriver(async () => "");
    await assert.rejects(() => driver.focusWindow(-1), RangeError);
    await assert.rejects(() => driver.focusWindow(1.5), RangeError);
  });

  test("spaceSwitch issues `space --focus <index>`", async () => {
    const { exec, calls } = makeFakeExec({
      responses: { "-m space --focus 2": "" },
    });
    await createYabaiDriver(exec).spaceSwitch(2);
    assert.deepEqual(calls[0].args, ["-m", "space", "--focus", "2"]);
  });
});

// --------------------------- moveWindow ----------------------------------

describe("createYabaiDriver — moveWindow", () => {
  test("emits space + display + abs frame commands", async () => {
    const { exec, calls } = makeFakeExec({
      responses: {
        "-m window 101 --space 2": "",
        "-m window 101 --display 1": "",
        "-m window 101 --move abs:100:50": "",
        "-m window 101 --resize abs:800:600": "",
      },
    });
    await createYabaiDriver(exec).moveWindow(101, {
      space: 2,
      display: 1,
      frame: { x: 100, y: 50, w: 800, h: 600 },
    });
    const joined = calls.map((c) => c.args.join(" "));
    assert.deepEqual(joined, [
      "-m window 101 --space 2",
      "-m window 101 --display 1",
      "-m window 101 --move abs:100:50",
      "-m window 101 --resize abs:800:600",
    ]);
  });

  test("rounds non-integer frame coordinates", async () => {
    const { exec, calls } = makeFakeExec({
      responses: {
        "-m window 1 --move abs:100:51": "",
        "-m window 1 --resize abs:801:600": "",
      },
    });
    await createYabaiDriver(exec).moveWindow(1, {
      frame: { x: 99.7, y: 50.5, w: 800.6, h: 600.1 },
    });
    const joined = calls.map((c) => c.args.join(" "));
    assert.deepEqual(joined, [
      "-m window 1 --move abs:100:51",
      "-m window 1 --resize abs:801:600",
    ]);
  });

  test("omits move/resize when frame partial lacks both sides", async () => {
    const { exec, calls } = makeFakeExec({
      responses: { "-m window 1 --space 3": "" },
    });
    await createYabaiDriver(exec).moveWindow(1, {
      space: 3,
      frame: { x: 10 }, // no y, no w, no h — must be skipped
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["-m", "window", "1", "--space", "3"]);
  });
});

// --------------------------- tile ----------------------------------------

describe("createYabaiDriver — tile", () => {
  test("maps 'full' to native stack layout", async () => {
    const { exec, calls } = makeFakeExec({
      responses: { "-m space --layout stack": "" },
    });
    await createYabaiDriver(exec).tile("full");
    assert.deepEqual(calls[0].args, ["-m", "space", "--layout", "stack"]);
  });

  test("maps 'vsplit' to native bsp layout", async () => {
    const { exec, calls } = makeFakeExec({
      responses: { "-m space --layout bsp": "" },
    });
    await createYabaiDriver(exec).tile("vsplit");
    assert.deepEqual(calls[0].args, ["-m", "space", "--layout", "bsp"]);
  });

  test("'grid-2x2' switches to bsp then resizes each window into its slot", async () => {
    const { exec, calls } = makeFakeExec({
      responses: {
        "-m space --layout bsp": "",
        "-m query --windows": WINDOWS_JSON,
        "-m query --spaces": SPACES_JSON,
        // grid-2x2 for 2 windows in a 1600x500 viewport → 2 TL/TR slots each 800x250
        "-m window 101 --move abs:0:0": "",
        "-m window 101 --resize abs:800:250": "",
        "-m window 102 --move abs:800:0": "",
        "-m window 102 --resize abs:800:250": "",
      },
    });
    await createYabaiDriver(exec).tile("grid-2x2");
    const joined = calls.map((c) => c.args.join(" "));
    assert.equal(joined[0], "-m space --layout bsp");
    assert.ok(joined.includes("-m window 101 --move abs:0:0"));
    assert.ok(joined.includes("-m window 102 --move abs:800:0"));
  });
});
