/**
 * Tests for Phase 8 ScreenCapturer.
 *
 * Every test injects a fake VisionBridge + a manual CaptureScheduler; we
 * never shell out to the real Swift helper because CI lacks Screen Recording
 * permission and the binary may not be built.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PRIVATE_APPS,
  PrivateAppSkippedError,
  ScreenCapturer,
  type CaptureScheduler,
} from "../src/perception/screen-capture.js";
import type {
  NativeCaptureResult,
  NativeOcrResult,
  VisionBridge,
} from "../src/perception/native-bridge.js";

/** A driver-style scheduler the test owns — tick() fires whenever we call it. */
function manualScheduler(): CaptureScheduler & {
  tick(): Promise<void>;
  started: boolean;
  intervalMs: number;
} {
  let cb: (() => Promise<void> | void) | null = null;
  let started = false;
  let intervalMs = 0;
  const s: CaptureScheduler & {
    tick(): Promise<void>;
    started: boolean;
    intervalMs: number;
  } = {
    started: false,
    intervalMs: 0,
    start(ms, t) {
      cb = t;
      started = true;
      intervalMs = ms;
      s.started = true;
      s.intervalMs = ms;
    },
    stop() {
      cb = null;
      started = false;
      s.started = false;
    },
    async tick() {
      if (!cb || !started) return;
      await cb();
    },
  };
  return s;
}

interface BridgePlan {
  captures: NativeCaptureResult[];
  cursor: number;
}

function fakeBridge(plan: BridgePlan): VisionBridge & { writtenPngs: string[] } {
  const writtenPngs: string[] = [];
  const b: VisionBridge & { writtenPngs: string[] } = {
    writtenPngs,
    async isAvailable() {
      return true;
    },
    async capture(opts) {
      const next = plan.captures[plan.cursor % plan.captures.length];
      plan.cursor += 1;
      if (opts?.outPath) {
        await writeFile(opts.outPath, "PNG-STUB", "utf8");
        writtenPngs.push(opts.outPath);
      }
      return { ...next, ts: next.ts || Date.now() };
    },
    async ocr(): Promise<NativeOcrResult> {
      return { blocks: [], text: "", duration_ms: 0 };
    },
  };
  return b;
}

function frame(opts: Partial<NativeCaptureResult> = {}): NativeCaptureResult {
  return {
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    active_app: opts.active_app ?? "Ghostty",
    active_bundle: opts.active_bundle ?? "com.mitchellh.ghostty",
    window_title: opts.window_title ?? "~/Documents/Github/cortexOS",
    png_path: opts.png_path ?? "",
    ts: opts.ts ?? Date.now(),
  };
}

