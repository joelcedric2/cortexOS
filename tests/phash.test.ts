/**
 * Tests for Phase 8.5 perceptual hash.
 *
 * The aHash math is pure — tests use synthetic 8×8 grayscale buffers and
 * never touch the disk. `computePhash(path)` is exercised via an injected
 * decoder stub so we never load sharp or shell to the Swift helper in CI.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  computePhash,
  computePhashFromPixels,
  hammingDistance,
  isDuplicate,
  PhashDecodeError,
  PhashDecoderUnavailableError,
  type PhashDecoder,
} from "../src/perception/phash.js";

function stubDecoder(pixels: Uint8Array): PhashDecoder {
  return {
    async decodeGray8x8() {
      return pixels;
    },
  };
}

function gray(n: number): Uint8Array {
  return new Uint8Array(64).fill(n);
}

describe("computePhashFromPixels (pure aHash)", () => {
  test("all-zero pixels → hash 0 (every pixel equals the mean)", () => {
    const hash = computePhashFromPixels(gray(0));
    assert.equal(hash, 0n);
  });

  test("all-max pixels → hash 0 (every pixel equals the mean)", () => {
    const hash = computePhashFromPixels(gray(255));
    assert.equal(hash, 0n);
  });

  test("half-bright / half-dark split has exactly 32 set bits", () => {
    const px = new Uint8Array(64);
    for (let i = 0; i < 32; i++) px[i] = 10;
    for (let i = 32; i < 64; i++) px[i] = 200;
    const hash = computePhashFromPixels(px);
    assert.equal(hammingDistance(hash, 0n), 32);
  });

  test("bit ordering: MSB is pixel[0], LSB is pixel[63]", () => {
    // Only the first pixel is above mean → bit 63 set, others clear.
    const px = new Uint8Array(64);
    px[0] = 255;
    const hash = computePhashFromPixels(px);
    assert.equal(hash, 1n << 63n);
  });

  test("wrong input size throws PhashDecodeError", () => {
    assert.throws(
      () => computePhashFromPixels(new Uint8Array(32)),
      PhashDecodeError,
    );
  });

  test("stable: same pixels → same hash", () => {
    const px = new Uint8Array(64);
    for (let i = 0; i < 64; i++) px[i] = (i * 7) % 256;
    const a = computePhashFromPixels(px);
    const b = computePhashFromPixels(px);
    assert.equal(a, b);
  });
});

describe("hammingDistance", () => {
  test("equal values → 0", () => {
    assert.equal(hammingDistance(0n, 0n), 0);
    assert.equal(hammingDistance(0xdeadbeefn, 0xdeadbeefn), 0);
  });

  test("one-bit difference → 1", () => {
    assert.equal(hammingDistance(0n, 1n), 1);
    assert.equal(hammingDistance(1n << 63n, 0n), 1);
  });

  test("complementary 64-bit values → 64", () => {
    const allOnes = 0xffffffffffffffffn;
    assert.equal(hammingDistance(0n, allOnes), 64);
  });

  test("ignores bits above 64", () => {
    const extra = 1n << 70n;
    // Only the stray-high bit differs; masked out → 0.
    assert.equal(hammingDistance(extra, 0n), 0);
  });

  test("is commutative", () => {
    const a = 0xdeadbeefcafebaben;
    const b = 0x0123456789abcdefn;
    assert.equal(hammingDistance(a, b), hammingDistance(b, a));
  });
});

describe("isDuplicate", () => {
  test("identical hashes are duplicates at any threshold", () => {
    assert.equal(isDuplicate(42n, 42n), true);
    assert.equal(isDuplicate(42n, 42n, 0), true);
  });

  test("default threshold is 4 — 4-bit difference is still duplicate", () => {
    const a = 0n;
    const b = 0b1111n;
    assert.equal(isDuplicate(a, b), true);
  });

  test("default threshold rejects 5-bit difference", () => {
    const a = 0n;
    const b = 0b11111n;
    assert.equal(isDuplicate(a, b), false);
  });

  test("threshold=0 requires exact match", () => {
    assert.equal(isDuplicate(0n, 1n, 0), false);
    assert.equal(isDuplicate(0n, 0n, 0), true);
  });

  test("negative threshold throws", () => {
    assert.throws(() => isDuplicate(0n, 0n, -1), RangeError);
  });
});

describe("computePhash (injected decoder)", () => {
  test("delegates to decoder, returns computed hash", async () => {
    const px = new Uint8Array(64);
    px[0] = 255; // single bright pixel → hash 1<<63
    const decoder = stubDecoder(px);

    const hash = await computePhash("/fake/path.png", { decoder });
    assert.equal(hash, 1n << 63n);
  });

  test("two identical fake PNGs → Hamming distance 0 (DoD)", async () => {
    const px = new Uint8Array(64);
    for (let i = 0; i < 64; i++) px[i] = (i * 3) % 256;
    const decoder = stubDecoder(px);

    const a = await computePhash("/fake/a.png", { decoder });
    const b = await computePhash("/fake/b.png", { decoder });

    assert.equal(hammingDistance(a, b), 0);
    assert.equal(isDuplicate(a, b), true);
  });

  test("different images → non-zero Hamming distance", async () => {
    const pxA = new Uint8Array(64);
    const pxB = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      pxA[i] = i < 20 ? 30 : 200;
      pxB[i] = i < 40 ? 30 : 200;
    }
    const decoderA = stubDecoder(pxA);
    const decoderB = stubDecoder(pxB);

    const a = await computePhash("/fake/a.png", { decoder: decoderA });
    const b = await computePhash("/fake/b.png", { decoder: decoderB });

    assert.ok(hammingDistance(a, b) > 0, "distinct images must differ");
  });

  test("decoder errors surface as PhashDecodeError unchanged", async () => {
    const broken: PhashDecoder = {
      async decodeGray8x8() {
        throw new PhashDecodeError("synthetic decode fail");
      },
    };
    await assert.rejects(
      () => computePhash("/fake/x.png", { decoder: broken }),
      PhashDecodeError,
    );
  });
});

describe("exported error types", () => {
  test("PhashDecoderUnavailableError is an Error", () => {
    const e = new PhashDecoderUnavailableError();
    assert.ok(e instanceof Error);
    assert.equal(e.name, "PhashDecoderUnavailableError");
  });
});
