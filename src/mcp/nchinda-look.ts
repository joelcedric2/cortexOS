/**
 * Phase 9 — `nchinda_look()` MCP tool.
 *
 * Answers "what am I looking at?" questions by capturing a fresh camera
 * frame, running Apple Vision OCR, and asking Claude Sonnet 4.6 to
 * describe the scene. Returns a short paragraph plus any OCR'd text so
 * downstream voice / chat callers can speak or render the reply.
 *
 * Fallback policy:
 *   - capture fails → error propagates (typed via CameraCaptureError so
 *     the caller can distinguish permission / device / unknown causes).
 *   - OCR fails → we continue with empty OCR text.
 *   - Sonnet call fails → we degrade to a local-only description built
 *     from the OCR text (the privacy-friendly path). This matches the
 *     vision-brief pipeline's `mode=local-only` shape and keeps the
 *     tool useful when offline / unauthenticated.
 *
 * Privacy:
 *   - The ONLY data leaving the machine is the JPEG + OCR text + user
 *     question, and only when an ANTHROPIC_API_KEY is present and the
 *     `fetchImpl` succeeds.
 *   - Camera permission must already be granted; we never silently
 *     re-prompt.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";

import {
  captureCameraFrame,
  CameraCaptureError,
  type CameraDevice,
  type CameraFrame,
} from "../perception/camera-capture.js";
import { ocrImage, OCRUnavailableError } from "../perception/ocr.js";

// ─── Schema ────────────────────────────────────────────────────────────────

export const NchindaLookInputSchema = z.object({
  question: z.string().min(1).max(2000).optional(),
  device: z.enum(["front", "back", "continuity"]).optional(),
});

export type NchindaLookInput = z.infer<typeof NchindaLookInputSchema>;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface NchindaLookResult {
  description: string;
  ocr_text?: string;
  frame: { id: string; path: string; ts: string };
}

export interface NchindaLookDeps {
  /** Test seam — production calls default to {@link captureCameraFrame}. */
  capture?: typeof captureCameraFrame;
  /**
   * OCR override. Production callers omit. The default reads the JPEG
   * off disk and runs Apple Vision. Accepts any PNG / JPEG path.
   */
  ocr?: (imagePath: string) => Promise<{ text: string }>;
  /** Override `fetch` for Sonnet calls. Defaults to the global. */
  haikuFetch?: typeof fetch;
  /** ANTHROPIC_API_KEY override. Defaults to process.env. */
  apiKey?: string;
  /** Timeout for the Sonnet round-trip. Default 10s per spec. */
  timeoutMs?: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * Sonnet 4.6 handles image understanding. Using the Sonnet tier (not
 * Haiku) because "what is this" questions benefit from detailed visual
 * reasoning — the screen-perception brief path stays on Haiku since
 * it's polling-heavy and text-centric.
 */
const SONNET_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OCR_CHARS = 2_000;

const SYSTEM_PROMPT =
  "You are Nchinda's camera describing what the user's camera sees. " +
  "Keep the reply to one short paragraph (2-4 sentences). Start with " +
  "the most salient object or person. If a question is supplied, " +
  "answer it directly using the image. If OCR text is supplied, treat " +
  "it as hints but trust the image. Never mention that you are an AI.";

// ─── Redaction (shared pattern with haiku-classifier) ──────────────────────

const SAFE_REASON_PATTERNS: ReadonlyArray<{ match: RegExp; label: string }> = [
  { match: /abort|timeout|deadline/i, label: "timeout" },
  { match: /429|rate.?limit/i, label: "rate-limited" },
  { match: /\b(5\d\d)\b/, label: "server-error" },
  { match: /\b(4\d\d)\b/, label: "client-error" },
  { match: /invalid.*json|unexpected token|parse/i, label: "parse-error" },
  { match: /schema|zod/i, label: "schema-mismatch" },
  { match: /econn|enotfound|network|fetch/i, label: "network" },
  { match: /no.?api.?key|unauthori[sz]ed/i, label: "no-api-key" },
];

