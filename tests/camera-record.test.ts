/**
 * Phase 9.5 — camera-record bridge tests.
 *
 * Tests the bridge-level contract between the TS layer and the Swift
 * `camera-record` subcommand via the same injected-bridge pattern used
 * in camera-capture.test.ts. Covers: duration forwarding, permission-
 * denied surface, and device selection.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  captureCameraClip,
  CAMERA_CLIP_DEFAULTS,
  type NativeCameraClipResult,
  type NativeClipBridge,
} from "../src/perception/camera-clip.js";
import { CameraCaptureError } from "../src/perception/camera-capture.js";
import type { KeyframeExtractOptions, KeyframeSet } from "../src/perception/keyframe-extractor.js";

function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function makeBridge(
  impl: (opts: {
    outPath: string;
    durationSec: number;
    device?: "front" | "back" | "continuity";
  }) => Promise<NativeCameraClipResult>,
): NativeClipBridge {
  return { cameraRecord: impl };
}

function noopExtractor(
  _video: string,
  opts?: KeyframeExtractOptions,
): Promise<KeyframeSet> {
  return Promise.resolve({
    video_path: _video,
    duration_sec: opts?.durationSec ?? 10,
    frames: [{ index: 1, path: "/tmp/fake-frame.jpg", ts_sec: 5 }],
  });
}

// ─── Bridge invocation ────────────────────────────────────────────────

describe("camera-record bridge — invocation contract", () => {
  it("invokes camera-record with --duration 10 by default", async () => {
    await withTempDir("p95-rec-dur", async (dir) => {
      let seenDuration = -1;
      const bridge = makeBridge(async ({ outPath, durationSec }) => {
        seenDuration = durationSec;
        writeFileSync(outPath, "mp4");
        return {
          video_path: outPath,
          duration_sec: durationSec,
          width: 1280,
          height: 720,
          bytes: 5000,
          device: "front",
          ts: Date.now(),
        };
      });

      await captureCameraClip({
        clipBridge: bridge,
        extractor: noopExtractor as any,
        outputDir: dir,
      });

      assert.equal(seenDuration, CAMERA_CLIP_DEFAULTS.durationSec);
    });
  });

  it("forwards device=continuity to the bridge", async () => {
    await withTempDir("p95-rec-device", async (dir) => {
      let seenDevice: string | undefined;
      const bridge = makeBridge(async ({ outPath, durationSec, device }) => {
        seenDevice = device;
        writeFileSync(outPath, "mp4");
        return {
          video_path: outPath,
          duration_sec: durationSec,
          width: 1,
          height: 1,
          bytes: 1,
          device: device ?? "front",
          ts: Date.now(),
        };
      });

      await captureCameraClip({
        device: "continuity",
        clipBridge: bridge,
        extractor: noopExtractor as any,
        outputDir: dir,
      });

      assert.equal(seenDevice, "continuity");
    });
  });

  it("forwards custom duration (30s) to the bridge", async () => {
    await withTempDir("p95-rec-custom-dur", async (dir) => {
      let seenDuration = -1;
      const bridge = makeBridge(async ({ outPath, durationSec }) => {
        seenDuration = durationSec;
        writeFileSync(outPath, "mp4");
        return {
          video_path: outPath,
          duration_sec: durationSec,
          width: 1,
          height: 1,
          bytes: 1,
          device: "front",
          ts: Date.now(),
        };
      });

      await captureCameraClip({
        durationSec: 30,
        clipBridge: bridge,
        extractor: noopExtractor as any,
        outputDir: dir,
      });

      assert.equal(seenDuration, 30);
    });
  });
});

// ─── Permission-denied path ───────────────────────────────────────────

describe("camera-record bridge — permission-denied", () => {
  it("surfaces permission-denied from the bridge as CameraCaptureError", async () => {
    await withTempDir("p95-rec-perm", async (dir) => {
      const bridge = makeBridge(async () => {
        throw new CameraCaptureError(
          "permission-denied",
          "Camera permission denied.",
        );
      });

      await assert.rejects(
        () =>
          captureCameraClip({
            clipBridge: bridge,
            extractor: noopExtractor as any,
            outputDir: dir,
          }),
        (err) => {
          assert.ok(err instanceof CameraCaptureError);
          assert.equal(err.code, "permission-denied");
          return true;
        },
      );
    });
  });

  it("surfaces device-unavailable from the bridge", async () => {
    await withTempDir("p95-rec-busy", async (dir) => {
      const bridge = makeBridge(async () => {
        throw new CameraCaptureError(
          "device-unavailable",
          "camera busy",
        );
      });

      await assert.rejects(
        () =>
          captureCameraClip({
            clipBridge: bridge,
            extractor: noopExtractor as any,
            outputDir: dir,
          }),
        (err) => {
          assert.ok(err instanceof CameraCaptureError);
          assert.equal(err.code, "device-unavailable");
          return true;
        },
      );
    });
  });
});
