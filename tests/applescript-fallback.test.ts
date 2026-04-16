import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildFocusScript,
  buildMoveScript,
  createAppleScriptDriver,
  LIST_WINDOWS_SCRIPT,
  parseWindowList,
  quoteAS,
  type OsascriptExec,
} from "../src/window-manager/applescript-fallback.js";
import { WMUnavailableError } from "../src/window-manager/yabai-bridge.js";

// --------------------------- fake osascript exec -------------------------

function makeFakeExec(responses: { match: (args: readonly string[]) => boolean; reply: string }[]) {
  const calls: string[][] = [];
  const exec: OsascriptExec = async (args) => {
    calls.push([...args]);
    for (const r of responses) {
      if (r.match(args)) return r.reply;
    }
    throw new Error(`no fake reply for osascript ${args.join(" ")}`);
  };
  return { exec, calls };
}

// --------------------------- quoteAS -------------------------------------

describe("quoteAS", () => {
  test("wraps a plain string in double quotes", () => {
    assert.equal(quoteAS("iTerm2"), '"iTerm2"');
  });

  test("escapes embedded quotes", () => {
    assert.equal(quoteAS('a "b" c'), '"a \\"b\\" c"');
  });

  test("escapes backslashes before quotes", () => {
    assert.equal(quoteAS("a\\b"), '"a\\\\b"');
  });
});

// --------------------------- parseWindowList -----------------------------

describe("parseWindowList", () => {
  test("parses a well-formed TSV listing", () => {
    const raw =
      "1\tiTerm2\tcoder-1\t0\t0\t800\t500\n" + "2\tChrome\tGitHub\t800\t0\t800\t500";
    const rows = parseWindowList(raw);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].app, "iTerm2");
    assert.equal(rows[0].title, "coder-1");
    assert.equal(rows[1].x, 800);
    assert.equal(rows[1].w, 800);
  });

  test("skips rows with the wrong column count", () => {
    const raw = "1\tiTerm2\tonly-3-cols\n2\tChrome\tok\t10\t20\t30\t40";
    const rows = parseWindowList(raw);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].app, "Chrome");
  });

  test("skips rows with non-numeric coordinates", () => {
    const raw = "1\tiTerm2\ttitle\tNaN\t0\t800\t500";
    assert.equal(parseWindowList(raw).length, 0);
  });

  test("handles empty input gracefully", () => {
    assert.deepEqual(parseWindowList(""), []);
    assert.deepEqual(parseWindowList("\n\n"), []);
  });
});

// --------------------------- buildMoveScript / buildFocusScript ----------

describe("buildMoveScript / buildFocusScript", () => {
  test("buildMoveScript includes position + size + quoted app/title", () => {
    const script = buildMoveScript("iTerm2", "coder-1", 10, 20, 800, 500);
    assert.match(script, /tell application "System Events"/);
    assert.match(script, /tell process "iTerm2"/);
    assert.match(script, /first window whose name is "coder-1"/);
    assert.match(script, /set position of w to {10, 20}/);
    assert.match(script, /set size of w to {800, 500}/);
  });

  test("buildMoveScript rounds non-integer coords", () => {
    const script = buildMoveScript("App", "T", 10.7, 20.4, 800.9, 500.1);
    assert.match(script, /set position of w to {11, 20}/);
    assert.match(script, /set size of w to {801, 500}/);
  });

  test("buildMoveScript escapes double-quotes in window title", () => {
    const script = buildMoveScript("App", 'Weird "Title"', 0, 0, 100, 100);
    assert.match(script, /first window whose name is "Weird \\"Title\\""/);
  });

  test("buildFocusScript issues AXRaise against the right window", () => {
    const script = buildFocusScript("Chrome", "Tab Title");
    assert.match(script, /set frontmost to true/);
    assert.match(script, /perform action "AXRaise" of \(first window whose name is "Tab Title"\)/);
  });
});

// --------------------------- isAvailable ---------------------------------

describe("createAppleScriptDriver — isAvailable", () => {
  test("returns true when osascript responds", async () => {
    const { exec } = makeFakeExec([{ match: () => true, reply: "2" }]);
    assert.equal(await createAppleScriptDriver(exec).isAvailable(), true);
  });

  test("returns false when osascript throws", async () => {
    const exec: OsascriptExec = async () => {
      throw new Error("osascript: command not found");
    };
    assert.equal(await createAppleScriptDriver(exec).isAvailable(), false);
  });
});

// --------------------------- listWindows ---------------------------------

describe("createAppleScriptDriver — listWindows", () => {
  test("parses osascript output into Window[]", async () => {
    const raw = "1\tiTerm2\tcoder-1\t0\t0\t800\t500\n" + "2\tChrome\tGitHub\t800\t0\t800\t500";
    const { exec, calls } = makeFakeExec([
      { match: (args) => args[0] === "-e", reply: raw },
    ]);
    const windows = await createAppleScriptDriver(exec).listWindows();
    assert.equal(windows.length, 2);
    assert.equal(windows[0].app, "iTerm2");
    assert.equal(windows[0].frame.w, 800);
    // Must issue the canonical LIST_WINDOWS_SCRIPT.
    assert.equal(calls[0][0], "-e");
    assert.equal(calls[0][1], LIST_WINDOWS_SCRIPT);
    // Space/display fallback values.
    assert.equal(windows[0].space, 1);
    assert.equal(windows[0].display, 1);
  });
});