function redactReason(msg: string): string {
  for (const { match, label } of SAFE_REASON_PATTERNS) {
    if (match.test(msg)) return label;
  }
  return "unknown";
}

// ─── Anthropic response shape (minimal) ────────────────────────────────────

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

// ─── Entry point ───────────────────────────────────────────────────────────

export async function nchindaLook(
  input: unknown,
  deps: NchindaLookDeps = {},
): Promise<NchindaLookResult> {
  const parsed = NchindaLookInputSchema.parse(input ?? {});
  const device: CameraDevice | undefined = parsed.device;
  const question = parsed.question?.trim();

  const captureFn = deps.capture ?? captureCameraFrame;
  const frame = await captureFn({ device });

  const ocrText = await runOcrSafely(frame, deps.ocr);
  const description = await describeWithSonnet(frame, ocrText, question, deps);

  return {
    description,
    ocr_text: ocrText.length > 0 ? truncate(ocrText, MAX_OCR_CHARS) : undefined,
    frame: {
      id: frame.id,
      path: frame.jpeg_path,
      ts: frame.ts.toISOString(),
    },
  };
}

// ─── OCR ───────────────────────────────────────────────────────────────────

async function runOcrSafely(
  frame: CameraFrame,
  ocrOverride?: (path: string) => Promise<{ text: string }>,
): Promise<string> {
  try {
    if (ocrOverride) {
      const r = await ocrOverride(frame.jpeg_path);
      return typeof r.text === "string" ? r.text : "";
    }
    const r = await ocrImage(frame.jpeg_path);
    return r.text ?? "";
  } catch (err) {
    if (err instanceof OCRUnavailableError) return "";
    // Any other OCR failure — return empty. We do NOT let OCR gate the
    // caller's ability to get a description.
    return "";
  }
}

// ─── Sonnet description path ───────────────────────────────────────────────

async function describeWithSonnet(
  frame: CameraFrame,
  ocrText: string,
  question: string | undefined,
  deps: NchindaLookDeps,
): Promise<string> {
  const apiKey = deps.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const fetchImpl = deps.haikuFetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!apiKey) {
    return localFallback(ocrText, question, "no-api-key");
  }

  let jpegBase64: string;
  try {
    const buf = await readFile(frame.jpeg_path);
    jpegBase64 = buf.toString("base64");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return localFallback(ocrText, question, `read-failed:${redactReason(msg)}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const userContent = buildUserContent(question, ocrText, jpegBase64);
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 350,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!res.ok) {
      return localFallback(ocrText, question, `http-${res.status}`);
    }
    const body = (await res.json()) as AnthropicMessagesResponse;
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    const trimmed = text.trim();
    if (!trimmed) {
      return localFallback(ocrText, question, "empty-response");
    }
    return trimmed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return localFallback(ocrText, question, redactReason(msg));
  } finally {
    clearTimeout(timer);
  }
}

function buildUserContent(
  question: string | undefined,
  ocrText: string,
  jpegBase64: string,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: jpegBase64,
      },
    },
  ];
  const parts: string[] = [];
  if (question && question.length > 0) parts.push(`Question: ${question}`);
  if (ocrText.length > 0) {
    parts.push(`OCR text from the frame:\n${truncate(ocrText, MAX_OCR_CHARS)}`);
  }
  if (parts.length === 0) {
    parts.push("Describe what the camera sees.");
  }
  blocks.push({ type: "text", text: parts.join("\n\n") });
  return blocks;
}

// ─── Local-only fallback ───────────────────────────────────────────────────

function localFallback(
  ocrText: string,
  question: string | undefined,
  reason: string,
): string {
  const q = question ? ` ${question}` : "";
  if (ocrText.trim().length > 0) {
    const snippet = truncate(ocrText.trim(), 400);
    return (
      `Local-only reply (${reason}).${q} ` +
      `The camera sees text that reads: ${snippet}`
    ).trim();
  }
  return (
    `Local-only reply (${reason}). ` +
    `The vision model is unavailable and OCR found no text on the frame.`
  ).trim();
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap);
}

// Re-export the error type so MCP dispatch can catch it without importing
// from the perception module directly.
export { CameraCaptureError };
