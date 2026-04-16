/**
 * Phase 8.5 tests — adaptive-rate + pHash dedup for `ScreenCapturer`.
 *
 * Every test drives a manual scheduler so we control wall-clock + tick
 * ordering. No real PNG is decoded: we inject a `PhashDecoder` stub that
 * returns the 64 bytes we want, deterministically.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPTURE_DEFAULTS,
  ScreenCapturer,
  type CaptureScheduler,
} from "../src/perception/screen-capture.js";
import type {
  NativeCaptureResult,
  NativeOcrResult,
  VisionBridge,
} from "../src/perception/native-bridge.js";
import type { PhashDecoder } from "../src/perception/phash.js";

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface ManualScheduler extends CaptureScheduler {
  started: boolean;
  intervalMs: number;
  tick(): Promise<void>;
  reset(): void;
}

function manualScheduler(): ManualScheduler {
  let cb: (() => Promise<void> | void) | null = null;
  const s: ManualScheduler = {
    started: false,
    intervalMs: 0,
    start(ms, t) {
      cb = t;
      s.started = true;
      s.intervalMs = ms;
    },
    stop() {
      cb = null;
      s.started = false;
    },
    async tick() {
      if (!cb || !s.started) return;
      await cb();
    },
    reset() {
      cb = null;
      s.started = false;
      s.intervalMs = 0;
    },
  };
  return s;
}

function fakeBridge(): VisionBridge & { writtenPngs: string[] } {
  const writtenPngs: string[] = [];
  return {
    writtenPngs,
    async isAvailable() { return true; },
    async capture(opts) {
      if (opts?.outPath) {
        await writeFile(opts.outPath, "PNG-STUB");
        writtenPngs.push(opts.outPath);
      }
      return {
        width: 1920,
        height: 1080,
        active_app: "Ghostty",
        active_bundle: "com.mitchellh.ghostty",
        window_title: "~/Documents/Github/cortexOS",
        png_path: opts?.outPath ?? "",
        ts: Date.now(),
      } satisfies NativeCaptureResult;
    },
    async ocr(): Promise<NativeOcrResult> {
      return { blocks: [], text: "", duration_ms: 0 };
    },
  };
}

/** Decoder driven by a script of 8×8 grayscale buffers; cycles at end. */
function scriptedDecoder(script: Uint8Array[]): PhashDecoder {
  let i = 0;
  return {
    async decodeGray8x8() {
      const buf = script[i % script.length]!;
      i += 1;
      return buf;
    },
  };
}

/** An 8×8 buffer whose pHash differs from `seed` by a large margin. */
function buf(seed: number): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = (i * 13 + seed * 37) % 256;
  return out;
}

