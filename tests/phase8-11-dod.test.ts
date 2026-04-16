/**
 * Phase 8 + Phase 11 — DoD smoke test.
 *
 * Integrator-level proof that the four coder branches compose into one
 * working system. Does NOT re-test each unit; covers only the happy
 * path + the privacy-critical branch (private-app zero-capture).
 *
 * Phase 8 DoD (VISION.md §4 Phase 8):
 *   - mock bridge → nchindaSee() returns a VisionBrief
 *   - ScreenCapturer with fake scheduler
 *     * private-app bundle active → zero captures
 *     * normal-app bundle active   → capture fires, ring-buffer holds 1
 *       frame, OCR text feeds the brief
 *
 * Phase 11 DoD (VISION.md §4 Phase 11):
 *   - computeLayout("grid-2x2", viewport, 4) → 4 quadrants summing to
 *     viewport area
 *   - selectDriver() prefers yabai when both probes succeed
 *   - PaneOrnamentManager.syncWithAgents applies the correct role →
 *     color mapping (researcher=cyan, coder=blue, tester=yellow)
 */
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// ─── Phase 8 under test ──────────────────────────────────────────────────────
import { ScreenCapturer, type ScreenFrame } from "../src/perception/screen-capture.js";
import type {
  VisionBridge,
  NativeCaptureResult,
  NativeOcrResult,
} from "../src/perception/native-bridge.js";
import { buildBrief } from "../src/perception/vision-brief.js";
import { nchindaSee } from "../src/mcp/nchinda-see.js";

// ─── Phase 11 under test ─────────────────────────────────────────────────────
import { computeLayout } from "../src/window-manager/layouts.js";
import { selectDriver, resetDriverCache } from "../src/window-manager/driver-factory.js";
import type { WMDriver } from "../src/window-manager/driver-factory.js";
import { PaneOrnamentManager } from "../src/window-manager/pane-ornaments.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Shared test fixtures
// ═══════════════════════════════════════════════════════════════════════════

/** Manual scheduler — tests drive `tick()` explicitly (fake clock). */
function makeManualScheduler() {
  let tick: (() => Promise<void> | void) | null = null;
  return {
    scheduler: {
      start(_intervalMs: number, cb: () => Promise<void> | void) {
        tick = cb;
      },
      stop() {
        tick = null;
      },
    },
    async fire() {
      if (!tick) throw new Error("scheduler not started");
      await tick();
    },
    hasTick() {
      return tick !== null;
    },
  };
}

