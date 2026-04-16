/**
 * Phase 9 — one-shot camera capture.
 *
 * Thin TS wrapper around `cortexos-vision camera-capture`. Unlike the
 * screen-capture loop, there is NO periodic sampler, NO ring buffer, and
 * NO adaptive cadence. The camera opens exactly once per call, writes a
 * JPEG to disk, then closes. This is a privacy invariant — the binary,
 * the bridge, and this module cooperate to ensure the sensor is never
 * left running in the background.
 *
 * Privacy & failure modes:
 *   - Camera permission denied → {@link CameraCaptureError} with
 *     code="permission-denied". Never silently swallowed.
 *   - Helper binary missing → code="bridge-unavailable".
 *   - Device busy / no matching device → code="device-unavailable".
 *   - Unknown failure → code="capture-failed" (stderr preserved).
 *
 * Audit: when an AuditLog is injected, every successful capture appends
 * one line with action="camera_capture". Failures do NOT log — the
 * typed error already carries that information and the voice / MCP
 * callers log at their boundary.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuditLog } from "../proactivity/audit.js";
import { defaultBinaryPath } from "./native-bridge.js";

/** Devices this wrapper can request. `continuity` maps to iPhone-as-webcam. */
export type CameraDevice = "front" | "back" | "continuity";

/** Raw JSON shape emitted by the Swift helper on success. */
export interface NativeCameraResult {
  width: number;
  height: number;
  device: string;
  jpeg_path: string;
  bytes: number;
  ts: number;
}

/**
 * Injection seam for tests — matches the `cameraCapture` method we'd add
 * to the full {@link import("./native-bridge.js").VisionBridge} if
 * Phase 9 were allowed to touch that file. Keeping it local means
 * production code paths through this module without requiring a
 * system-wide bridge rev.
 */
export interface NativeBridge {
  cameraCapture(opts: {
    outPath: string;
    device?: CameraDevice;
  }): Promise<NativeCameraResult>;
}

export interface CameraFrame {
  id: string;
  ts: Date;
  jpeg_path: string;
  width: number;
  height: number;
  device: string;
}

export interface CameraCaptureOptions {
  /** Physical camera to use. Defaults to `front`. */
  device?: CameraDevice;
  /** Injected bridge (for tests). Production calls build the real one. */
  bridge?: NativeBridge;
  /** Directory to write JPEGs into. Defaults to `~/.cortexos/camera/`. */
  outputDir?: string;
  /** Optional audit log. See module docs for the semantics. */
  audit?: AuditLog;
  /** Override the Swift helper binary path. Testing hook. */
  binaryPath?: string;
  /** Max time in ms before the child is killed. Default 15_000. */
  timeoutMs?: number;
}

/**
 * Stable code union — callers can `switch` on this instead of string
 * matching on the `message`. Mirrors the `ScreenPermissionDeniedError`
 * pattern but keeps a single error class so switch-on-code is ergonomic.
 */
export type CameraCaptureErrorCode =
  | "permission-denied"
  | "bridge-unavailable"
  | "device-unavailable"
  | "capture-failed"
  | "invalid-output";

export class CameraCaptureError extends Error {
  constructor(
    public readonly code: CameraCaptureErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CameraCaptureError";
  }
}

const DEFAULT_OUTPUT_DIR = join(homedir(), ".cortexos", "camera");
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Capture a single frame from the selected camera.
 *
 * Flow:
 *   1. Ensure `outputDir` exists.
 *   2. Generate a random UUID for the file name.
 *   3. Invoke the native bridge (default: real helper; tests inject).
 *   4. Normalise the response into a {@link CameraFrame}.
 *   5. Append one audit line when wired.
 *
 * The caller owns the JPEG on disk — this module never reads or deletes
 * the file after writing. That way, downstream consumers (nchinda_look
 * for example) can OCR / vision-classify the frame without racing the
 * writer.
 */
export async function captureCameraFrame(
  opts: CameraCaptureOptions = {},
): Promise<CameraFrame> {
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const device = opts.device ?? "front";

  await mkdir(outputDir, { recursive: true });

  const id = randomUUID();
  const jpegPath = join(outputDir, `${id}.jpg`);
  const bridge = opts.bridge ?? createDefaultBridge(opts);

  let raw: NativeCameraResult;
  try {
    raw = await bridge.cameraCapture({ outPath: jpegPath, device });
  } catch (err) {
    throw mapError(err);
  }

  if (!raw || typeof raw.jpeg_path !== "string" || raw.jpeg_path.length === 0) {
    throw new CameraCaptureError(
      "invalid-output",
      "camera helper returned an empty payload",
    );
  }

  const frame: CameraFrame = {
    id,
    ts: new Date(typeof raw.ts === "number" ? raw.ts : Date.now()),
    jpeg_path: raw.jpeg_path,
    width: typeof raw.width === "number" ? raw.width : 0,
    height: typeof raw.height === "number" ? raw.height : 0,
    device: typeof raw.device === "string" && raw.device.length > 0
      ? raw.device
      : device,
  };

  // Best-effort audit. Never throws: a broken sink must not break capture.
  if (opts.audit) {
    try {
      opts.audit.append({
        action: "camera_capture",
        detail: `device=${frame.device} bytes=${typeof raw.bytes === "number" ? raw.bytes : 0}`,
        ts: new Date(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[camera-capture] audit append failed: ${msg}`);
    }
  }

  return frame;
}

// ─── Internals ────────────────────────────────────────────────────────────

function createDefaultBridge(opts: CameraCaptureOptions): NativeBridge {
  const binary = opts.binaryPath ?? defaultBinaryPath();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    cameraCapture({ outPath, device }) {
      return runCameraCapture(binary, outPath, device, timeoutMs);
    },
  };
}

function runCameraCapture(
  binary: string,
  outPath: string,
  device: CameraDevice | undefined,
  timeoutMs: number,
): Promise<NativeCameraResult> {
  const args = ["camera-capture", "--out", outPath];
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
          const parsed = JSON.parse(stdout ?? "") as NativeCameraResult;
          resolve(parsed);
        } catch (parseErr) {
          reject(
            new CameraCaptureError(
              "capture-failed",
              "camera helper returned invalid JSON",
              parseErr,
            ),
          );
        }
      },
    );
  });
}

/** Passthrough for typed errors; wrap unknowns into `capture-failed`. */
function mapError(err: unknown): CameraCaptureError {
  if (err instanceof CameraCaptureError) return err;
  if (err instanceof Error) {
    return new CameraCaptureError("capture-failed", err.message, err);
  }
  return new CameraCaptureError("capture-failed", String(err), err);
}
