/**
 * Tests for the Phase 8 `ocrImage()` wrapper.
 *
 * All tests inject a fake VisionBridge + fileExists — the real Swift binary
 * is never invoked. CI wouldn't have it and we don't want a flake there.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { OCRUnavailableError, ocrImage } from "../src/perception/ocr.js";
import {
  NativeBridgeUnavailableError,
  ScreenPermissionDeniedError,
  type NativeCaptureResult,
  type NativeOcrResult,
  type VisionBridge,
} from "../src/perception/native-bridge.js";

function bridgeFromOcr(
  impl: (path: string) => Promise<NativeOcrResult> | NativeOcrResult,
): VisionBridge {
  return {
    async isAvailable() {
      return true;
    },
    async capture(): Promise<NativeCaptureResult> {
      throw new Error("not used in ocr tests");
    },
    async ocr(p) {
      return await impl(p);
    },
  };
}

describe("ocrImage", () => {
  const fileExists = async () => true;

  test("parses native JSON into OcrResult", async () => {
    const bridge = bridgeFromOcr(() => ({
      blocks: [
        {
          text: "Hello world",
          bbox: { x: 10, y: 20, w: 100, h: 30 },
          confidence: 0.97,
        },
        {
          text: "Subject: follow up",
          bbox: { x: 12, y: 60, w: 200, h: 28 },
          confidence: 0.88,
        },
      ],
      text: "Hello world\nSubject: follow up",
      duration_ms: 42,
    }));

    const result = await ocrImage("/fake/path.png", { bridge, fileExists });
    assert.equal(result.text, "Hello world\nSubject: follow up");
    assert.equal(result.blocks.length, 2);
    assert.equal(result.blocks[0].text, "Hello world");
    assert.equal(result.blocks[0].confidence, 0.97);
    assert.deepEqual(result.blocks[0].bbox, { x: 10, y: 20, w: 100, h: 30 });
    assert.equal(result.duration_ms, 42);
  });

  test("missing binary throws OCRUnavailableError with cause chain", async () => {
    const bridge = bridgeFromOcr(() => {
      throw new NativeBridgeUnavailableError("/opt/cortexos/bin/cortexos-vision");
    });

    await assert.rejects(
      () => ocrImage("/fake/path.png", { bridge, fileExists }),
      (err: unknown) => {
        assert.ok(err instanceof OCRUnavailableError);
        assert.match(err.message, /helper not installed/i);
        assert.ok(err.cause instanceof NativeBridgeUnavailableError);
        return true;
      },
    );
  });

  test("permission denied also surfaces as OCRUnavailableError", async () => {
    const bridge = bridgeFromOcr(() => {
      throw new ScreenPermissionDeniedError();
    });

    await assert.rejects(
      () => ocrImage("/fake/path.png", { bridge, fileExists }),
      (err: unknown) => {
        assert.ok(err instanceof OCRUnavailableError);
        assert.ok(err.cause instanceof ScreenPermissionDeniedError);
        return true;
      },
    );
  });

  test("generic bridge errors propagate unchanged", async () => {
    const bridge = bridgeFromOcr(() => {
      throw new Error("unexpected swift crash");
    });

    await assert.rejects(
      () => ocrImage("/fake/path.png", { bridge, fileExists }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof OCRUnavailableError));
        assert.match(err.message, /swift crash/);
        return true;
      },
    );
  });

  test("missing file throws a clear error", async () => {
    const bridge = bridgeFromOcr(() => ({ blocks: [], text: "", duration_ms: 0 }));
    await assert.rejects(
      () =>
        ocrImage("/nope.png", {
          bridge,
          fileExists: async () => false,
        }),
      /file not found/,
    );
  });

  test("pngPath is required", async () => {
    await assert.rejects(
      () => ocrImage("", { fileExists }),
      /pngPath is required/,
    );
  });

  test("empty block list produces empty text", async () => {
    const bridge = bridgeFromOcr(() => ({
      blocks: [],
      text: "",
      duration_ms: 3,
    }));
    const result = await ocrImage("/x.png", { bridge, fileExists });
    assert.equal(result.text, "");
    assert.equal(result.blocks.length, 0);
    assert.equal(result.duration_ms, 3);
  });

  test("backfills text from blocks when native payload omits it", async () => {
    const bridge = bridgeFromOcr(
      () =>
        ({
          blocks: [
            { text: "alpha", bbox: { x: 0, y: 0, w: 1, h: 1 }, confidence: 0.9 },
            { text: "beta", bbox: { x: 0, y: 10, w: 1, h: 1 }, confidence: 0.8 },
          ],
          duration_ms: 10,
        }) as unknown as NativeOcrResult,
    );
    const result = await ocrImage("/x.png", { bridge, fileExists });
    assert.equal(result.text, "alpha\nbeta");
  });

  test("default confidence is 0 when native omits it", async () => {
    const bridge = bridgeFromOcr(
      () =>
        ({
          blocks: [
            { text: "x", bbox: { x: 0, y: 0, w: 1, h: 1 } },
          ],
          text: "x",
          duration_ms: 1,
        }) as unknown as NativeOcrResult,
    );
    const result = await ocrImage("/x.png", { bridge, fileExists });
    assert.equal(result.blocks[0].confidence, 0);
  });
});
