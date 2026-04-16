/**
 * Phase 8 — Apple Vision OCR wrapper.
 *
 * Thin functional facade over the native cortexos-vision helper. The Swift
 * binary runs `VNRecognizeTextRequest` locally; nothing leaves the machine.
 * Callers that want batching / caching should layer it on top — this module
 * stays stateless so it's cheap to call ad-hoc from the brief pipeline and
 * the MCP tool.
 *
 * Failure modes:
 *   - Binary missing / unbuilt → `OCRUnavailableError` (caller decides:
 *     degrade to no-OCR, or fall back to a remote vision call).
 *   - Screen Recording permission not granted, BUT the helper is installed →
 *     also `OCRUnavailableError` (OCR runs on an already-captured PNG so
 *     permission isn't actually required, but we keep the error surface
 *     unified for callers).
 */
import { access } from "node:fs/promises";

import {
  NativeBridgeUnavailableError,
  ScreenPermissionDeniedError,
  createNativeBridge,
  type VisionBridge,
} from "./native-bridge.js";

export interface OcrBlock {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
}

export interface OcrResult {
  /** All detected text joined with newlines. Ready to feed to the brief. */
  text: string;
  blocks: OcrBlock[];
  /** Wall-clock time spent inside Apple Vision. */
  duration_ms: number;
}

/** Thrown when OCR cannot run — binary missing, permission denied, etc. */
export class OCRUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OCRUnavailableError";
  }
}

/** Injection seam for tests. Prod callers omit this and the default is used. */
export interface OcrOptions {
  bridge?: VisionBridge;
  /** Override file-exists check. Tests use a recording fake. */
  fileExists?: (path: string) => Promise<boolean>;
}

/**
 * Run Apple Vision OCR on a PNG file.
 *
 * Throws `OCRUnavailableError` when the helper binary is missing (so the
 * caller can fall through to a remote-vision path if desired). All other
 * failures bubble as regular `Error`.
 */
export async function ocrImage(
  pngPath: string,
  opts: OcrOptions = {},
): Promise<OcrResult> {
  if (!pngPath) {
    throw new Error("ocrImage: pngPath is required");
  }

  const exists = opts.fileExists ?? defaultFileExists;
  if (!(await exists(pngPath))) {
    throw new Error(`ocrImage: file not found at ${pngPath}`);
  }

  const bridge = opts.bridge ?? createNativeBridge();
  try {
    const raw = await bridge.ocr(pngPath);
    return normalize(raw);
  } catch (err) {
    if (err instanceof NativeBridgeUnavailableError) {
      throw new OCRUnavailableError(
        "Apple Vision helper not installed. Run scripts/native/build-vision.sh.",
        err,
      );
    }
    if (err instanceof ScreenPermissionDeniedError) {
      throw new OCRUnavailableError(
        "Apple Vision cannot run (permission denied).",
        err,
      );
    }
    throw err;
  }
}

function normalize(raw: {
  blocks?: Array<{
    text?: string;
    bbox?: { x: number; y: number; w: number; h: number };
    confidence?: number;
  }>;
  text?: string;
  duration_ms?: number;
}): OcrResult {
  const blocks: OcrBlock[] = (raw.blocks ?? []).map((b) => ({
    text: b.text ?? "",
    bbox: b.bbox ?? { x: 0, y: 0, w: 0, h: 0 },
    confidence: typeof b.confidence === "number" ? b.confidence : 0,
  }));
  const text =
    raw.text ??
    blocks
      .map((b) => b.text)
      .filter((t) => t.length > 0)
      .join("\n");
  return {
    text,
    blocks,
    duration_ms: raw.duration_ms ?? 0,
  };
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
