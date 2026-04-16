/**
 * TypeScript bridge to the Swift `cortexos-vision` helper (Phase 8).
 *
 * The helper lives at `~/.cortexos/bin/cortexos-vision` by default and is
 * produced by `scripts/native/build-vision.sh`. All calls go through
 * `execFile` with argument arrays — never a shell string — so there is no
 * path-traversal or injection risk when relaying user-supplied paths.
 *
 * Privacy: this module NEVER opens a network socket. Every operation reads
 * from the user's machine and writes to the user's machine.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";

/** Raw capture metadata emitted by `cortexos-vision capture`. */
export interface NativeCaptureResult {
  width: number;
  height: number;
  active_app: string;
  active_bundle: string;
  window_title: string;
  png_path: string;
  /** Unix milliseconds when the shot was taken. */
  ts: number;
}

/** A single OCR box emitted by `cortexos-vision ocr`. */
export interface NativeOcrBlock {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
}

/** Raw OCR payload emitted by `cortexos-vision ocr`. */
export interface NativeOcrResult {
  blocks: NativeOcrBlock[];
  text: string;
  duration_ms: number;
}

/** Thrown when the Swift binary is missing or non-executable. */
export class NativeBridgeUnavailableError extends Error {
  constructor(public readonly binaryPath: string) {
    super(
      `cortexos-vision helper not available at ${binaryPath}. Run scripts/native/build-vision.sh.`,
    );
    this.name = "NativeBridgeUnavailableError";
  }
}

/** Thrown when the user has not granted Screen Recording permission. */
export class ScreenPermissionDeniedError extends Error {
  constructor() {
    super(
      "Screen Recording permission denied. Grant it in System Settings → Privacy & Security → Screen Recording.",
    );
    this.name = "ScreenPermissionDeniedError";
  }
}

/** Generic failure from the Swift helper — stderr is preserved for debugging. */
export class NativeBridgeError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = "NativeBridgeError";
  }
}

/** Injection surface for tests — same shape the real bridge exposes. */
export interface VisionBridge {
  capture(opts?: { bundleId?: string; outPath?: string }): Promise<NativeCaptureResult>;
  ocr(imagePath: string): Promise<NativeOcrResult>;
  isAvailable(): Promise<boolean>;
}

export interface BridgeOptions {
  /** Override the binary path (default: ~/.cortexos/bin/cortexos-vision). */
  binaryPath?: string;
  /** Max time in ms before the child is killed. Default 15000. */
  timeoutMs?: number;
}

/** Default helper binary path per the Phase 8 spec. */
export function defaultBinaryPath(): string {
  return join(homedir(), ".cortexos", "bin", "cortexos-vision");
}

/**
 * Production bridge — spawns the Swift helper via execFile.
 *
 * Tests should inject a fake bridge into `ScreenCapturer` / `ocrImage` instead
 * of relying on this; CI lacks Screen Recording permission.
 */
export function createNativeBridge(opts: BridgeOptions = {}): VisionBridge {
  const binary = opts.binaryPath ?? defaultBinaryPath();
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    async isAvailable(): Promise<boolean> {
      try {
        await access(binary);
        return true;
      } catch {
        return false;
      }
    },

    async capture(captureOpts): Promise<NativeCaptureResult> {
      const args: string[] = ["capture"];
      if (captureOpts?.bundleId) args.push("--app", captureOpts.bundleId);
      if (captureOpts?.outPath) args.push("--out", captureOpts.outPath);
      const stdout = await runHelper(binary, args, timeoutMs);
      return JSON.parse(stdout) as NativeCaptureResult;
    },

    async ocr(imagePath: string): Promise<NativeOcrResult> {
      const stdout = await runHelper(binary, ["ocr", "--image", imagePath], timeoutMs);
      return JSON.parse(stdout) as NativeOcrResult;
    },
  };
}

function runHelper(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, encoding: "utf8" },
      (err, stdout, stderr) => {
        const stderrStr = stderr ?? "";
        if (err) {
          const errno = (err as NodeJS.ErrnoException).code;
          if (errno === "ENOENT") {
            reject(new NativeBridgeUnavailableError(binary));
            return;
          }
          if (stderrStr.includes("permission-denied")) {
            reject(new ScreenPermissionDeniedError());
            return;
          }
          reject(new NativeBridgeError(err.message, stderrStr.trim()));
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}
