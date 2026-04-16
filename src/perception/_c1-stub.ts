/**
 * TEMPORARY stub of Coder 1's contract (`screen-capture.ts` + `ocr.ts`).
 *
 * Phase 8 is split into two parallel lanes:
 *   - Coder 1 owns capture + OCR (ScreenCaptureKit + Apple Vision bridge).
 *   - Coder 2 (this file's author) owns vision-brief + screen_context sensor
 *     + nchinda_see MCP tool.
 *
 * Until Coder 1's branch merges into this branch, the type surface Coder 2
 * needs (`ScreenFrame`, `ScreenCapturer`, `OcrResult`, `ocrImage`) is
 * declared here so Coder 2's tests can inject fakes and the brief compiles.
 *
 * Shapes mirror Coder 1's public types on `phase8/screen-capture` exactly.
 * At integration this file is deleted and the two import lines in
 * vision-brief.ts / screen-context.ts / nchinda-see.ts are re-pointed at
 * `./screen-capture` and `./ocr` directly.
 */

/** A single captured screen frame. */
export interface ScreenFrame {
  /** Stable UUID — used as cross-ref key by the vision-brief / sensor. */
  id: string;
  ts: Date;
  /** Absolute path to the on-disk PNG. Deleted when the frame is evicted. */
  png_path: string;
  active_app: string | null;
  window_title: string | null;
  /** Populated lazily by the brief pipeline (Coder 2's lane). */
  ocr_text?: string;
  width: number;
  height: number;
}

/** Coder 1's capture-loop contract. */
export interface ScreenCapturer {
  captureNow(): Promise<ScreenFrame>;
  getRecent(n?: number): ScreenFrame[];
}

/** OCR result shape from Coder 1's planned `ocrImage()` helper. */
export interface OcrResult {
  text: string;
  blocks: Array<{
    text: string;
    bbox?: { x: number; y: number; w: number; h: number };
    confidence?: number;
  }>;
}

/**
 * Stub OCR. Real impl lives in Coder 1's `./ocr.ts` — shells the Swift
 * helper binary. Tests inject their own. Returns empty text so the local
 * brief still works when no OCR provider is wired.
 */
export async function ocrImageStub(pngPath: string): Promise<OcrResult> {
  void pngPath;
  return { text: "", blocks: [] };
}
