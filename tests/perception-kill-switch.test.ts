import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PerceptionKillSwitch,
  type KillSwitchSource,
} from "../src/perception/kill-switch.js";
import { GlobalHotkey } from "../src/voice/hotkey.js";
import { AuditLog } from "../src/proactivity/audit.js";
import { createEventBus, type AgentEvent } from "../src/ipc/event-bus.js";
import {
  ScreenCapturer,
  type CaptureScheduler,
  ephemeralStorageDir,
} from "../src/perception/screen-capture.js";
import type { VisionBridge } from "../src/perception/native-bridge.js";

// ─── Test doubles ───────────────────────────────────────────────────────────

function manualScheduler(): CaptureScheduler & { tick: () => Promise<void> } {
  let cb: (() => Promise<void> | void) | null = null;
  return {
    start(_intervalMs, tick) {
      cb = tick;
    },
    stop() {
      cb = null;
    },
    async tick() {
      if (cb) await cb();
    },
  };
}

/** Fake VisionBridge that never touches disk. */
function fakeBridge(): VisionBridge {
  return {
    async capture({ outPath }) {
      return {
        out_path: outPath,
        ts: Date.now(),
        active_app: "TestApp",
        active_bundle: "com.example.test",
        window_title: "t",
        width: 1,
        height: 1,
      };
    },
    async ocr() {
      return { text: "", blocks: [], duration_ms: 0 };
    },
    async probe() {
      return { ok: true };
    },
  };
}

interface FakePaneOrnamentManager {
  clearAllCalls: number;
  throwOnClearAll: boolean;
  clearAll(): Promise<void>;
}