function sameBuf(): Uint8Array {
  return new Uint8Array(64).fill(128);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("adaptive ScreenCapturer — dedup + fps ladder", () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "cortexos-adaptive-"));
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  test("dedup rate > 80 % scales the interval up (fps halves)", async () => {
    // 8 identical ticks. First is recorded as non-duplicate (no prior hash);
    // the next 7 all match → dedup rate 7/8 = 0.875 > 0.8 threshold.
    const script = Array(8).fill(0).map(() => sameBuf());
    let t = 1_000_000;
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      scheduler,
      phashDecoder: scriptedDecoder(script),
      startFps: 2,
      minFps: 0.25,
      maxFps: 4,
      now: () => t,
    });

    await cap.start();
    const fps0 = cap.getCurrentFps();
    const ms0 = scheduler.intervalMs;

    for (let i = 0; i < 8; i++) {
      await scheduler.tick();
      t += 100; // advance 100 ms per tick
    }

    assert.ok(
      cap.getCurrentFps() < fps0,
      `dedup-heavy window must lower fps (was ${fps0}, now ${cap.getCurrentFps()})`,
    );
    assert.ok(
      scheduler.intervalMs > ms0,
      `interval must grow when fps drops (was ${ms0}, now ${scheduler.intervalMs})`,
    );
  });

  test("dedup rate < 40 % scales the interval back up (fps doubles)", async () => {
    // All-unique frames → dedup rate 0 → speed up.
    const script = Array.from({ length: 8 }, (_, i) => buf(i + 1));
    let t = 2_000_000;
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      scheduler,
      phashDecoder: scriptedDecoder(script),
      startFps: 1,
      minFps: 0.25,
      maxFps: 4,
      now: () => t,
    });

    await cap.start();
    const fps0 = cap.getCurrentFps();

    for (let i = 0; i < 8; i++) {
      await scheduler.tick();
      t += 100;
    }

    assert.ok(
      cap.getCurrentFps() > fps0,
      `no-dedup window must raise fps (was ${fps0}, now ${cap.getCurrentFps()})`,
    );
  });

  test("respects minFps and maxFps bounds", async () => {
    // All-identical frames repeatedly → would halve fps forever if unbounded.
    const script = Array(64).fill(0).map(() => sameBuf());
    let t = 3_000_000;
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      scheduler,
      phashDecoder: scriptedDecoder(script),
      startFps: 2,
      minFps: 0.5,
      maxFps: 4,
      now: () => t,
    });

    await cap.start();
    for (let i = 0; i < 64; i++) {
      await scheduler.tick();
      t += 50;
    }
    assert.equal(cap.getCurrentFps(), 0.5, "fps must clamp at minFps");
    assert.ok(cap.getCurrentFps() >= 0.5);

    // Now flip to all-unique: should climb back but never exceed maxFps.
    const script2 = Array.from({ length: 64 }, (_, i) => buf(i + 100));
    let i2 = 0;
    const climbCap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      scheduler: manualScheduler(),
      phashDecoder: {
        async decodeGray8x8() {
          const b = script2[i2 % script2.length]!;
          i2 += 1;
          return b;
        },
      },
      startFps: 2,
      minFps: 0.5,
      maxFps: 4,
      now: () => t,
    });
    const sched2 = climbCap["scheduler"] as ManualScheduler;
    await climbCap.start();
    for (let i = 0; i < 64; i++) {
      await sched2.tick();
      t += 50;
    }
    assert.equal(climbCap.getCurrentFps(), 4, "fps must clamp at maxFps");
  });

  test("duplicate frames do not enter the ring buffer", async () => {
    const script = Array(4).fill(0).map(() => sameBuf());
    let t = 4_000_000;
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      scheduler,
      phashDecoder: scriptedDecoder(script),
      now: () => t,
    });

    await cap.start();
    for (let i = 0; i < 4; i++) {
      await scheduler.tick();
      t += 1000;
    }

    assert.equal(
      cap.getRecent().length,
      1,
      "only the unique first frame should survive dedup",
    );
  });

  test("captureNow returns {ok:false, reason:'duplicate'} for a repeat", async () => {
    const script = [buf(1), buf(1)]; // pHash-identical by construction
    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      phashDecoder: scriptedDecoder(script),
      scheduler: manualScheduler(),
    });
    const first = await cap.captureNow();
    const second = await cap.captureNow();

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, "duplicate");
  });

  test("fps stays put while window has too few samples", async () => {
    const script = Array(CAPTURE_DEFAULTS.DEDUP_WINDOW_MIN_SAMPLES - 1)
      .fill(0)
      .map(() => sameBuf());
    let t = 5_000_000;
    const scheduler = manualScheduler();
    const cap = new ScreenCapturer({
      storageDir,
      bridge: fakeBridge(),
      scheduler,
      phashDecoder: scriptedDecoder(script),
      startFps: 2,
      now: () => t,
    });

    await cap.start();
    const fps0 = cap.getCurrentFps();
    for (let i = 0; i < script.length; i++) {
      await scheduler.tick();
      t += 50;
    }
    assert.equal(
      cap.getCurrentFps(),
      fps0,
      "fewer than MIN_SAMPLES ticks must not adapt fps",
    );
  });
});
