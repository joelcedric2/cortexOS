/**
 * Phase 9.5 — short-clip camera capture.
 *
 * Upgrades {@link captureCameraFrame} from one still to an N-keyframe
 * perception of a 10-second window. The original one-shot API is still
 * exported for callers that need it; new default-mode consumers should
 * use {@link captureCameraClip} instead.
 *
 * Flow:
 *   1. Shell the Swift `camera-record` subcommand to write an MP4.
 *   2. Extract N keyframes via ffmpeg.
 *   3. If `keepVideo=false` (default), unlink the MP4 — we retain only
 *      the keyframes, per §8.5 storage budget.
 *   4. Append one audit line with action="camera_clip".
 *
 * Privacy:
 *   - The Swift helper bounds the recording to `durationSec` and tears
 *     down the session the instant the writer finishes.
 *   - This module never reads the MP4 for any purpose other than
 *     keyframe extraction; it is deleted by default.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuditLog } from "../proactivity/audit.js";
import { defaultBinaryPath } from "./native-bridge.js";
import {
  extractKeyframes,
  KEYFRAME_DEFAULTS,
  type Keyframe,
  type KeyframeExtractOptions,
} from "./keyframe-extractor.js";
import {
  CameraCaptureError,
  type CameraCaptureOptions,
  type CameraDevice,
} from "./camera-capture.js";

/** Raw JSON shape emitted by the Swift `camera-record` helper. */
export interface NativeCameraClipResult {
  video_path: string;
  duration_sec: number;
  width: number;
  height: number;
  bytes: number;
  device: string;
  ts: number;
}

export interface NativeClipBridge {
  cameraRecord(opts: {
    outPath: string;
    durationSec: number;
    device?: CameraDevice;
  }): Promise<NativeCameraClipResult>;
}

export interface CameraClipOptions extends CameraCaptureOptions {
  /** Clip duration in seconds. Clamped to [1, 60]. Default 10. */
  durationSec?: number;
  /** Number of keyframes to extract. Default 5. */
  keyframes?: number;
  /**
   * If true, keep the MP4 file after keyframes are extracted. Default
   * false — keyframes are all downstream consumers need.
   */
  keepVideo?: boolean;
  /** Injected clip bridge (tests). Production wires the real helper. */
  clipBridge?: NativeClipBridge;
  /**
   * Override the keyframe extractor. Defaults to {@link extractKeyframes}.
   * Tests use this to skip real ffmpeg calls.
   */
  extractor?: typeof extractKeyframes;
  /** Forwarded to {@link extractKeyframes} (ffmpeg path, exec seam, …). */
  keyframeOptions?: Omit<KeyframeExtractOptions, "count" | "outDir" | "durationSec">;
}

export interface CameraClip {
  id: string;
  ts: Date;
  /** Path to the MP4, or null when keepVideo=false (the default). */
  video_path: string | null;
  keyframes: Array<{ path: string; ts_sec: number }>;
  duration_sec: number;
  width: number;
  height: number;
  device: string;
}

export const CAMERA_CLIP_DEFAULTS = Object.freeze({
  durationSec: 10,
  keyframes: KEYFRAME_DEFAULTS.count,
  keepVideo: false,
  minDurationSec: 1,
  maxDurationSec: 60,
  timeoutMs: 60_000,
});

const DEFAULT_OUTPUT_DIR = join(homedir(), ".cortexos", "camera-clips");

/**
 * Capture a short clip, extract keyframes, and return both.
 *
 * Device / bridge / output-dir / audit plumbing mirrors
 * {@link captureCameraFrame} for consistency. Callers that want a single
 * still should use that function directly.
 */
