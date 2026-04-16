/**
 * Phase 9.5 — `captureCameraClip` unit tests.
 *
 * Uses injected clip bridge + injected extractor so neither AVFoundation
 * nor ffmpeg is touched. Covers: duration clamping, keyframe extraction
 * plumbing, mp4 cleanup when keepVideo=false, audit append, typed error
 * surfaces, and the bridge-arg contract.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  captureCameraClip,
  CAMERA_CLIP_DEFAULTS,
  type NativeCameraClipResult,
  type NativeClipBridge,
} from "../src/perception/camera-clip.js";
import { CameraCaptureError } from "../src/perception/camera-capture.js";
import type {
  KeyframeSet,
  KeyframeExtractOptions,
} from "../src/perception/keyframe-extractor.js";
import { AuditLog } from "../src/proactivity/audit.js";

function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function touch(path: string, body: string = "fake-mp4-bytes"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
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

function makeExtractor(
  frames: Array<{ path: string; ts_sec: number }>,
): (video: string, opts?: KeyframeExtractOptions) => Promise<KeyframeSet> {
  return async (video, opts) => {
    // Pretend-create the keyframe jpegs so tests that assert existence can.
    for (const f of frames) touch(f.path, "keyframe-bytes");
    return {
      video_path: video,
      duration_sec: opts?.durationSec ?? 10,
      frames: frames.map((f, i) => ({ index: i + 1, path: f.path, ts_sec: f.ts_sec })),
    };
  };
}

// ─── Happy path ───────────────────────────────────────────────────────

describe("captureCameraClip — happy path", () => {
  it("records, extracts N frames, and deletes the mp4 by default", async () => {
    await withTempDir("p95-clip-happy", async (dir) => {
      let seenArgs: {
        outPath: string;
        durationSec: number;
        device?: string;
      } | null = null;

      const bridge = makeBridge(async ({ outPath, durationSec, device }) => {
        seenArgs = { outPath, durationSec, device };
        touch(outPath, "mp4-bytes"); // write a "real" mp4 so unlink succeeds
        return {
          video_path: outPath,
          duration_sec: durationSec,
          width: 1280,
          height: 720,
          bytes: 4_500_000,
          device: device ?? "front",
          ts: 1712000000000,
        };
      });

      const framesDir = join(dir, "frames-out");
      const extractor = makeExtractor([
        { path: join(framesDir, "frame_001.jpg"), ts_sec: 1 },
        { path: join(framesDir, "frame_002.jpg"), ts_sec: 3 },
        { path: join(framesDir, "frame_003.jpg"), ts_sec: 5 },
        { path: join(framesDir, "frame_004.jpg"), ts_sec: 7 },
        { path: join(framesDir, "frame_005.jpg"), ts_sec: 9 },
      ]);

      const clip = await captureCameraClip({
        clipBridge: bridge,
        extractor: extractor as any,
        outputDir: dir,
      });

      assert.equal(seenArgs?.durationSec, 10);
      assert.equal(seenArgs?.device, "front");
      assert.equal(clip.duration_sec, 10);
      assert.equal(clip.width, 1280);
      assert.equal(clip.height, 720);
      assert.equal(clip.device, "front");
      assert.equal(clip.keyframes.length, 5);
      assert.equal(clip.video_path, null, "keepVideo=false must null video_path");
      // The mp4 path the bridge returned must no longer exist.
      assert.equal(existsSync(seenArgs!.outPath), false, "mp4 should be unlinked");
    });
  });

  it("keeps the mp4 when keepVideo=true", async () => {
    await withTempDir("p95-clip-keep", async (dir) => {
      let seenOut = "";
      const bridge = makeBridge(async ({ outPath, durationSec }) => {
        seenOut = outPath;
        touch(outPath);
        return {
          video_path: outPath,
          duration_sec: durationSec,
          width: 640,
          height: 480,
          bytes: 1024,
          device: "front",
          ts: Date.now(),
        };
      });
      const extractor = makeExtractor([
        { path: join(dir, "kf", "a.jpg"), ts_sec: 5 },
      ]);

      const clip = await captureCameraClip({
        keepVideo: true,
        keyframes: 1,
        clipBridge: bridge,
        extractor: extractor as any,
        outputDir: dir,
      });

      assert.equal(clip.video_path, seenOut);
      assert.ok(existsSync(seenOut), "mp4 must survive when keepVideo=true");
    });
  });

  it("forwards custom durationSec and keyframes to bridge + extractor", async () => {
    await withTempDir("p95-clip-cfg", async (dir) => {
      let sawDuration = 0;
      let sawExtractorCount = 0;
      const bridge = makeBridge(async ({ outPath, durationSec }) => {
        sawDuration = durationSec;
        touch(outPath);
        return {
          video_path: outPath,
          duration_sec: durationSec,
          width: 1,
          height: 1,
          bytes: 1,
          device: "continuity",
          ts: Date.now(),
        };
      });
      const extractor = (async (video: string, opts?: KeyframeExtractOptions) => {
        sawExtractorCount = opts?.count ?? -1;
        return {
          video_path: video,
          duration_sec: opts?.durationSec ?? 0,
          frames: [
            { index: 1, path: join(dir, "kf", "1.jpg"), ts_sec: 1 },
            { index: 2, path: join(dir, "kf", "2.jpg"), ts_sec: 2 },
            { index: 3, path: join(dir, "kf", "3.jpg"), ts_sec: 3 },
          ],
        };
      }) as any;

      const clip = await captureCameraClip({
        durationSec: 15,
        keyframes: 3,
        device: "continuity",
        clipBridge: bridge,
        extractor,
        outputDir: dir,
      });

      assert.equal(sawDuration, 15);
      assert.equal(sawExtractorCount, 3);
      assert.equal(clip.duration_sec, 15);
      assert.equal(clip.device, "continuity");
    });
  });

  it("appends an audit line with action=camera_clip", async () => {
    await withTempDir("p95-clip-audit", async (dir) => {
      const auditFile = join(dir, "audit.ndjson");
      const audit = new AuditLog(auditFile);

      const bridge = makeBridge(async ({ outPath, durationSec }) => {
        touch(outPath);
        return {
          video_path: outPath,
          duration_sec: durationSec,
          width: 100,
          height: 100,
          bytes: 2222,
          device: "front",
          ts: Date.now(),
        };
      });
      const extractor = makeExtractor([
        { path: join(dir, "kf", "1.jpg"), ts_sec: 5 },
      ]);

      await captureCameraClip({
        keyframes: 1,
        clipBridge: bridge,
        extractor: extractor as any,
        outputDir: dir,
        audit,
      });

      assert.ok(existsSync(auditFile));
      const content = readFileSync(auditFile, "utf-8").trim();
      const lines = content.split("\n").filter(Boolean);
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]!);
      assert.equal(record.action, "camera_clip");
      assert.match(record.detail, /duration=10\.0/);
      assert.match(record.detail, /keyframes=1/);
      assert.match(record.detail, /bytes=2222/);
    });
  });

  it("uses CAMERA_CLIP_DEFAULTS when opts are omitted", async () => {
    await withTempDir("p95-clip-def", async (dir) => {
      let sawDur = 0;
      let sawKf = -1;
      const bridge = makeBridge(async ({ outPath, durationSec }) => {
        sawDur = durationSec;
        touch(outPath);
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
      const extractor = (async (video: string, opts?: KeyframeExtractOptions) => {
        sawKf = opts?.count ?? -1;
        return {
          video_path: video,
          duration_sec: opts?.durationSec ?? 10,
          frames: Array.from({ length: sawKf }, (_, i) => ({
            index: i + 1,
            path: join(dir, "kf", `${i}.jpg`),
            ts_sec: i,
          })),
        };
      }) as any;

      await captureCameraClip({
        clipBridge: bridge,
        extractor,
        outputDir: dir,
      });

      assert.equal(sawDur, CAMERA_CLIP_DEFAULTS.durationSec);
      assert.equal(sawKf, CAMERA_CLIP_DEFAULTS.keyframes);
      assert.equal(CAMERA_CLIP_DEFAULTS.durationSec, 10);
      assert.equal(CAMERA_CLIP_DEFAULTS.keyframes, 5);
      assert.equal(CAMERA_CLIP_DEFAULTS.keepVideo, false);
    });
  });
});

// ─── Duration clamping ────────────────────────────────────────────────

describe("captureCameraClip — duration clamping", () => {
  it("rejects durations below 1s", async () => {
    await withTempDir("p95-clip-short", async (dir) => {
      const bridge = makeBridge(async () => {
        throw new Error("should not be called");
      });
      await assert.rejects(
        () =>
          captureCameraClip({
            durationSec: 0.5,
            clipBridge: bridge,
            outputDir: dir,
          }),
        (err) => {
          assert.ok(err instanceof CameraCaptureError);
          assert.match(err.message, /durationSec must be within/);
          return true;
        },
      );
    });
  });

  it("rejects durations above 60s", async () => {
    await withTempDir("p95-clip-long", async (dir) => {
      const bridge = makeBridge(async () => {
        throw new Error("should not be called");
      });
      await assert.rejects(
        () =>
          captureCameraClip({
            durationSec: 120,
            clipBridge: bridge,
            outputDir: dir,
          }),
        (err) => {
          assert.ok(err instanceof CameraCaptureError);
          return true;
        },
      );
    });
  });

  it("rejects non-finite durations", async () => {
    await withTempDir("p95-clip-nan", async (dir) => {
      await assert.rejects(
        () =>
          captureCameraClip({
            durationSec: Number.NaN,
            outputDir: dir,
            clipBridge: makeBridge(async () => {
              throw new Error("unused");
            }),
          }),
        (err) => err instanceof CameraCaptureError,
      );
    });
  });

  it("accepts boundary durations (1s and 60s)", async () => {
    await withTempDir("p95-clip-boundary", async (dir) => {
      const bridge = makeBridge(async ({ outPath, durationSec }) => {
        touch(outPath);
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
      const extractor = makeExtractor([
        { path: join(dir, "kf", "a.jpg"), ts_sec: 0 },
      ]);

      await captureCameraClip({
        durationSec: 1,
        keyframes: 1,
        clipBridge: bridge,
        extractor: extractor as any,
        outputDir: dir,
      });
      await captureCameraClip({
        durationSec: 60,
        keyframes: 1,
        clipBridge: bridge,
        extractor: extractor as any,
        outputDir: dir,
      });
    });
  });
});

// ─── Error paths ──────────────────────────────────────────────────────

describe("captureCameraClip — errors", () => {
  it("rethrows permission-denied unchanged", async () => {
    await withTempDir("p95-clip-perm", async (dir) => {
      const bridge = makeBridge(async () => {
        throw new CameraCaptureError(
          "permission-denied",
          "Camera permission denied.",
        );
      });
      await assert.rejects(
        () => captureCameraClip({ clipBridge: bridge, outputDir: dir }),
        (err) => {
          assert.ok(err instanceof CameraCaptureError);
          assert.equal(err.code, "permission-denied");
          return true;
        },
      );
    });
  });

  it("wraps unknown bridge errors into capture-failed", async () => {
    await withTempDir("p95-clip-unk", async (dir) => {
      const bridge = makeBridge(async () => {
        throw new Error("kernel panic");
      });
      await assert.rejects(
        () => captureCameraClip({ clipBridge: bridge, outputDir: dir }),
        (err) => {
          assert.ok(err instanceof CameraCaptureError);
          assert.equal(err.code, "capture-failed");
          return true;
        },
      );
    });
  });

  it("rejects invalid-output when bridge returns empty payload", async () => {
    await withTempDir("p95-clip-empty", async (dir) => {
      const bridge = makeBridge(async () => ({
        video_path: "",
        duration_sec: 0,
        width: 0,
        height: 0,
        bytes: 0,
        device: "",
        ts: 0,
      }));
      await assert.rejects(
        () => captureCameraClip({ clipBridge: bridge, outputDir: dir }),
        (err) => {
          assert.ok(err instanceof CameraCaptureError);
          assert.equal(err.code, "invalid-output");
          return true;
        },
      );
    });
  });

  it("cleans up the mp4 when extraction fails and keepVideo=false", async () => {
    await withTempDir("p95-clip-ext-fail", async (dir) => {
      let mp4Path = "";
      const bridge = makeBridge(async ({ outPath, durationSec }) => {
        mp4Path = outPath;
        touch(outPath);
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
      const extractor = (async () => {
        throw new Error("ffmpeg blew up");
      }) as any;

      await assert.rejects(
        () =>
          captureCameraClip({
            clipBridge: bridge,
            extractor,
            outputDir: dir,
          }),
      );
      assert.equal(
        existsSync(mp4Path),
        false,
        "mp4 should be unlinked on extraction failure",
      );
    });
  });
});