describe("ScreenCapturer", () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "cortexos-capture-test-"));
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  test("starts disabled; captureNow works without start()", async () => {
    const bridge = fakeBridge({ captures: [frame()], cursor: 0 });
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({ storageDir, bridge, scheduler });

    assert.equal(cap.isRunning(), false);
    const f = await cap.captureNow();
    assert.equal(cap.isRunning(), false, "captureNow must not start the loop");
    assert.equal(typeof f.id, "string");
    assert.equal(f.width, 1920);
    assert.equal(f.active_app, "Ghostty");
    assert.ok(f.png_path.startsWith(storageDir));
    const s = await stat(f.png_path);
    assert.ok(s.isFile());
  });

  test("start / stop are idempotent", async () => {
    const bridge = fakeBridge({ captures: [frame()], cursor: 0 });
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({
      storageDir,
      bridge,
      scheduler,
      intervalSec: 5,
    });

    await cap.start();
    await cap.start();
    assert.equal(cap.isRunning(), true);
    assert.equal(scheduler.intervalMs, 5_000);

    await cap.stop();
    await cap.stop();
    assert.equal(cap.isRunning(), false);
  });

  test("ring buffer evicts oldest frames and unlinks their PNGs", async () => {
    const bridge = fakeBridge({
      captures: [
        frame({ active_app: "A" }),
        frame({ active_app: "B" }),
        frame({ active_app: "C" }),
        frame({ active_app: "D" }),
      ],
      cursor: 0,
    });
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({
      storageDir,
      bridge,
      scheduler,
      ringBufferSize: 2,
    });

    await cap.start();
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    const recent = cap.getRecent();
    assert.equal(recent.length, 2);
    assert.deepEqual(
      recent.map((f) => f.active_app),
      ["D", "C"],
    );

    const files = await readdir(storageDir);
    assert.equal(files.length, 2, "only 2 PNGs should remain after eviction");

    await cap.stop();
  });

  test("private-app allowlist skips capture — no frame stored, no PNG left", async () => {
    const bridge = fakeBridge({
      captures: [
        frame({ active_app: "1Password", active_bundle: DEFAULT_PRIVATE_APPS[2] }),
      ],
      cursor: 0,
    });
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({ storageDir, bridge, scheduler });

    await assert.rejects(
      () => cap.captureNow(),
      (err: unknown) => err instanceof PrivateAppSkippedError,
    );
    assert.equal(cap.getRecent().length, 0);
    const files = await readdir(storageDir);
    assert.equal(files.length, 0, "no PNG should remain after skip");
  });

  test("private-app skip during tick is swallowed — loop keeps running", async () => {
    const bridge = fakeBridge({
      captures: [
        frame({ active_app: "Safari-bank", active_bundle: "com.apple.Safari.bank" }),
        frame({ active_app: "Ghostty" }),
      ],
      cursor: 0,
    });
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({ storageDir, bridge, scheduler });

    await cap.start();
    await scheduler.tick();
    await scheduler.tick();

    const recent = cap.getRecent();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].active_app, "Ghostty");

    await cap.stop();
  });

  test("custom privateAppAllowlist overrides the default", async () => {
    const bridge = fakeBridge({
      captures: [frame({ active_bundle: "com.my.sensitive.app" })],
      cursor: 0,
    });
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({
      storageDir,
      bridge,
      scheduler,
      privateAppAllowlist: ["com.my.sensitive.app"],
    });

    await assert.rejects(() => cap.captureNow(), PrivateAppSkippedError);
  });

  test("purge(olderThanSec) removes stale frames and reclaims disk", async () => {
    const now = Date.now();
    const bridge = fakeBridge({
      captures: [
        frame({ active_app: "old", ts: now - 120_000 }),
        frame({ active_app: "fresh", ts: now }),
      ],
      cursor: 0,
    });
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({ storageDir, bridge, scheduler });

    await cap.captureNow();
    await cap.captureNow();

    const filesBefore = await readdir(storageDir);
    assert.equal(filesBefore.length, 2);

    const removed = await cap.purge(60);
    assert.equal(removed, 1);
    assert.equal(cap.getRecent().length, 1);
    assert.equal(cap.getRecent()[0].active_app, "fresh");

    const filesAfter = await readdir(storageDir);
    assert.equal(filesAfter.length, 1);
  });

  test("purge() with no arg drops everything", async () => {
    const bridge = fakeBridge({
      captures: [frame(), frame(), frame()],
      cursor: 0,
    });
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({ storageDir, bridge, scheduler });

    await cap.captureNow();
    await cap.captureNow();
    await cap.captureNow();

    const removed = await cap.purge();
    assert.equal(removed, 3);
    assert.equal(cap.getRecent().length, 0);
    assert.equal((await readdir(storageDir)).length, 0);
  });

  test("forceOff is the kill switch — latches instance + wipes disk", async () => {
    const bridge = fakeBridge({
      captures: [frame(), frame()],
      cursor: 0,
    });
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({ storageDir, bridge, scheduler });

    await cap.start();
    await scheduler.tick();
    assert.equal(cap.getRecent().length, 1);

    await cap.forceOff();

    assert.equal(cap.isRunning(), false);
    assert.equal(cap.getRecent().length, 0);
    assert.equal((await readdir(storageDir)).length, 0);

    await assert.rejects(() => cap.captureNow(), /kill-switch/);
    await assert.rejects(() => cap.start(), /kill-switch/);
  });

  test("getRecent(n) returns most-recent-first, capped at n", async () => {
    const bridge = fakeBridge({
      captures: [
        frame({ active_app: "A" }),
        frame({ active_app: "B" }),
        frame({ active_app: "C" }),
      ],
      cursor: 0,
    });
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({ storageDir, bridge, scheduler });

    await cap.captureNow();
    await cap.captureNow();
    await cap.captureNow();

    const two = cap.getRecent(2);
    assert.deepEqual(
      two.map((f) => f.active_app),
      ["C", "B"],
    );

    const all = cap.getRecent();
    assert.equal(all.length, 3);
  });

  test("invalid constructor options throw", () => {
    assert.throws(() => new ScreenCapturer({ intervalSec: 0 }), /intervalSec/);
    assert.throws(
      () => new ScreenCapturer({ ringBufferSize: 0 }),
      /ringBufferSize/,
    );
  });

  test("bridge failures during tick are swallowed and logged", async (t) => {
    let calls = 0;
    const bridge: VisionBridge = {
      async isAvailable() {
        return true;
      },
      async capture() {
        calls += 1;
        throw new Error("simulated capture failure");
      },
      async ocr(): Promise<NativeOcrResult> {
        return { blocks: [], text: "", duration_ms: 0 };
      },
    };
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({ storageDir, bridge, scheduler });

    t.mock.method(console, "warn", () => {});

    await cap.start();
    await scheduler.tick();
    await scheduler.tick();
    await cap.stop();

    assert.equal(calls, 2);
    assert.equal(cap.getRecent().length, 0);
  });
});