export async function captureCameraClip(
  opts: CameraClipOptions = {},
): Promise<CameraClip> {
  const durationSec = clampDuration(
    opts.durationSec ?? CAMERA_CLIP_DEFAULTS.durationSec,
  );
  const keyframes = opts.keyframes ?? CAMERA_CLIP_DEFAULTS.keyframes;
  const keepVideo = opts.keepVideo ?? CAMERA_CLIP_DEFAULTS.keepVideo;
  const device: CameraDevice = opts.device ?? "front";
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;

  await mkdir(outputDir, { recursive: true });

  const id = randomUUID();
  const videoPath = join(outputDir, `${id}.mp4`);
  const framesDir = join(outputDir, `${id}-frames`);
  await mkdir(framesDir, { recursive: true });

  const bridge = opts.clipBridge ?? createDefaultClipBridge(opts);

  let raw: NativeCameraClipResult;
  try {
    raw = await bridge.cameraRecord({ outPath: videoPath, durationSec, device });
  } catch (err) {
    throw mapError(err);
  }

  if (!raw || typeof raw.video_path !== "string" || raw.video_path.length === 0) {
    throw new CameraCaptureError(
      "invalid-output",
      "camera-record helper returned an empty payload",
    );
  }

  const actualDuration = typeof raw.duration_sec === "number" && raw.duration_sec > 0
    ? raw.duration_sec
    : durationSec;

  const extractor = opts.extractor ?? extractKeyframes;
  const keyframeOpts = opts.keyframeOptions ?? {};
  let frames: Keyframe[];
  try {
    const result = await extractor(raw.video_path, {
      ...keyframeOpts,
      count: keyframes,
      outDir: framesDir,
      durationSec: actualDuration,
    });
    frames = result.frames;
  } catch (err) {
    // On extraction failure, best-effort cleanup of the MP4 so we don't
    // leave orphan video on disk. Swallow any unlink error.
    if (!keepVideo) {
      await unlink(raw.video_path).catch(() => undefined);
    }
    throw mapError(err);
  }

  if (!keepVideo) {
    await unlink(raw.video_path).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[camera-clip] could not unlink ${raw.video_path}: ${msg}`);
    });
  }

  const clip: CameraClip = {
    id,
    ts: new Date(typeof raw.ts === "number" ? raw.ts : Date.now()),
    video_path: keepVideo ? raw.video_path : null,
    keyframes: frames.map((f) => ({ path: f.path, ts_sec: f.ts_sec })),
    duration_sec: actualDuration,
    width: typeof raw.width === "number" ? raw.width : 0,
    height: typeof raw.height === "number" ? raw.height : 0,
    device: typeof raw.device === "string" && raw.device.length > 0
      ? raw.device
      : device,
  };

  if (opts.audit) {
    try {
      const bytes = typeof raw.bytes === "number" ? raw.bytes : 0;
      opts.audit.append({
        action: "camera_clip",
        detail:
          `device=${clip.device} duration=${actualDuration.toFixed(1)} ` +
          `keyframes=${frames.length} bytes=${bytes}`,
        ts: new Date(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[camera-clip] audit append failed: ${msg}`);
    }
  }

  return clip;
}

// ─── Internals ────────────────────────────────────────────────────────────

function clampDuration(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    throw new CameraCaptureError(
      "invalid-output",
      `durationSec must be finite (got ${seconds})`,
    );
  }
  if (
    seconds < CAMERA_CLIP_DEFAULTS.minDurationSec ||
    seconds > CAMERA_CLIP_DEFAULTS.maxDurationSec
  ) {
    throw new CameraCaptureError(
      "invalid-output",
      `durationSec must be within [${CAMERA_CLIP_DEFAULTS.minDurationSec}, ` +
        `${CAMERA_CLIP_DEFAULTS.maxDurationSec}] (got ${seconds})`,
    );
  }
  return seconds;
}

function createDefaultClipBridge(opts: CameraClipOptions): NativeClipBridge {
  const binary = opts.binaryPath ?? defaultBinaryPath();
  const timeoutMs = opts.timeoutMs ?? CAMERA_CLIP_DEFAULTS.timeoutMs;
  return {
    cameraRecord({ outPath, durationSec, device }) {
      return runCameraRecord(binary, outPath, durationSec, device, timeoutMs);
    },
  };
}

function runCameraRecord(
  binary: string,
  outPath: string,
  durationSec: number,
  device: CameraDevice | undefined,
  timeoutMs: number,
): Promise<NativeCameraClipResult> {
  const args = [
    "camera-record",
    "--out",
    outPath,
    "--duration",
    String(durationSec),
  ];
  if (device) args.push("--device", device);
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, encoding: "utf8" },
      (err, stdout, stderr) => {
        const stderrStr = (stderr ?? "").toString();
        if (err) {
          const errno = (err as NodeJS.ErrnoException).code;
          if (errno === "ENOENT") {
            reject(
              new CameraCaptureError(
                "bridge-unavailable",
                `cortexos-vision helper not available at ${binary}. ` +
                  "Run scripts/native/build-vision.sh.",
                err,
              ),
            );
            return;
          }
          if (stderrStr.includes("permission-denied")) {
            reject(
              new CameraCaptureError(
                "permission-denied",
                "Camera permission denied. Grant it in System Settings → Privacy & Security → Camera.",
                err,
              ),
            );
            return;
          }
          if (/no camera|session rejected|device|busy/i.test(stderrStr)) {
            reject(
              new CameraCaptureError(
                "device-unavailable",
                `camera unavailable: ${stderrStr.trim() || err.message}`,
                err,
              ),
            );
            return;
          }
          reject(
            new CameraCaptureError(
              "capture-failed",
              stderrStr.trim() || err.message,
              err,
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout ?? "") as NativeCameraClipResult;
          resolve(parsed);
        } catch (parseErr) {
          reject(
            new CameraCaptureError(
              "capture-failed",
              "camera-record helper returned invalid JSON",
              parseErr,
            ),
          );
        }
      },
    );
  });
}

function mapError(err: unknown): Error {
  if (err instanceof CameraCaptureError) return err;
  if (err instanceof Error) {
    return new CameraCaptureError("capture-failed", err.message, err);
  }
  return new CameraCaptureError("capture-failed", String(err), err);
}