function fakePaneOrnaments(): FakePaneOrnamentManager {
  const fake: FakePaneOrnamentManager = {
    clearAllCalls: 0,
    throwOnClearAll: false,
    async clearAll() {
      fake.clearAllCalls++;
      if (fake.throwOnClearAll) throw new Error("pane boom");
    },
  };
  return fake;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PerceptionKillSwitch", () => {
  let tmpDir: string;
  let auditPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cortex-ks-"));
    auditPath = join(tmpDir, "audit.ndjson");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hotkey press fires capturer.forceOff + clears ornaments + emits bus + audits", async () => {
    const scheduler = manualScheduler();
    const capturer = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler,
      storageDir: ephemeralStorageDir(),
    });
    await capturer.start();
    assert.equal(capturer.isRunning(), true);

    const panes = fakePaneOrnaments();
    const bus = createEventBus();
    const audit = new AuditLog(auditPath);

    const received: AgentEvent[] = [];
    bus.subscribe({ kind: "error" }, (e) => received.push(e));

    const ks = new PerceptionKillSwitch({
      capturer,
      // deliberately cast — test uses a structural fake
      paneOrnaments: panes as unknown as import("../src/window-manager/pane-ornaments.js").PaneOrnamentManager,
      bus,
      audit,
    });
    ks.arm();
    assert.equal(ks.getHotkey().isRegistered(), true);
    assert.equal(ks.getHotkey().getCombo(), "cmd+shift+escape");

    // Pressing the hotkey fires trigger("hotkey").
    ks.getHotkey().simulatePress();

    // Effects are async inside trigger — wait a microtask.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(ks.hasFired(), true);
    assert.equal(capturer.isRunning(), false);
    assert.equal(panes.clearAllCalls, 1);

    assert.equal(received.length, 1);
    assert.equal(received[0]?.kind, "error");
    assert.deepEqual(received[0]?.payload, {
      where: "perception.kill",
      source: "hotkey",
    });

    assert.ok(existsSync(auditPath), "audit file should exist after trigger");
    const lines = readFileSync(auditPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]) as {
      action: string;
      detail: string;
    };
    assert.equal(rec.action, "perception_killed");
    assert.equal(rec.detail, "source=hotkey");
  });

  it("is idempotent — firing twice does not double-emit or double-audit", async () => {
    const scheduler = manualScheduler();
    const capturer = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler,
      storageDir: ephemeralStorageDir(),
    });
    await capturer.start();

    const panes = fakePaneOrnaments();
    const bus = createEventBus();
    const audit = new AuditLog(auditPath);

    const received: AgentEvent[] = [];
    bus.subscribe({ kind: "error" }, (e) => received.push(e));

    const ks = new PerceptionKillSwitch({
      capturer,
      paneOrnaments: panes as unknown as import("../src/window-manager/pane-ornaments.js").PaneOrnamentManager,
      bus,
      audit,
    });

    await ks.trigger("programmatic");
    await ks.trigger("programmatic");
    await ks.trigger("voice"); // second source also ignored

    assert.equal(received.length, 1, "only one bus event");
    assert.equal(panes.clearAllCalls, 1, "ornaments cleared exactly once");

    const lines = readFileSync(auditPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 1, "exactly one audit line");
    const rec = JSON.parse(lines[0]) as { detail: string };
    assert.equal(rec.detail, "source=programmatic");
  });

  it("voice source is distinguishable from hotkey source in audit", async () => {
    const scheduler = manualScheduler();
    const capturer = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler,
      storageDir: ephemeralStorageDir(),
    });
    const audit = new AuditLog(auditPath);

    const ks = new PerceptionKillSwitch({ capturer, audit });
    await ks.trigger("voice");

    const line = readFileSync(auditPath, "utf-8").trim();
    const rec = JSON.parse(line) as { action: string; detail: string };
    assert.equal(rec.action, "perception_killed");
    assert.equal(rec.detail, "source=voice");
  });

  it("wires cmd+shift+escape by default", () => {
    const scheduler = manualScheduler();
    const capturer = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler,
      storageDir: ephemeralStorageDir(),
    });
    const ks = new PerceptionKillSwitch({ capturer });
    assert.equal(ks.getHotkey().getCombo(), "cmd+shift+escape");
  });

  it("accepts a caller-supplied hotkey without rewriting its callback", async () => {
    const scheduler = manualScheduler();
    const capturer = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler,
      storageDir: ephemeralStorageDir(),
    });
    let myPressFired = false;
    const externalHotkey = new GlobalHotkey({
      combo: "cmd+shift+escape",
      onPress: () => {
        myPressFired = true;
      },
    });
    const ks = new PerceptionKillSwitch({ capturer, hotkey: externalHotkey });
    ks.arm();
    assert.equal(ks.ownsHotkey(), false);
    externalHotkey.simulatePress();
    assert.equal(myPressFired, true);
    // The caller is responsible for wiring trigger(); we did not, so the
    // kill-switch must NOT have fired.
    assert.equal(ks.hasFired(), false);
  });

  it("arm/disarm are idempotent", () => {
    const scheduler = manualScheduler();
    const capturer = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler,
      storageDir: ephemeralStorageDir(),
    });
    const ks = new PerceptionKillSwitch({ capturer });

    ks.arm();
    ks.arm();
    assert.equal(ks.getHotkey().isRegistered(), true);

    ks.disarm();
    ks.disarm();
    assert.equal(ks.getHotkey().isRegistered(), false);
  });

  it("tolerates collaborator failures — still fires audit + bus", async () => {
    const scheduler = manualScheduler();
    const capturer = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler,
      storageDir: ephemeralStorageDir(),
    });

    const panes = fakePaneOrnaments();
    panes.throwOnClearAll = true;

    const bus = createEventBus();
    const audit = new AuditLog(auditPath);
    const received: AgentEvent[] = [];
    bus.subscribe({ kind: "error" }, (e) => received.push(e));

    const ks = new PerceptionKillSwitch({
      capturer,
      paneOrnaments: panes as unknown as import("../src/window-manager/pane-ornaments.js").PaneOrnamentManager,
      bus,
      audit,
    });

    // Should NOT throw even though paneOrnaments throws.
    await ks.trigger("programmatic");

    assert.equal(received.length, 1);
    const lines = readFileSync(auditPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 1);
  });

  it("throws if capturer is missing in options", () => {
    assert.throws(
      // @ts-expect-error intentional bad input
      () => new PerceptionKillSwitch({}),
      /capturer is required/,
    );
  });

  it("uses injected clock for deterministic timestamps", async () => {
    const scheduler = manualScheduler();
    const capturer = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler,
      storageDir: ephemeralStorageDir(),
    });
    const fixed = new Date("2026-04-15T12:00:00Z");
    const audit = new AuditLog(auditPath);
    const ks = new PerceptionKillSwitch({
      capturer,
      audit,
      clock: () => fixed,
    });

    const source: KillSwitchSource = "programmatic";
    await ks.trigger(source);
    const rec = JSON.parse(readFileSync(auditPath, "utf-8").trim()) as {
      ts: string;
    };
    assert.equal(rec.ts, fixed.toISOString());
  });
});
