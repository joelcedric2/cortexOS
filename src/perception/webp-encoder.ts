/**
 * Phase 8.5 — WebP encoder (q=75 default) invoked at screen-capture time.
 *
 * The primary path shells to the Swift helper at
 * `~/.cortexos/bin/cortexos-vision encode-webp --in <png> --out <webp>
 *  --quality <N> --max-width <px>`.
 *
 * If the helper is unavailable we fall back to `sharp` (transitive dep
 * via @huggingface/transformers). The fallback is documented in
 * docs/phase-8/DECISIONS.md.
 *
 * Privacy: no network I/O — both paths run entirely on the local CPU.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { VisionBridge } from "./native-bridge.js";
import { defaultBinaryPath } from "./native-bridge.js";

/** Thrown on any encode failure — wraps the underlying cause. */
export class WebPEncodeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "WebPEncodeError";
  }
}

export interface WebPEncodeOptions {
  /** q ∈ [0, 100]. Default 75 — the Phase 8.5 §8.5 bullet 1 spec. */
  quality?: number;
  /** Aspect-preserving max width in pixels. Default 1280. */
  maxWidth?: number;
  /** Explicit output path. If omitted, derived from the input path. */
  outPath?: string;
  /**
   * Test seam — overrides the Swift helper + sharp auto-detection. When
   * provided, `encodeWebP` calls `bridge.encodeWebP(...)` exclusively.
   */
  bridge?: WebPEncoderBridge;
}

/**
 * Minimal structural contract for the encoder path. The production bridge
 * is lazily constructed from `VisionBridge` + `sharp`; tests pass a stub.
 */
export interface WebPEncoderBridge {
  encodeWebP(opts: {
    inPath: string;
    outPath: string;
    quality: number;
    maxWidth: number;
  }): Promise<void>;
}

export interface WebPEncodeResult {
  /** Absolute path to the encoded .webp. */
  outPath: string;
  /** Size of the encoded file in bytes. */
  bytes: number;
}

/** Policy defaults — tweak here or via options, never inline elsewhere. */
export const WEBP_DEFAULTS = {
  QUALITY: 75,
  MAX_WIDTH: 1280,
  HELPER_TIMEOUT_MS: 10_000,
} as const;

/**
 * Encode a PNG to a WebP beside it (or at `outPath`), at the given quality
 * and max width. Returns the output path + byte count.
 *
 * Contract: never throws on a successful encode — all failures wrap in
 * `WebPEncodeError` with the original cause attached.
 */
export async function encodeWebP(
  pngPath: string,
  opts: WebPEncodeOptions = {},
): Promise<WebPEncodeResult> {
  const quality = opts.quality ?? WEBP_DEFAULTS.QUALITY;
  if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
    throw new WebPEncodeError(
      `quality must be an integer in [0, 100], got ${quality}`,
    );
  }
  const maxWidth = opts.maxWidth ?? WEBP_DEFAULTS.MAX_WIDTH;
  if (!Number.isInteger(maxWidth) || maxWidth <= 0) {
    throw new WebPEncodeError(
      `maxWidth must be a positive integer, got ${maxWidth}`,
    );
  }

  const outPath = opts.outPath ?? deriveOutPath(pngPath);
  const bridge = opts.bridge ?? (await createDefaultBridge());

  try {
    await bridge.encodeWebP({ inPath: pngPath, outPath, quality, maxWidth });
  } catch (err) {
    if (err instanceof WebPEncodeError) throw err;
    throw new WebPEncodeError(
      `webp encode failed for ${pngPath}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  let bytes: number;
  try {
    bytes = (await stat(outPath)).size;
  } catch (err) {
    throw new WebPEncodeError(
      `webp encode produced no output at ${outPath}`,
      err,
    );
  }

  return { outPath, bytes };
}

// ─── Default bridge (Swift helper → sharp fallback) ─────────────────────────

async function createDefaultBridge(): Promise<WebPEncoderBridge> {
  const helper = await trySwiftBridge();
  if (helper) return helper;

  const sharpBridge = await trySharpBridge();
  if (sharpBridge) return sharpBridge;

  throw new WebPEncodeError(
    "no encoder available: cortexos-vision helper missing and 'sharp' not installed",
  );
}

async function trySwiftBridge(): Promise<WebPEncoderBridge | null> {
  // We treat binary existence as "usable"; stderr surfaces at call time.
  const binary = defaultBinaryPath();
  const { access } = await import("node:fs/promises");
  try {
    await access(binary);
  } catch {
    return null;
  }
  return {
    async encodeWebP({ inPath, outPath, quality, maxWidth }): Promise<void> {
      await runHelper(
        binary,
        [
          "encode-webp",
          "--in",
          inPath,
          "--out",
          outPath,
          "--quality",
          String(quality),
          "--max-width",
          String(maxWidth),
        ],
        WEBP_DEFAULTS.HELPER_TIMEOUT_MS,
      );
    },
  };
}

async function trySharpBridge(): Promise<WebPEncoderBridge | null> {
  const mod = (await import("sharp").catch(() => null)) as
    | { default: SharpFactory }
    | null;
  if (!mod) return null;
  const sharp = mod.default;
  return {
    async encodeWebP({ inPath, outPath, quality, maxWidth }): Promise<void> {
      await sharp(inPath)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .webp({ quality })
        .toFile(outPath);
    },
  };
}

function runHelper(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, encoding: "utf8" },
      (err, _stdout, stderr) => {
        if (err) {
          reject(
            new WebPEncodeError(
              `cortexos-vision encode-webp failed: ${err.message}`,
              (stderr ?? "").trim(),
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Public helper — reused by screen-capture.ts. Accepts an already-probed
 * bridge (avoids re-checking binary availability on every frame).
 */
export function buildEncoderFromVisionBridge(
  bridge: Pick<VisionBridge, "isAvailable">,
): WebPEncoderBridge {
  const binary = defaultBinaryPath();
  let available: boolean | null = null;
  return {
    async encodeWebP(opts) {
      if (available === null) available = await bridge.isAvailable();
      if (!available) {
        throw new WebPEncodeError(
          "cortexos-vision helper not available — build via scripts/native/build-vision.sh",
        );
      }
      await runHelper(
        binary,
        [
          "encode-webp",
          "--in",
          opts.inPath,
          "--out",
          opts.outPath,
          "--quality",
          String(opts.quality),
          "--max-width",
          String(opts.maxWidth),
        ],
        WEBP_DEFAULTS.HELPER_TIMEOUT_MS,
      );
    },
  };
}

function deriveOutPath(pngPath: string): string {
  if (pngPath.toLowerCase().endsWith(".png")) {
    return `${pngPath.slice(0, -4)}.webp`;
  }
  return join(dirname(pngPath), `${randomUUID()}.webp`);
}

// ─── Internal types (structural, avoid depending on sharp's .d.ts) ──────────

interface SharpInstance {
  resize(opts: { width: number; withoutEnlargement?: boolean }): SharpInstance;
  webp(opts: { quality: number }): SharpInstance;
  toFile(path: string): Promise<unknown>;
}
type SharpFactory = (input: string) => SharpInstance;
