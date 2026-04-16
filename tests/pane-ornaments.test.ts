/**
 * PaneOrnamentManager — JankyBorders-style accent borders per agent.
 *
 * Asserts:
 *   • `apply` issues the correct `borders` CLI args when available.
 *   • Fallback to AppleScript overlay when `borders` is missing.
 *   • Graceful no-op + warn-once when neither backend is installed.
 *   • `syncWithAgents` matches windows by tmux session name substring.
 *   • `clearAll` removes every tracked ornament on shutdown.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  PaneOrnamentManager,
  colorForRole,
  windowTitleMatchesSession,
  type ExecFileImpl,
} from "../src/window-manager/pane-ornaments.js";
import type {
  WMDriver,
  WMWindow,
  WMSpace,
  WMTileLayout,
} from "../src/window-manager/_c3-stub.js";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface ExecCall {
  file: string;
  args: string[];
}

class FakeExec {
  public calls: ExecCall[] = [];
  public bordersOnPath = true;
  public osascriptFails = false;
  public bordersFails = false;

  readonly impl: ExecFileImpl = async (file, args) => {
    this.calls.push({ file, args: [...args] });
    if (file === "/usr/bin/which") {
      if (this.bordersOnPath) return { stdout: "/opt/homebrew/bin/borders\n", stderr: "" };
      throw new Error("borders: not found");
    }
    if (file === "/usr/bin/osascript") {
      if (this.osascriptFails) throw new Error("osascript failed");
      return { stdout: "", stderr: "" };
    }
    // Treat anything else as the borders binary invocation
    if (this.bordersFails) throw new Error("borders failed");
    return { stdout: "", stderr: "" };
  };

  callsFor(file: string): ExecCall[] {
    return this.calls.filter((c) => c.file === file);
  }
}

class FakeDriver implements WMDriver {
  public windows: WMWindow[] = [];
  async isAvailable(): Promise<boolean> { return true; }
  async listWindows(): Promise<WMWindow[]> { return this.windows; }
  async listSpaces(): Promise<WMSpace[]> { return []; }
  async focusWindow(): Promise<void> {}
  async moveWindow(): Promise<void> {}
  async tile(_layout: WMTileLayout): Promise<void> {}
  async spaceSwitch(): Promise<void> {}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("colorForRole", () => {
  test("maps canonical roles to their accents", () => {
    assert.equal(colorForRole("researcher"), "cyan");
    assert.equal(colorForRole("coder"), "blue");
    assert.equal(colorForRole("tester"), "yellow");
    assert.equal(colorForRole("pentester"), "red");
    assert.equal(colorForRole("operator"), "magenta");
    assert.equal(colorForRole("reviewer"), "green");
    assert.equal(colorForRole("planner"), "copper");
  });

  test("defaults unknown roles to copper", () => {
    assert.equal(colorForRole("wizard"), "copper");
    assert.equal(colorForRole(""), "copper");
  });
});

describe("windowTitleMatchesSession", () => {
  test("matches substring inside full Terminal.app-style titles", () => {
    assert.ok(windowTitleMatchesSession("bash — agent-coder-1 — 120x40", "agent-coder-1"));
  });
  test("matches exact iTerm2 titles", () => {
    assert.ok(windowTitleMatchesSession("agent-researcher-2", "agent-researcher-2"));
  });
  test("rejects empty session names", () => {
    assert.equal(windowTitleMatchesSession("any title", ""), false);
  });
  test("rejects disjoint titles", () => {
    assert.equal(
      windowTitleMatchesSession("agent-coder-1", "agent-researcher-2"),
      false,
    );
  });
});

describe("PaneOrnamentManager.apply — borders backend", () => {
  let exec: FakeExec;
  let mgr: PaneOrnamentManager;

  beforeEach(() => {
    exec = new FakeExec();
    mgr = new PaneOrnamentManager({
      execFileImpl: exec.impl,
      bordersAvailable: true,
    });
  });

  test("calls borders with active_color=0xff<hex>, width, whitelist", async () => {
    await mgr.apply(4242, "blue");
    const borderCalls = exec.callsFor("borders");
    assert.equal(borderCalls.length, 1);
    const args = borderCalls[0].args;
    assert.ok(args.some((a) => a === "active_color=0xff3b82f6"), `args: ${args.join(" ")}`);
    assert.ok(args.some((a) => a === "width=3.0"));
    assert.ok(args.some((a) => a === "whitelist=4242"));
  });

  test("adds style=glow when opts.glow=true", async () => {
    await mgr.apply(99, "red", { glow: true });
    const args = exec.callsFor("borders")[0].args;
    assert.ok(args.includes("style=glow"));
  });

  test("list() tracks applied ornaments", async () => {
    await mgr.apply(1, "cyan");
    await mgr.apply(2, "green");
    const ornaments = mgr.list();
    assert.equal(ornaments.length, 2);
    assert.deepEqual(
      ornaments.map((o) => o.windowId).sort((a, b) => a - b),
      [1, 2],
    );
  });

  test("rejects non-positive windowIds", async () => {
    await assert.rejects(() => mgr.apply(0, "blue"));
    await assert.rejects(() => mgr.apply(-5, "blue"));
    await assert.rejects(() => mgr.apply(1.5, "blue"));
  });
});

describe("PaneOrnamentManager.apply — fallback when borders missing", () => {
  test("uses osascript when borders is not on PATH", async () => {
    const exec = new FakeExec();
    exec.bordersOnPath = false;
    const mgr = new PaneOrnamentManager({ execFileImpl: exec.impl });

    await mgr.apply(111, "yellow");
    const osaCalls = exec.callsFor("/usr/bin/osascript");
    assert.equal(osaCalls.length, 1);
    assert.ok(osaCalls[0].args[1].includes("ornament 111"));
    assert.ok(osaCalls[0].args[1].includes("facc15"));
  });

  test("logs once and no-ops when both backends fail", async () => {
    const exec = new FakeExec();
    exec.bordersOnPath = false;
    exec.osascriptFails = true;
    const warnings: string[] = [];

    const mgr = new PaneOrnamentManager({
      execFileImpl: exec.impl,
      logger: (m) => warnings.push(m),
    });
    await mgr.apply(1, "blue");
    await mgr.apply(2, "red");

    assert.equal(warnings.length, 1, "should warn exactly once");
    assert.match(warnings[0], /no backend available/);
    assert.equal(mgr.list().length, 0, "no ornaments tracked when both fail");
  });
});

describe("PaneOrnamentManager.clear / clearAll", () => {
  test("clear(windowId) drops the ornament and calls borders blacklist", async () => {
    const exec = new FakeExec();
    const mgr = new PaneOrnamentManager({
      execFileImpl: exec.impl,
      bordersAvailable: true,
    });
    await mgr.apply(7, "green");
    assert.equal(mgr.list().length, 1);

    await mgr.clear(7);
    assert.equal(mgr.list().length, 0);
    const blacklistCall = exec
      .callsFor("borders")
      .find((c) => c.args.some((a) => a === "blacklist=7"));
    assert.ok(blacklistCall, "borders blacklist=7 should be issued");
  });

  test("clear is idempotent for untracked windows", async () => {
    const exec = new FakeExec();
    const mgr = new PaneOrnamentManager({
      execFileImpl: exec.impl,
      bordersAvailable: true,
    });
    await mgr.clear(999); // never applied — should not throw
  });

  test("clearAll clears every tracked ornament", async () => {
    const exec = new FakeExec();
    const mgr = new PaneOrnamentManager({
      execFileImpl: exec.impl,
      bordersAvailable: true,
    });
    await mgr.apply(1, "cyan");
    await mgr.apply(2, "yellow");
    await mgr.apply(3, "red");

    await mgr.clearAll();
    assert.equal(mgr.list().length, 0);
    const blacklists = exec
      .callsFor("borders")
      .filter((c) => c.args.some((a) => /^blacklist=/.test(a)));
    assert.equal(blacklists.length, 3);
  });
});

describe("PaneOrnamentManager.syncWithAgents", () => {
  test("matches windows by tmux session substring and paints the right colour", async () => {
    const exec = new FakeExec();
    const driver = new FakeDriver();
    driver.windows = [
      { id: 100, app: "Terminal", title: "bash — cortex-coder-1 — 120x40", space: 1 },
      { id: 200, app: "iTerm2", title: "cortex-researcher-1", space: 1 },
      { id: 300, app: "Finder", title: "Downloads", space: 1 },
    ];
    const mgr = new PaneOrnamentManager({
      driver,
      execFileImpl: exec.impl,
      bordersAvailable: true,
    });

    await mgr.syncWithAgents([
      { id: "coder-1", role: "coder", tmux_session: "cortex-coder-1" },
      { id: "researcher-1", role: "researcher", tmux_session: "cortex-researcher-1" },
      { id: "orphan-1", role: "tester", tmux_session: "cortex-tester-7" },
      { id: "no-session", role: "coder", tmux_session: null },
    ]);

    const ornaments = mgr.list();
    assert.equal(ornaments.length, 2, "only 2 of 4 agents should match a window");

    const byId = new Map(ornaments.map((o) => [o.windowId, o.color]));
    assert.equal(byId.get(100), "blue", "coder → blue on window 100");
    assert.equal(byId.get(200), "cyan", "researcher → cyan on window 200");
  });

  test("no-ops + warns once when driver is missing", async () => {
    const warnings: string[] = [];
    const exec = new FakeExec();
    const mgr = new PaneOrnamentManager({
      execFileImpl: exec.impl,
      logger: (m) => warnings.push(m),
      bordersAvailable: true,
    });
    await mgr.syncWithAgents([
      { id: "coder-1", role: "coder", tmux_session: "s1" },
    ]);
    await mgr.syncWithAgents([
      { id: "coder-2", role: "coder", tmux_session: "s2" },
    ]);
    assert.equal(mgr.list().length, 0);
    assert.equal(warnings.length, 1, "warn once, not per-call");
  });

  test("survives driver.listWindows failures without throwing", async () => {
    const driver = new FakeDriver();
    driver.listWindows = async () => {
      throw new Error("yabai: not running");
    };
    const errs: string[] = [];
    const mgr = new PaneOrnamentManager({
      driver,
      execFileImpl: new FakeExec().impl,
      bordersAvailable: true,
      logger: (m) => errs.push(m),
    });
    await mgr.syncWithAgents([
      { id: "coder-1", role: "coder", tmux_session: "s1" },
    ]);
    assert.equal(mgr.list().length, 0);
    assert.ok(errs.some((e) => /listWindows failed/.test(e)));
  });

  test("clears ornaments for agents whose status is not running/spawning", async () => {
    const exec = new FakeExec();
    const driver = new FakeDriver();
    driver.windows = [
      { id: 100, app: "Terminal", title: "agent-coder-1", space: 1 },
      { id: 200, app: "Terminal", title: "agent-tester-1", space: 1 },
    ];
    const mgr = new PaneOrnamentManager({
      driver,
      execFileImpl: exec.impl,
      bordersAvailable: true,
    });

    // First pass: both running → both get painted.
    await mgr.syncWithAgents([
      { id: "coder-1", role: "coder", tmux_session: "agent-coder-1", status: "running" },
      { id: "tester-1", role: "tester", tmux_session: "agent-tester-1", status: "running" },
    ]);
    assert.equal(mgr.list().length, 2);

    // Second pass: coder finishes → ornament 100 is cleared, 200 survives.
    await mgr.syncWithAgents([
      { id: "coder-1", role: "coder", tmux_session: "agent-coder-1", status: "done" },
      { id: "tester-1", role: "tester", tmux_session: "agent-tester-1", status: "running" },
    ]);
    const remaining = mgr.list();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].windowId, 200);
  });
});
