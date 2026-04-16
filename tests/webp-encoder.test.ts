/**
 * Tests for Phase 8.5 WebP encoder.
 *
 * CI has no guarantee that `cortexos-vision` is built or that `sharp` is
 * installed; every test injects a stub `WebPEncoderBridge` instead. A single
 * real-fs test confirms the stat-based byte count, using the stub to write
 * deterministic bytes.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  encodeWebP,
  WebPEncodeError,
  WEBP_DEFAULTS,
  type WebPEncoderBridge,
} from "../src/perception/webp-encoder.js";

interface StubState {
  calls: Array<{
    inPath: string;
    outPath: string;
    quality: number;
    maxWidth: number;
  }>;
  failure?: Error;
  bodyBytes?: Buffer;
}

function stubBridge(state: StubState): WebPEncoderBridge {
  return {
    async encodeWebP(opts) {
      state.calls.push(opts);
      if (state.failure) throw state.failure;
      const body = state.bodyBytes ?? Buffer.from("RIFFWEBP-STUB");
      await writeFile(opts.outPath, body);
    },
  };
}

describe("encodeWebP", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "cortexos-webp-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("default quality + max-width are plumbed to the bridge", async () => {
    const state: StubState = { calls: [] };
    const inPath = join(workDir, "frame.png");
    await writeFile(inPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await encodeWebP(inPath, { bridge: stubBridge(state) });

    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0]!.quality, WEBP_DEFAULTS.QUALITY);
    assert.equal(state.calls[0]!.quality, 75);
    assert.equal(state.calls[0]!.maxWidth, WEBP_DEFAULTS.MAX_WIDTH);
    assert.equal(state.calls[0]!.maxWidth, 1280);
    assert.equal(state.calls[0]!.inPath, inPath);
  });

  test("quality override flows through unchanged", async () => {
    const state: StubState = { calls: [] };
    const inPath = join(workDir, "frame.png");
    await writeFile(inPath, "png");

    await encodeWebP(inPath, { bridge: stubBridge(state), quality: 40 });

    assert.equal(state.calls[0]!.quality, 40);
  });

  test("maxWidth override flows through unchanged", async () => {
    const state: StubState = { calls: [] };
    const inPath = join(workDir, "frame.png");
    await writeFile(inPath, "png");

    await encodeWebP(inPath, { bridge: stubBridge(state), maxWidth: 640 });

    assert.equal(state.calls[0]!.maxWidth, 640);
  });

  test("returns outPath + bytes matching the file on disk", async () => {
    const payload = Buffer.alloc(512, 0xaa);
    const state: StubState = { calls: [], bodyBytes: payload };
    const inPath = join(workDir, "frame.png");
    await writeFile(inPath, "png");

    const result = await encodeWebP(inPath, { bridge: stubBridge(state) });

    assert.equal(result.outPath, join(workDir, "frame.webp"));
    assert.equal(result.bytes, payload.length);
  });

  test("custom outPath is respected", async () => {
    const state: StubState = { calls: [] };
    const inPath = join(workDir, "frame.png");
    const outPath = join(workDir, "custom.webp");
    await writeFile(inPath, "png");

    const result = await encodeWebP(inPath, {
      bridge: stubBridge(state),
      outPath,
    });

    assert.equal(result.outPath, outPath);
    assert.equal(state.calls[0]!.outPath, outPath);
  });

  test("derives .webp sibling when input lacks .png extension", async () => {
    const state: StubState = { calls: [] };
    const inPath = join(workDir, "raw-frame");
    await writeFile(inPath, "png");

    const result = await encodeWebP(inPath, { bridge: stubBridge(state) });

    assert.ok(
      result.outPath.endsWith(".webp"),
      `expected .webp suffix, got ${result.outPath}`,
    );
    assert.notEqual(result.outPath, inPath);
  });

  test("bridge failure is wrapped in WebPEncodeError with the cause", async () => {
    const cause = new Error("helper stderr: permission-denied");
    const state: StubState = { calls: [], failure: cause };
    const inPath = join(workDir, "frame.png");
    await writeFile(inPath, "png");

    await assert.rejects(
      () => encodeWebP(inPath, { bridge: stubBridge(state) }),
      (err: unknown) => {
        assert.ok(err instanceof WebPEncodeError, "error must be WebPEncodeError");
        assert.equal((err as WebPEncodeError).cause, cause);
        return true;
      },
    );
  });

  test("missing output file surfaces WebPEncodeError (bridge silent-no-op)", async () => {
    const brokenBridge: WebPEncoderBridge = {
      async encodeWebP() {
        // pretend success but write nothing
      },
    };
    const inPath = join(workDir, "frame.png");
    await writeFile(inPath, "png");

    await assert.rejects(
      () => encodeWebP(inPath, { bridge: brokenBridge }),
      WebPEncodeError,
    );
  });

  test("invalid quality is rejected before hitting the bridge", async () => {
    const state: StubState = { calls: [] };
    const inPath = join(workDir, "frame.png");
    await writeFile(inPath, "png");

    await assert.rejects(
      () => encodeWebP(inPath, { bridge: stubBridge(state), quality: 101 }),
      WebPEncodeError,
    );
    await assert.rejects(
      () => encodeWebP(inPath, { bridge: stubBridge(state), quality: -1 }),
      WebPEncodeError,
    );
    assert.equal(state.calls.length, 0);
  });

  test("invalid maxWidth is rejected before hitting the bridge", async () => {
    const state: StubState = { calls: [] };
    const inPath = join(workDir, "frame.png");
    await writeFile(inPath, "png");

    await assert.rejects(
      () => encodeWebP(inPath, { bridge: stubBridge(state), maxWidth: 0 }),
      WebPEncodeError,
    );
    assert.equal(state.calls.length, 0);
  });
});
