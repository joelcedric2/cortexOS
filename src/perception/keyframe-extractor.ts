/**
 * Phase 9.5 — extract keyframes from a short video clip.
 *
 * Shells to `ffmpeg` once per extraction, asking for N evenly-spaced
 * stills between t=0 and t=duration. The extractor is deliberately dumb —
 * it does NOT do scene-change detection or any ML; callers that want
 * "interesting" frames can layer that on top. For the vision pipeline,
 * evenly-spaced is the right trade-off: it captures the start, middle,
 * and end of the clip so motion / change is legible.
 *
 * Failure modes:
 *   - ffmpeg missing on PATH → {@link KeyframeExtractError} with
 *     code="ffmpeg-unavailable".
 *   - ffprobe reports duration == 0 or the video cannot be read →
 *     code="probe-failed".
 *   - extraction shells exit non-zero → code="extract-failed".
 *
 * This module writes keyframes next to (or under) the source clip and
 * returns their paths. It does NOT delete the source — retention is the
 * caller's job.
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface KeyframeExtractOptions {
  /** Number of keyframes to extract. Clamped to [1, 30]. Default 5. */
  count?: number;
  /** Directory to write frames into. Defaults to `<video-dir>/keyframes/`. */
  outDir?: string;
  /** Path / name of the ffmpeg binary. Default "ffmpeg". */
  ffmpegPath?: string;
  /**
   * Caller-supplied duration (seconds). If omitted we probe via ffprobe.
   * Tests inject this to avoid needing a real video.
   */
  durationSec?: number;
  /** Max time for a single ffmpeg invocation. Default 15s per frame. */
  timeoutMs?: number;
  /**
   * Injection seam for tests. When set, replaces every child-process
   * invocation with the given async fn. The fn receives (cmd, args, cwd)
   * and must resolve to the string stdout would have had.
   */
  exec?: (cmd: string, args: string[]) => Promise<string>;
}

export interface Keyframe {
  index: number;
  path: string;
  ts_sec: number;
}

export interface KeyframeSet {
  video_path: string;
  frames: Keyframe[];
  duration_sec: number;
}

export type KeyframeExtractErrorCode =
  | "ffmpeg-unavailable"
  | "probe-failed"
  | "extract-failed"
  | "invalid-video"
  | "invalid-count";

export class KeyframeExtractError extends Error {
  constructor(
    public readonly code: KeyframeExtractErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "KeyframeExtractError";
  }
}

export const KEYFRAME_DEFAULTS = Object.freeze({
  count: 5,
  minCount: 1,
  maxCount: 30,
  timeoutMs: 15_000,
});

/**
 * Extract evenly-spaced keyframes from `videoPath`.
 *
 * Chooses timestamps at 5%, 27.5%, 50%, 72.5%, 95% for N=5 — and in
 * general `(i + 0.5) / N` of the duration — so frame 1 isn't the black
 * leader and the last frame isn't the cut-to-black. Frames are written
 * as `frame_001.jpg` … `frame_NNN.jpg`.
 */
export async function extractKeyframes(
  videoPath: string,
  opts: KeyframeExtractOptions = {},
): Promise<KeyframeSet> {
  const count = clampCount(opts.count ?? KEYFRAME_DEFAULTS.count);
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const timeoutMs = opts.timeoutMs ?? KEYFRAME_DEFAULTS.timeoutMs;
  const exec = opts.exec ?? defaultExec(timeoutMs);

  await assertVideoReadable(videoPath);

  const outDir = opts.outDir ?? join(dirname(videoPath), "keyframes");
  await mkdir(outDir, { recursive: true });

  const durationSec = opts.durationSec ?? (await probeDuration(videoPath, ffmpegPath, exec));
  if (!(durationSec > 0)) {
    throw new KeyframeExtractError(
      "probe-failed",
      `ffprobe returned non-positive duration for ${videoPath}`,
    );
  }

  const stamps = computeTimestamps(durationSec, count);
  const frames: Keyframe[] = [];

  for (let i = 0; i < stamps.length; i++) {
    const ts = stamps[i]!;
    const framePath = join(outDir, `frame_${String(i + 1).padStart(3, "0")}.jpg`);
    try {
      await exec(ffmpegPath, [
        "-y",
        "-ss",
        ts.toFixed(3),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        framePath,
      ]);
    } catch (err) {
      throw mapExecError(err, ffmpegPath, "extract-failed");
    }
    frames.push({ index: i + 1, path: framePath, ts_sec: ts });
  }

  return { video_path: videoPath, frames, duration_sec: durationSec };
}

