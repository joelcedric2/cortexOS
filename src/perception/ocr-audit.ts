/**
 * Phase 8.5 — audited wrapper around {@link ocrImage}.
 *
 * The core `ocrImage` helper in `./ocr.ts` is intentionally locked (Coder 1's
 * Phase 8 shipped it as the canonical Apple Vision facade). Rather than
 * edit it, Phase 8.5 introduces this thin wrapper so callers that want an
 * audit trail for OCR work can opt in without changing the core API.
 *
 * Migration guidance (tracked in docs/phase-8/DECISIONS.md follow-ups):
 *   - Sensor code that runs OCR on every captured frame SHOULD migrate to
 *     `ocrImageAudited` so a user can verify, line-by-line, every PNG the
 *     system has read.
 *   - Ad-hoc tools (e.g. one-off MCP calls) MAY keep calling `ocrImage`
 *     directly — the underlying work is unchanged.
 */

import { ocrImage, type OcrOptions, type OcrResult } from "./ocr.js";
import type { AuditLog } from "../proactivity/audit.js";

export interface OcrAuditedOptions extends OcrOptions {
  audit?: AuditLog;
  /**
   * Override the clock (tests only). Defaults to `() => new Date()`.
   */
  clock?: () => Date;
  /**
   * Label that ends up in the audit `detail` alongside the byte size, so
   * different call sites stay distinguishable. Example: `"sensor.tick"`.
   */
  source?: string;
}

/**
 * Like {@link ocrImage} but also appends one audit line per call when an
 * `AuditLog` is provided. The detail contains:
 *   - bytes   : the size of the OCR'd PNG in bytes
 *   - source  : the caller-provided label (optional)
 *   - outcome : `ok` on success, `error` on failure
 *
 * The underlying OCR error (if any) is re-thrown unchanged — audit is the
 * side-effect, not the error policy.
 */
export async function ocrImageAudited(
  pngPath: string,
  opts: OcrAuditedOptions = {},
): Promise<OcrResult> {
  const { audit, clock, source, ...rest } = opts;
  const now = clock ?? (() => new Date());

  let bytes = -1;
  try {
    bytes = await readSize(pngPath);
  } catch {
    // Size lookup is a nice-to-have — continue even if it fails.
  }

  try {
    const result = await ocrImage(pngPath, rest);
    if (audit) {
      safeAppend(audit, {
        ts: now(),
        detail: buildDetail({
          bytes,
          source,
          outcome: "ok",
          duration_ms: result.duration_ms,
        }),
      });
    }
    return result;
  } catch (err) {
    if (audit) {
      safeAppend(audit, {
        ts: now(),
        detail: buildDetail({ bytes, source, outcome: "error" }),
      });
    }
    throw err;
  }
}

async function readSize(path: string): Promise<number> {
  const { stat } = await import("node:fs/promises");
  const s = await stat(path);
  return s.size;
}

function buildDetail(parts: {
  bytes: number;
  source?: string | undefined;
  outcome: "ok" | "error";
  duration_ms?: number | undefined;
}): string {
  const chunks: string[] = [];
  chunks.push(`bytes=${parts.bytes}`);
  chunks.push(`outcome=${parts.outcome}`);
  if (parts.source) chunks.push(`source=${parts.source}`);
  if (typeof parts.duration_ms === "number") {
    chunks.push(`duration_ms=${Math.round(parts.duration_ms)}`);
  }
  return chunks.join(" ");
}

function safeAppend(
  audit: AuditLog,
  entry: { ts: Date; detail: string },
): void {
  try {
    audit.append({ action: "ocr", detail: entry.detail, ts: entry.ts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ocr-audit] append failed: ${msg}`);
  }
}
