/**
 * Phase 8.5 — 64-bit perceptual hash (aHash).
 *
 * Used by the screen-capture adaptive-rate controller to detect near-duplicate
 * frames. Identical screens produce identical hashes; small UI changes (cursor
 * blink, clock tick) produce a small Hamming distance.
 *
 * Algorithm (aHash):
 *   1. Resize the PNG to 8×8 grayscale (64 samples, 0..255).
 *   2. Compute the mean pixel value.
 *   3. Bit i = 1 if pixel_i > mean else 0 → 64-bit unsigned integer as bigint.
 *
 * The algorithm itself is pure and has zero deps — see `computePhashFromPixels`.
 * Reading pixels from disk is delegated to a pluggable `PhashDecoder`; the
 * default tries `sharp` (transitive dep via @huggingface/transformers) and, if
 * that is unavailable, shells to the Swift helper subcommand `phash`.
 *
 * Privacy: no network I/O. All work is local CPU.
 */
import { execFile } from "node:child_process";
import type { VisionBridge } from "./native-bridge.js";
import { defaultBinaryPath } from "./native-bridge.js";

/** Decodes a PNG path into a row-major 64-sample 8×8 grayscale buffer. */
export interface PhashDecoder {
  decodeGray8x8(pngPath: string): Promise<Uint8Array>;
}

export interface ComputePhashOptions {
  /** Override for tests — skip the default sharp/Swift decode path. */
  decoder?: PhashDecoder;
  /** Only used by the default decoder when it falls back to Swift. */
  bridge?: Pick<VisionBridge, "isAvailable">;
}

/** Thrown when neither `sharp` nor the Swift helper are usable. */
export class PhashDecoderUnavailableError extends Error {
  constructor() {
    super(
      "phash: no decoder available. Install 'sharp' or build cortexos-vision (scripts/native/build-vision.sh).",
    );
    this.name = "PhashDecoderUnavailableError";
  }
}

/** Thrown when the provided PNG cannot be decoded. */
export class PhashDecodeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PhashDecodeError";
  }
}

// ─── Pure algorithm ─────────────────────────────────────────────────────────

/**
 * Compute the 64-bit aHash from a 64-sample 8×8 grayscale buffer.
 *
 * Bit ordering: bit 63 is pixel[0] (top-left, MSB), bit 0 is pixel[63]
 * (bottom-right, LSB). Stable across Node versions.
 */
export function computePhashFromPixels(pixels: Uint8Array): bigint {
  if (pixels.length !== 64) {
    throw new PhashDecodeError(
      `phash expects 64 pixels (8×8 grayscale), got ${pixels.length}`,
    );
  }
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += pixels[i]!;
  const mean = sum / 64;

  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (pixels[i]! > mean) {
      // bit (63 - i) set
      hash |= 1n << BigInt(63 - i);
    }
  }
  return hash;
}

/** XOR-popcount Hamming distance between two 64-bit hashes. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = (a ^ b) & 0xffffffffffffffffn;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

/**
 * Policy-tunable duplicate detector. Default `maxHamming=4` — a screen with
 * a blinking cursor or a one-second clock tick usually differs by ≤2 bits.
 */
export function isDuplicate(
  prev: bigint,
  current: bigint,
  maxHamming: number = 4,
): boolean {
  if (maxHamming < 0) {
    throw new RangeError(`isDuplicate: maxHamming must be >= 0, got ${maxHamming}`);
  }
  return hammingDistance(prev, current) <= maxHamming;
}

// ─── I/O path ───────────────────────────────────────────────────────────────

/**
 * Compute the 64-bit aHash for a PNG on disk.
 *
 * Prefers the injected decoder → `sharp` → Swift helper, in that order.
 */
export async function computePhash(
  pngPath: string,
  opts: ComputePhashOptions = {},
): Promise<bigint> {
  const decoder = opts.decoder ?? (await createDefaultDecoder(opts.bridge));
  const pixels = await decoder.decodeGray8x8(pngPath);
  return computePhashFromPixels(pixels);
}

// ─── Default decoders ───────────────────────────────────────────────────────

async function createDefaultDecoder(
  bridge?: Pick<VisionBridge, "isAvailable">,
): Promise<PhashDecoder> {
  const sharpDecoder = await trySharpDecoder();
  if (sharpDecoder) return sharpDecoder;

  const swiftDecoder = await trySwiftDecoder(bridge);
  if (swiftDecoder) return swiftDecoder;

  throw new PhashDecoderUnavailableError();
}

async function trySharpDecoder(): Promise<PhashDecoder | null> {
  try {
    // Dynamic import — sharp is an optional dep. Swallow load failures.
    const mod = (await import("sharp").catch(() => null)) as
      | { default: SharpFactory }
      | null;
    if (!mod) return null;
    const sharp = mod.default;
    return {
      async decodeGray8x8(pngPath: string): Promise<Uint8Array> {
        try {
          const buf = await sharp(pngPath)
            .resize(8, 8, { fit: "fill", kernel: "lanczos3" })
            .grayscale()
            .raw()
            .toBuffer();
          if (buf.length !== 64) {
            throw new PhashDecodeError(
              `sharp returned ${buf.length} bytes; expected 64`,
            );
          }
          return new Uint8Array(buf);
        } catch (err) {
          if (err instanceof PhashDecodeError) throw err;
          throw new PhashDecodeError(
            `sharp failed to decode ${pngPath}`,
            err,
          );
        }
      },
    };
  } catch {
    return null;
  }
}

async function trySwiftDecoder(
  bridge?: Pick<VisionBridge, "isAvailable">,
): Promise<PhashDecoder | null> {
  if (bridge && !(await bridge.isAvailable())) return null;
  const binary = defaultBinaryPath();
  return {
    async decodeGray8x8(pngPath: string): Promise<Uint8Array> {
      const stdout = await runHelperJson(binary, [
        "phash",
        "--in",
        pngPath,
        "--raw",
      ]);
      // Expected JSON shape: { pixels: number[] } — a 64-element array.
      const parsed = JSON.parse(stdout) as { pixels?: unknown };
      if (!Array.isArray(parsed.pixels) || parsed.pixels.length !== 64) {
        throw new PhashDecodeError(
          `cortexos-vision phash returned malformed pixels for ${pngPath}`,
        );
      }
      const out = new Uint8Array(64);
      for (let i = 0; i < 64; i++) {
        const v = Number(parsed.pixels[i]);
        if (!Number.isFinite(v) || v < 0 || v > 255) {
          throw new PhashDecodeError(
            `cortexos-vision phash returned out-of-range pixel ${String(parsed.pixels[i])}`,
          );
        }
        out[i] = Math.round(v);
      }
      return out;
    },
  };
}

function runHelperJson(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: 5_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new PhashDecodeError(
              `cortexos-vision phash failed: ${err.message}`,
              (stderr ?? "").trim(),
            ),
          );
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}

// ─── Internal types ─────────────────────────────────────────────────────────

/** Minimal structural type of the sharp factory we consume — avoids any. */
interface SharpInstance {
  resize(
    width: number,
    height: number,
    opts?: { fit?: string; kernel?: string },
  ): SharpInstance;
  grayscale(): SharpInstance;
  raw(): SharpInstance;
  toBuffer(): Promise<Buffer>;
}
type SharpFactory = (input: string) => SharpInstance;