// --------------------------- listSpaces ----------------------------------

describe("createAppleScriptDriver — listSpaces", () => {
  test("returns a single synthetic space (AppleScript cannot enumerate)", async () => {
    const exec: OsascriptExec = async () => "";
    const spaces = await createAppleScriptDriver(exec).listSpaces();
    assert.deepEqual(spaces, [{ index: 1, display: 1, type: "float" }]);
  });
});

// --------------------------- focusWindow ---------------------------------

describe("createAppleScriptDriver — focusWindow", () => {
  test("issues AXRaise for the previously-listed window", async () => {
    const listing = "1\tiTerm2\tcoder-1\t0\t0\t800\t500";
    const listingScript = LIST_WINDOWS_SCRIPT;
    const { exec, calls } = makeFakeExec([
      { match: (args) => args[1] === listingScript, reply: listing },
      { match: () => true, reply: "" },
    ]);
    const driver = createAppleScriptDriver(exec);
    await driver.listWindows();
    await driver.focusWindow(1);
    // calls[1] is the focus script — must target iTerm2 + coder-1.
    assert.match(calls[1][1], /tell process "iTerm2"/);
    assert.match(calls[1][1], /first window whose name is "coder-1"/);
  });

  test("throws when id is unknown", async () => {
    const exec: OsascriptExec = async () => "";
    const driver = createAppleScriptDriver(exec);
    await assert.rejects(() => driver.focusWindow(999), /window id 999 unknown/);
  });
});

// --------------------------- moveWindow ----------------------------------

describe("createAppleScriptDriver — moveWindow", () => {
  test("moves a previously-listed window into the target frame", async () => {
    const listing = "1\tiTerm2\tcoder-1\t0\t0\t800\t500";
    const { exec, calls } = makeFakeExec([
      { match: (args) => args[1] === LIST_WINDOWS_SCRIPT, reply: listing },
      { match: () => true, reply: "" },
    ]);
    const driver = createAppleScriptDriver(exec);
    await driver.listWindows();
    await driver.moveWindow(1, { frame: { x: 100, y: 50, w: 400, h: 300 } });
    assert.match(calls[1][1], /set position of w to {100, 50}/);
    assert.match(calls[1][1], /set size of w to {400, 300}/);
  });

  test("refuses to move across spaces (WMUnavailableError)", async () => {
    const exec: OsascriptExec = async () => "";
    const driver = createAppleScriptDriver(exec);
    await assert.rejects(
      () => driver.moveWindow(1, { space: 2 }),
      (err: unknown) => err instanceof WMUnavailableError,
    );
  });

  test("throws when the frame lacks any of x/y/w/h", async () => {
    const listing = "1\tiTerm2\tcoder-1\t0\t0\t800\t500";
    const { exec } = makeFakeExec([
      { match: (args) => args[1] === LIST_WINDOWS_SCRIPT, reply: listing },
    ]);
    const driver = createAppleScriptDriver(exec);
    await driver.listWindows();
    await assert.rejects(
      () => driver.moveWindow(1, { frame: { x: 10, y: 20 } }),
      /must include x, y, w, h/,
    );
  });
});

// --------------------------- tile ----------------------------------------

describe("createAppleScriptDriver — tile", () => {
  test("grid-2x2 issues 4 move scripts into the 4 quadrants of the viewport union", async () => {
    // 4 windows spanning a 1600x1000 viewport (each at a corner).
    const listing = [
      "1\tA\tw1\t0\t0\t800\t500",
      "2\tB\tw2\t800\t0\t800\t500",
      "3\tC\tw3\t0\t500\t800\t500",
      "4\tD\tw4\t800\t500\t800\t500",
    ].join("\n");
    const { exec, calls } = makeFakeExec([
      { match: (args) => args[1] === LIST_WINDOWS_SCRIPT, reply: listing },
      { match: () => true, reply: "" },
    ]);
    await createAppleScriptDriver(exec).tile("grid-2x2");
    // One listing call + 4 move scripts.
    assert.equal(calls.length, 5);
    // Each subsequent call is a move with a quadrant-sized size.
    for (let i = 1; i <= 4; i++) {
      assert.match(calls[i][1], /set size of w to {800, 500}/);
    }
  });

  test("empty window list is a no-op", async () => {
    const { exec, calls } = makeFakeExec([
      { match: (args) => args[1] === LIST_WINDOWS_SCRIPT, reply: "" },
    ]);
    await createAppleScriptDriver(exec).tile("full");
    assert.equal(calls.length, 1);
  });
});

// --------------------------- spaceSwitch ---------------------------------

describe("createAppleScriptDriver — spaceSwitch", () => {
  test("always throws WMUnavailableError (documented limitation)", async () => {
    const exec: OsascriptExec = async () => "";
    const driver = createAppleScriptDriver(exec);
    await assert.rejects(
      () => driver.spaceSwitch(2),
      (err: unknown) => err instanceof WMUnavailableError,
    );
  });
});
