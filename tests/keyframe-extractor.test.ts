/**
 * Phase 9.5 — `extractKeyframes` unit tests.
 *
 * Uses a fake `exec` so ffmpeg / ffprobe are never actually invoked.
 * Covers timestamp arithmetic, count clamping, ffmpeg-unavailable
 * surfacing, and the file-readable precondition.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeTimestamps,
  extractKeyframes,
  KeyframeExtractError,
  KEYFRAME_DEFAULTS,
} from "../src/perception/keyframe-extractor.js";

function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writeFakeVideo(dir: string, name: string = "clip.mp4"): string {
  const p = join(dir, name);
  // Non-empty so stat() treats it as a real file.
  writeFileSync(p, "mp4-bytes-ignored-by-fake-exec");
  return p;
}

// ─── computeTimestamps — pure arithmetic ──────────────────────────────

describe("computeTimestamps", () => {
  it("returns N evenly-spaced stamps avoiding both endpoints", () => {
    const ts = computeTimestamps(10, 5);
    // Offsets at (i+0.5)/5 × 10 = 1, 3, 5, 7, 9.
    assert.deepEqual(ts, [1, 3, 5, 7, 9]);
  });

  it("clamps count upward to KEYFRAME_DEFAULTS.maxCount", () => {
    const ts = computeTimestamps(10, 500);
    assert.equal(ts.length, KEYFRAME_DEFAULTS.maxCount);
  });

  it("clamps count downward to at least 1", () => {
    assert.throws(
      () => computeTimestamps(10, 0),
      (e) => e instanceof KeyframeExtractError && e.code === "invalid-count",
    );
  });

  it("never emits a stamp > duration", () => {
    const ts = computeTimestamps(1, 5);
    for (const t of ts) assert.ok(t <= 1, `t=${t} exceeds duration`);
  });

  it("rounds to 3-decimal ms precision", () => {
    const ts = computeTimestamps(3.14159, 5);
    for (const t of ts) {
      const decimals = (t.toString().split(".")[1] ?? "").length;
      assert.ok(decimals <= 3, `t=${t} has >3 decimals`);
    }
  });
});

// ─── extractKeyframes — happy path ────────────────────────────────────

describe("extractKeyframes — happy path", () => {
  it("probes duration via ffprobe and writes N frames", async () => {
    await withTempDir("p95-kf-happy", async (dir) => {
      const video = writeFakeVideo(dir);
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const exec = async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (cmd === "ffprobe") return "10.000000\n";
        return "";
      };

      const result = await extractKeyframes(video, {
        count: 5,
        outDir: join(dir, "frames"),
        exec,
      });

      assert.equal(result.video_path, video);
      assert.equal(result.duration_sec, 10);
      assert.equal(result.frames.length, 5);
      // Filenames are frame_001.jpg … frame_005.jpg.
      for (let i = 0; i < 5; i++) {
        const f = result.frames[i]!;
        assert.equal(f.index, i + 1);
        assert.match(f.path, new RegExp(`frame_00${i + 1}\\.jpg$`));
      }
      // ffprobe called exactly once, ffmpeg called N times.
      const cmds = calls.map((c) => c.cmd);
      assert.equal(cmds.filter((c) => c === "ffprobe").length, 1);
      assert.equal(cmds.filter((c) => c === "ffmpeg").length, 5);
      // Each ffmpeg call uses -ss + -frames:v 1.
      for (const c of calls.filter((c) => c.cmd === "ffmpeg")) {
        assert.ok(c.args.includes("-ss"));
        assert.ok(c.args.includes("-frames:v"));
      }
    });
  });

  it("skips the ffprobe call when durationSec is supplied", async () => {
    await withTempDir("p95-kf-dur", async (dir) => {
      const video = writeFakeVideo(dir);
      let probed = false;
      const exec = async (cmd: string) => {
        if (cmd === "ffprobe") probed = true;
        return "";
      };

      const result = await extractKeyframes(video, {
        count: 3,
        durationSec: 7.5,
        outDir: join(dir, "frames"),
        exec,
      });

      assert.equal(probed, false);
      assert.equal(result.duration_sec, 7.5);
      assert.equal(result.frames.length, 3);
    });
  });

  it("uses the default count (5) when not specified", async () => {
    await withTempDir("p95-kf-default", async (dir) => {
      const video = writeFakeVideo(dir);
      const exec = async () => "10.0";
      const result = await extractKeyframes(video, { exec });
      assert.equal(result.frames.length, KEYFRAME_DEFAULTS.count);
      assert.equal(KEYFRAME_DEFAULTS.count, 5);
    });
  });
});

// ─── extractKeyframes — failure surfaces ──────────────────────────────

describe("extractKeyframes — errors", () => {
  it("surfaces ffmpeg-unavailable when ENOENT fires on the probe", async () => {
    await withTempDir("p95-kf-missing", async (dir) => {
      const video = writeFakeVideo(dir);
      const exec = async () => {
        const e = Object.assign(new Error("spawn ffprobe ENOENT"), {
          code: "ENOENT",
        });
        // Simulate the wrapper's ENOENT → KeyframeExtractError mapping so
        // we don't have to run the real execFile.
        throw new KeyframeExtractError(
          "ffmpeg-unavailable",
          "ffprobe not found on PATH.",
          e,
        );
      };
      await assert.rejects(
        () => extractKeyframes(video, { exec }),
        (err) => {
          assert.ok(err instanceof KeyframeExtractError);
          assert.equal(err.code, "ffmpeg-unavailable");
          return true;
        },
      );
    });
  });

  it("rejects invalid-video for a missing source file", async () => {
    await assert.rejects(
      () => extractKeyframes("/tmp/does-not-exist-0943872.mp4"),
      (err) => {
        assert.ok(err instanceof KeyframeExtractError);
        assert.equal(err.code, "invalid-video");
        return true;
      },
    );
  });

  it("rejects probe-failed when ffprobe returns non-numeric duration", async () => {
    await withTempDir("p95-kf-bad-probe", async (dir) => {
      const video = writeFakeVideo(dir);
      const exec = async () => "N/A\n";
      await assert.rejects(
        () => extractKeyframes(video, { exec }),
        (err) => {
          assert.ok(err instanceof KeyframeExtractError);
          assert.equal(err.code, "probe-failed");
          return true;
        },
      );
    });
  });

  it("rejects probe-failed for zero-duration videos", async () => {
    await withTempDir("p95-kf-zero", async (dir) => {
      const video = writeFakeVideo(dir);
      const exec = async () => "0.000000\n";
      await assert.rejects(
        () => extractKeyframes(video, { exec }),
        (err) => {
          assert.ok(err instanceof KeyframeExtractError);
          assert.equal(err.code, "probe-failed");
          return true;
        },
      );
    });
  });

  it("surfaces extract-failed when ffmpeg throws during extraction", async () => {
    await withTempDir("p95-kf-extract-fail", async (dir) => {
      const video = writeFakeVideo(dir);
      const exec = async (cmd: string) => {
        if (cmd === "ffprobe") return "10.0";
        throw new Error("ffmpeg: codec failure");
      };
      await assert.rejects(
        () => extractKeyframes(video, { exec, durationSec: 10 }),
        (err) => {
          assert.ok(err instanceof KeyframeExtractError);
          assert.equal(err.code, "extract-failed");
          return true;
        },
      );
    });
  });
});