/** Build a fake VisionBridge whose capture() returns a scripted bundle id. */
function makeBridge(opts: { bundle: string; app: string; title?: string }) {
  let captureCount = 0;
  const storageDir = mkdtempSync(join(tmpdir(), "phase8-dod-"));
  const bridge: VisionBridge = {
    async isAvailable() {
      return true;
    },
    async capture(options): Promise<NativeCaptureResult> {
      captureCount++;
      const pngPath =
        options?.outPath ?? join(storageDir, `capture-${captureCount}.png`);
      return {
        width: 1920,
        height: 1080,
        active_app: opts.app,
        active_bundle: opts.bundle,
        window_title: opts.title ?? `${opts.app} — main`,
        png_path: pngPath,
        ts: Date.now(),
      };
    },
    async ocr(_path): Promise<NativeOcrResult> {
      return {
        text: "Example OCR: lorem ipsum dolor",
        blocks: [
          {
            text: "Example OCR: lorem ipsum dolor",
            bbox: { x: 0, y: 0, w: 200, h: 40 },
            confidence: 0.99,
          },
        ],
        duration_ms: 3,
      };
    },
  };
  return {
    bridge,
    get captureCount() {
      return captureCount;
    },
    storageDir,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 8
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 8 DoD — screen perception", () => {
  test("private-app active → scheduler tick fires zero captures", async () => {
    const { scheduler, fire } = makeManualScheduler();
    const bridge = makeBridge({
      bundle: "com.agilebits.onepassword7", // on the default allowlist
      app: "1Password",
    });

    const capturer = new ScreenCapturer({
      bridge: bridge.bridge,
      scheduler,
      intervalSec: 1,
      ringBufferSize: 5,
      storageDir: bridge.storageDir,
    });

    await capturer.start();
    // One scheduled tick should attempt a capture but the private-app guard
    // drops it with zero frames retained.
    await fire();
    await fire();

    assert.equal(
      capturer.getRecent().length,
      0,
      "private-app frames must not land in the ring buffer",
    );
    await capturer.stop();
  });

  test("normal app → capture fires, ring-buffer holds 1 frame, brief composed from OCR", async () => {
    const { scheduler, fire } = makeManualScheduler();
    const bridge = makeBridge({
      bundle: "com.apple.Safari",
      app: "Safari",
      title: "Claude — claude.ai",
    });

    const capturer = new ScreenCapturer({
      bridge: bridge.bridge,
      scheduler,
      intervalSec: 1,
      ringBufferSize: 5,
      storageDir: bridge.storageDir,
    });

    await capturer.start();
    await fire();

    const frames = capturer.getRecent();
    assert.equal(frames.length, 1, "one tick should yield one frame");
    assert.equal(frames[0].active_app, "Safari");
    assert.equal(frames[0].window_title, "Claude — claude.ai");

    // Brief pipeline composes from the captured frame + injected OCR.
    const brief = await buildBrief(frames[0], {
      ocr: async () => ({
        text: "Example OCR: lorem ipsum dolor",
        blocks: [],
        duration_ms: 1,
      }),
    });
    assert.equal(brief.active_app, "Safari");
    assert.equal(brief.window_title, "Claude — claude.ai");
    assert.ok(brief.summary.length > 0, "brief must have a non-empty summary");
    assert.ok(
      brief.visible_text.includes("lorem ipsum"),
      `OCR text must reach the brief (got: ${brief.visible_text.slice(0, 80)})`,
    );
    assert.equal(brief.source_frame_id, frames[0].id);

    await capturer.stop();
  });

  test("nchindaSee() with mocked bridge → VisionBrief in local-only mode", async () => {
    const { scheduler } = makeManualScheduler();
    const bridge = makeBridge({
      bundle: "com.microsoft.VSCode",
      app: "Visual Studio Code",
      title: "vision-brief.ts — cortexOS",
    });

    const capturer = new ScreenCapturer({
      bridge: bridge.bridge,
      scheduler,
      intervalSec: 60,
      storageDir: bridge.storageDir,
    });

    // nchindaSee captures synchronously via captureNow(); no scheduler tick needed.
    const brief = await nchindaSee(
      {},
      {
        capturer,
        brief: (frame, _deps, opts) =>
          buildBrief(
            frame,
            {
              ocr: async () => ({
                text: "function makeBridge",
                blocks: [],
                duration_ms: 1,
              }),
            },
            opts,
          ),
      },
    );

    assert.equal(brief.active_app, "Visual Studio Code");
    assert.equal(brief.window_title, "vision-brief.ts — cortexOS");
    assert.ok(brief.visible_text.includes("function makeBridge"));
    assert.equal(bridge.captureCount, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 11
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 11 DoD — window management", () => {
  beforeEach(() => {
    // Driver selection is cached; clear between tests so our factory overrides
    // win.
    resetDriverCache();
  });

  test("computeLayout(grid-2x2, viewport, 4) yields 4 quadrants summing to viewport area", () => {
    const viewport = { x: 0, y: 0, w: 1600, h: 1000 };
    const slots = computeLayout("grid-2x2", viewport, 4);
    assert.equal(slots.length, 4);
    const total = slots.reduce((acc, s) => acc + s.w * s.h, 0);
    assert.equal(total, viewport.w * viewport.h, "slot areas must tile the viewport exactly");
    // Basic shape checks: 4 equal quadrants.
    for (const s of slots) {
      assert.equal(s.w, 800);
      assert.equal(s.h, 500);
    }
  });

  test("selectDriver() prefers yabai when both probes succeed", async () => {
    let yabaiProbed = false;
    let appleScriptProbed = false;
    const yabaiFake: WMDriver = {
      async isAvailable() {
        yabaiProbed = true;
        return true;
      },
      async listWindows() {
        return [];
      },
      async listSpaces() {
        return [];
      },
      async focusWindow() {},
      async moveWindow() {},
      async tile() {},
      async spaceSwitch() {},
    };
    const appleScriptFake: WMDriver = {
      async isAvailable() {
        appleScriptProbed = true;
        return true;
      },
      async listWindows() {
        return [];
      },
      async listSpaces() {
        return [];
      },
      async focusWindow() {},
      async moveWindow() {},
      async tile() {},
      async spaceSwitch() {},
    };

    const selected = await selectDriver({
      yabaiFactory: () => yabaiFake,
      appleScriptFactory: () => appleScriptFake,
    });

    assert.equal(yabaiProbed, true, "yabai should be probed first");
    assert.equal(
      appleScriptProbed,
      false,
      "AppleScript must not be probed when yabai wins",
    );
    assert.strictEqual(selected, yabaiFake);
  });

  test("PaneOrnamentManager.syncWithAgents paints role→color correctly", async () => {
    const execCalls: Array<{ file: string; args: readonly string[] }> = [];
    const driver: WMDriver = {
      async isAvailable() {
        return true;
      },
      async listWindows() {
        return [
          {
            id: 10,
            app: "Terminal",
            title: "bash — sess-researcher — 120x40",
            space: 1,
            display: 1,
            frame: { x: 0, y: 0, w: 800, h: 500 },
            focused: false,
          },
          {
            id: 20,
            app: "iTerm2",
            title: "sess-coder",
            space: 1,
            display: 1,
            frame: { x: 800, y: 0, w: 800, h: 500 },
            focused: false,
          },
          {
            id: 30,
            app: "Terminal",
            title: "bash — sess-tester",
            space: 1,
            display: 1,
            frame: { x: 0, y: 500, w: 800, h: 500 },
            focused: false,
          },
        ];
      },
      async listSpaces() {
        return [];
      },
      async focusWindow() {},
      async moveWindow() {},
      async tile() {},
      async spaceSwitch() {},
    };

    const mgr = new PaneOrnamentManager({
      driver,
      bordersAvailable: true, // shortcut the `which borders` probe
      execFileImpl: async (file, args) => {
        execCalls.push({ file, args });
        return { stdout: "", stderr: "" };
      },
    });

    await mgr.syncWithAgents([
      { id: "r-1", role: "researcher", tmux_session: "sess-researcher" },
      { id: "c-1", role: "coder", tmux_session: "sess-coder" },
      { id: "t-1", role: "tester", tmux_session: "sess-tester" },
    ]);

    const ornaments = mgr.list();
    const byId = new Map(ornaments.map((o) => [o.windowId, o.color]));
    assert.equal(byId.get(10), "cyan", "researcher → cyan on window 10");
    assert.equal(byId.get(20), "blue", "coder → blue on window 20");
    assert.equal(byId.get(30), "yellow", "tester → yellow on window 30");

    // Spot-check: the borders CLI was invoked with the expected hex for cyan.
    const cyanCall = execCalls.find((c) =>
      c.args.some((a) => a === "active_color=0xff00d9ff"),
    );
    assert.ok(cyanCall, "borders should be called with cyan hex for researcher");
  });
});
