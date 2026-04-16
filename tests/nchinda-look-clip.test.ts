/**
 * Phase 9.5 — nchinda_look clip-mode tests.
 *
 * Covers: default clip mode sends N images to Sonnet; still mode
 * preserves backward compat; mode selection correct; multi-image prompt
 * format.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { nchindaLook } from "../src/mcp/nchinda-look.js";
import type { CameraClip, CameraClipOptions } from "../src/perception/camera-clip.js";

function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function jpegOnDisk(dir: string, name?: string): string {
  const p = join(dir, name ?? `${Math.random().toString(36).slice(2)}.jpg`);
  writeFileSync(p, "fake-jpeg-bytes");
  return p;
}

function fakeClipCapture(dir: string, keyframeCount: number = 5) {
  const paths = Array.from({ length: keyframeCount }, (_, i) =>
    jpegOnDisk(dir, `kf_${i}.jpg`),
  );
  let callCount = 0;
  let lastOpts: CameraClipOptions | undefined;
  const fn = (async (opts?: CameraClipOptions): Promise<CameraClip> => {
    callCount++;
    lastOpts = opts;
    return {
      id: "clip-test-1",
      ts: new Date("2026-04-15T12:00:00Z"),
      video_path: null,
      keyframes: paths.map((p, i) => ({ path: p, ts_sec: i * 2 })),
      duration_sec: 10,
      width: 1280,
      height: 720,
      device: opts?.device ?? "front",
    };
  }) as any;
  fn.calls = () => callCount;
  fn.lastOpts = () => lastOpts;
  fn.paths = paths;
  return fn;
}

// ─── Default mode is clip ─────────────────────────────────────────────

describe("nchinda_look — clip mode", () => {
  it("defaults to clip mode when mode is omitted", async () => {
    await withTempDir("p95-look-default", async (dir) => {
      const captureClip = fakeClipCapture(dir, 3);
      const ocr = async () => ({ text: "" });
      const haikuFetch: typeof fetch = async (_url, init) => {
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "A person sitting at a desk." }],
          }),
          { status: 200 },
        );
      };

      const result = await nchindaLook(
        { question: "what do you see" },
        { captureClip, ocr, haikuFetch, apiKey: "k" },
      );

      assert.equal(result.mode, "clip");
      assert.ok(result.clip, "clip metadata must be present");
      assert.equal(result.clip!.id, "clip-test-1");
      assert.equal(result.clip!.keyframe_count, 3);
      assert.equal(result.clip!.duration_sec, 10);
      assert.equal(result.frame, undefined, "still-mode frame must be absent");
      assert.match(result.description, /desk/i);
      assert.equal(captureClip.calls(), 1);
    });
  });

  it("sends all N keyframes as image blocks in a single multi-image prompt", async () => {
    await withTempDir("p95-look-multi", async (dir) => {
      const captureClip = fakeClipCapture(dir, 5);
      const ocr = async () => ({ text: "SIGN: EXIT" });
      let sonnetBody: any;
      const haikuFetch: typeof fetch = async (_url, init) => {
        sonnetBody = JSON.parse((init?.body ?? "{}") as string);
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "An exit sign above a door." }],
          }),
          { status: 200 },
        );
      };

      await nchindaLook(
        { question: "what sign is that" },
        { captureClip, ocr, haikuFetch, apiKey: "k" },
      );

      // Verify multi-image structure.
      const content = sonnetBody.messages[0].content;
      const imageBlocks = content.filter((b: any) => b.type === "image");
      const textBlocks = content.filter((b: any) => b.type === "text");
      assert.equal(imageBlocks.length, 5, "must send 5 image blocks");
      assert.equal(textBlocks.length, 1, "must send 1 text block");
      assert.match(textBlocks[0].text, /keyframes/i);
      assert.match(textBlocks[0].text, /Question: what sign is that/);

      // Verify clip system prompt is used.
      assert.match(sonnetBody.system, /keyframes from a 10-second video clip/);
    });
  });

  it("includes OCR text from first keyframe in the prompt", async () => {
    await withTempDir("p95-look-ocr", async (dir) => {
      const captureClip = fakeClipCapture(dir, 2);
      let ocrPath: string | undefined;
      const ocr = async (p: string) => {
        ocrPath = p;
        return { text: "OCR CONTENT HERE" };
      };
      let sonnetBody: any;
      const haikuFetch: typeof fetch = async (_url, init) => {
        sonnetBody = JSON.parse((init?.body ?? "{}") as string);
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "desc" }] }),
          { status: 200 },
        );
      };

      const result = await nchindaLook(
        {},
        { captureClip, ocr, haikuFetch, apiKey: "k" },
      );

      // OCR should be called with the first keyframe path.
      assert.equal(ocrPath, captureClip.paths[0]);
      assert.equal(result.ocr_text, "OCR CONTENT HERE");
      // The text block should include OCR content.
      const textBlock = sonnetBody.messages[0].content.find(
        (b: any) => b.type === "text",
      );
      assert.match(textBlock.text, /OCR CONTENT HERE/);
    });
  });

  it("falls back to local-only when no API key in clip mode", async () => {
    await withTempDir("p95-look-clip-nokey", async (dir) => {
      const captureClip = fakeClipCapture(dir, 2);
      const ocr = async () => ({ text: "HELLO" });
      let fetchCalled = false;
      const haikuFetch: typeof fetch = async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      };

      const prev = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const result = await nchindaLook(
          {},
          { captureClip, ocr, haikuFetch },
        );
        assert.equal(fetchCalled, false);
        assert.match(result.description, /Local-only reply/);
        assert.match(result.description, /no-api-key/);
        assert.equal(result.mode, "clip");
      } finally {
        if (prev) process.env.ANTHROPIC_API_KEY = prev;
      }
    });
  });
});

// ─── Still mode backward compat ───────────────────────────────────────

describe("nchinda_look — still mode backward compat", () => {
  it("uses single-frame path when mode=still", async () => {
    await withTempDir("p95-look-still", async (dir) => {
      const jpeg = jpegOnDisk(dir);
      let capturedStill = false;
      const capture = (async () => {
        capturedStill = true;
        return {
          id: "still-1",
          ts: new Date("2026-04-15T12:00:00Z"),
          jpeg_path: jpeg,
          width: 640,
          height: 480,
          device: "front",
        };
      }) as any;

      const ocr = async () => ({ text: "" });
      const haikuFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "A wall." }] }),
          { status: 200 },
        );

      const result = await nchindaLook(
        { mode: "still" },
        { capture, ocr, haikuFetch, apiKey: "k" },
      );

      assert.equal(capturedStill, true);
      assert.equal(result.mode, "still");
      assert.ok(result.frame);
      assert.equal(result.frame!.id, "still-1");
      assert.equal(result.clip, undefined);
    });
  });
});

// ─── Mode selection correctness ───────────────────────────────────────

describe("nchinda_look — mode selection", () => {
  it("explicit mode=clip uses captureClip, not single-frame capture", async () => {
    await withTempDir("p95-look-explicit-clip", async (dir) => {
      let usedStill = false;
      const capture = (async () => {
        usedStill = true;
        return {
          id: "x",
          ts: new Date(),
          jpeg_path: "/tmp/x.jpg",
          width: 1,
          height: 1,
          device: "front",
        };
      }) as any;
      const captureClip = fakeClipCapture(dir, 1);
      const ocr = async () => ({ text: "" });
      const haikuFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
          { status: 200 },
        );

      await nchindaLook(
        { mode: "clip" },
        { capture, captureClip, ocr, haikuFetch, apiKey: "k" },
      );

      assert.equal(usedStill, false, "single-frame capture must NOT be invoked in clip mode");
      assert.equal(captureClip.calls(), 1);
    });
  });

  it("rejects an invalid mode", async () => {
    await assert.rejects(
      () => nchindaLook({ mode: "video" }),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});