/**
 * Exposed so callers (camera-clip) can predict the paths without shelling
 * out first — useful for keeping I/O plans explicit in tests.
 */
export function computeTimestamps(durationSec: number, count: number): number[] {
  const n = clampCount(count);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // (i + 0.5) / n avoids t=0 (black leader) and t=D (cut-to-black).
    const ts = Math.max(0, Math.min(durationSec, ((i + 0.5) / n) * durationSec));
    // Round to 3-decimal precision — ffmpeg seeks at ms granularity.
    out.push(Math.round(ts * 1000) / 1000);
  }
  return out;
}

// ─── Internals ────────────────────────────────────────────────────────────

function clampCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) {
    throw new KeyframeExtractError(
      "invalid-count",
      `keyframe count must be positive (got ${n})`,
    );
  }
  return Math.max(
    KEYFRAME_DEFAULTS.minCount,
    Math.min(KEYFRAME_DEFAULTS.maxCount, Math.floor(n)),
  );
}

async function assertVideoReadable(videoPath: string): Promise<void> {
  try {
    const s = await stat(videoPath);
    if (!s.isFile() || s.size === 0) {
      throw new KeyframeExtractError(
        "invalid-video",
        `video path is not a readable file: ${videoPath}`,
      );
    }
  } catch (err) {
    if (err instanceof KeyframeExtractError) throw err;
    throw new KeyframeExtractError(
      "invalid-video",
      `cannot stat video file ${videoPath}`,
      err,
    );
  }
}

async function probeDuration(
  videoPath: string,
  ffmpegPath: string,
  exec: (cmd: string, args: string[]) => Promise<string>,
): Promise<number> {
  // Derive the ffprobe path from the ffmpeg path — if the user points to
  // a custom ffmpeg location, ffprobe sits next to it.
  const probeCmd = ffmpegPath === "ffmpeg"
    ? "ffprobe"
    : ffmpegPath.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
  try {
    const out = await exec(probeCmd, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    const n = Number.parseFloat(out.trim());
    if (!Number.isFinite(n)) {
      throw new KeyframeExtractError(
        "probe-failed",
        `ffprobe returned non-numeric duration: ${out.trim()}`,
      );
    }
    return n;
  } catch (err) {
    throw mapExecError(err, probeCmd, "probe-failed");
  }
}

function defaultExec(
  timeoutMs: number,
): (cmd: string, args: string[]) => Promise<string> {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        { timeout: timeoutMs, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err) {
            const errno = (err as NodeJS.ErrnoException).code;
            if (errno === "ENOENT") {
              reject(
                new KeyframeExtractError(
                  "ffmpeg-unavailable",
                  `${cmd} not found on PATH. Install ffmpeg or set --ffmpegPath.`,
                  err,
                ),
              );
              return;
            }
            const tail = (stderr ?? "").toString().trim();
            reject(new Error(tail.length > 0 ? tail : err.message));
            return;
          }
          resolve((stdout ?? "").toString());
        },
      );
    });
}

function mapExecError(
  err: unknown,
  cmd: string,
  fallback: KeyframeExtractErrorCode,
): KeyframeExtractError {
  if (err instanceof KeyframeExtractError) return err;
  if (err instanceof Error) {
    return new KeyframeExtractError(fallback, `${cmd}: ${err.message}`, err);
  }
  return new KeyframeExtractError(fallback, `${cmd}: ${String(err)}`, err);
}
