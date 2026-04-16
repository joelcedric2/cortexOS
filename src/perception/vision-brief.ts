/**
 * Vision-brief builder — turns a `ScreenFrame` into a compact, structured
 * description of what the user is doing right now.
 *
 * Two modes:
 *   - `local-only` (default): heuristics over OCR + active-app/window title.
 *       Never makes a network call. Grep `ANTHROPIC_URL` confirms.
 *   - `llm`: adds a single Claude Haiku vision-capable call to polish the
 *       summary + refine sentiment. Falls back to local-only on any failure
 *       (network, timeout, schema mismatch) so the caller never blocks.
 *
 * Privacy: a frame whose `active_app` is on the private-app deny-list
 * (1Password, banking, disk-encryption UIs, etc.) NEVER triggers an LLM
 * call, regardless of mode. Enforced here + re-enforced in the sensor.
 * Note: Coder 1's capture loop already drops frames for allow-listed bundle
 * ids at capture time; this is the second-line check that runs against the
 * human-readable app name (which the brief works with).
 *
 * No silent catches: all errors during the LLM path are categorized into a
 * redacted label (no raw error text, API keys, URLs) before being surfaced
 * via the returned brief's summary.
 */
import { z } from "zod";
import type { ScreenFrame } from "./screen-capture.js";
import { ocrImage, type OcrResult } from "./ocr.js";
import type { AuditLog } from "../proactivity/audit.js";

// --------------------------- Types ----------------------------------------

export type VisionSentiment =
  | "focused"
  | "idle"
  | "confused"
  | "consuming"
  | "composing";

export interface VisionBriefUiElement {
  role: string;
  label: string;
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface VisionBrief {
  active_app: string | null;
  window_title: string | null;
  /** 1-sentence plain-English "what the user is doing". */
  summary: string;
  /** OCR joined + truncated to 4000 chars. */
  visible_text: string;
  ui_elements?: VisionBriefUiElement[];
  sentiment?: VisionSentiment;
  ts: string;
  source_frame_id: string;
}

export interface VisionBriefOptions {
  mode?: "local-only" | "llm";
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Phase 8.5 — optional audit sink. When provided AND the LLM path fires,
   * one NDJSON line is appended:
   *   {action: 'vision_llm', detail: 'model=haiku outcome=<ok|error>', ts}
   * No-op when omitted, keeping callers that don't care opt-out.
   */
  audit?: AuditLog;
}

export interface VisionBriefDeps {
  ocr?: (pngPath: string) => Promise<OcrResult>;
}

// --------------------------- Constants ------------------------------------

const VISIBLE_TEXT_CAP = 4_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/**
 * Apps (human-readable names) whose frames must never reach an LLM. The
 * Phase 0 privacy policy + Phase 8 VISION §7 are authoritative; this list
 * is the second-line enforcement point at the brief layer (Coder 1's
 * capturer already filters by bundle id at capture time).
 */
export const PRIVATE_APPS: ReadonlySet<string> = new Set([
  "1Password",
  "1Password 7",
  "1Password 8",
  "Bitwarden",
  "Dashlane",
  "KeePassXC",
  "LastPass",
  "Keychain Access",
  "Disk Utility",
  "FileVault",
  "System Preferences",
  "System Settings",
]);

/** Editor apps where recent typing = "composing". */
const EDITOR_APPS: ReadonlySet<string> = new Set([
  "VS Code",
  "Visual Studio Code",
  "Code",
  "Cursor",
  "Sublime Text",
  "Xcode",
  "Vim",
  "Nvim",
  "Neovim",
  "Zed",
  "IntelliJ IDEA",
  "WebStorm",
  "PyCharm",
  "Notion",
  "Obsidian",
  "TextEdit",
  "Notes",
]);

/** Browser apps — when combined with video-host text, that's "consuming". */
const BROWSER_APPS: ReadonlySet<string> = new Set([
  "Safari",
  "Google Chrome",
  "Chrome",
  "Arc",
  "Firefox",
  "Brave Browser",
  "Brave",
  "Microsoft Edge",
]);

const VIDEO_HOST_PATTERNS = [
  /youtube\.com/i,
  /vimeo\.com/i,
  /twitch\.tv/i,
  /netflix\.com/i,
  /hulu\.com/i,
  /\b(now playing|▶\s*play)\b/i,
];

/** Composer-style window-title cues. */
const COMPOSER_TITLE_PATTERNS = [
  /\bdraft\b/i,
  /\bcompose\b/i,
  /\breply\b/i,
  /\bnew message\b/i,
  /\bnew mail\b/i,
];

/**
 * Error-reason redaction (same pattern as haiku-classifier.ts). Never leaks
 * raw error text into the returned summary.
 */
const SAFE_REASON_PATTERNS: ReadonlyArray<{ match: RegExp; label: string }> = [
  { match: /abort|timeout|deadline/i, label: "timeout" },
  { match: /429|rate.?limit/i, label: "rate-limited" },
  { match: /\b(5\d\d)\b/, label: "server-error" },
  { match: /\b(4\d\d)\b/, label: "client-error" },
  { match: /invalid.*json|unexpected token|parse|no json/i, label: "parse-error" },
  {
    match: /schema|zod|invalid response|invalid input|invalid_value|invalid_type/i,
    label: "schema-mismatch",
  },
  { match: /econn|enotfound|network|fetch/i, label: "network" },
  { match: /private.app|deny.list|forbidden/i, label: "privacy-block" },
];

function redactReason(reason: string): string {
  for (const { match, label } of SAFE_REASON_PATTERNS) {
    if (match.test(reason)) return label;
  }
  return "unknown";
}

// --------------------------- LLM-shape ------------------------------------

const LlmBriefSchema = z.object({
  summary: z.string().min(1).max(500),
  sentiment: z.enum(["focused", "idle", "confused", "consuming", "composing"]),
});
type LlmBrief = z.infer<typeof LlmBriefSchema>;

interface AnthropicContentBlock {
  type: string;
  text?: string;
}
interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
}

const SYSTEM_PROMPT =
  "You describe a single macOS screenshot in <=25 words: what is the user " +
  "doing? Also classify sentiment as one of focused|idle|confused|consuming|" +
  "composing. Return JSON only, with keys {summary, sentiment}.";

// --------------------------- Public API -----------------------------------

/** Build a brief from a captured frame. Never throws. */
export async function buildBrief(
  frame: ScreenFrame,
  deps: VisionBriefDeps = {},
  opts: VisionBriefOptions = {},
): Promise<VisionBrief> {
  const mode = opts.mode ?? "local-only";
  const ocrFn = deps.ocr ?? defaultOcrFn;

  const visibleText = await resolveVisibleText(frame, ocrFn);
  const local = buildLocalBrief(frame, visibleText);

  const isPrivate = isPrivateApp(frame.active_app);

  if (mode === "local-only" || isPrivate) {
    return local;
  }

  // llm mode: polish summary + sentiment via Haiku. Fall back to local on any
  // failure. Private apps never reach this path (guarded above).
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!apiKey) {
    return local;
  }

  try {
    const polished = await callHaikuVision(
      frame,
      visibleText,
      apiKey,
      fetchImpl,
      timeoutMs,
    );
    appendVisionLlmAudit(opts.audit, "ok");
    return {
      ...local,
      summary: polished.summary,
      sentiment: polished.sentiment,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendVisionLlmAudit(opts.audit, "error", redactReason(reason));
    return {
      ...local,
      summary: `${local.summary} [llm-fallback: ${redactReason(reason)}]`,
    };
  }
}

/**
 * Append a single audit line for a vision-brief LLM call. No-op when no
 * AuditLog is wired. Never throws — audit is best-effort.
 */
function appendVisionLlmAudit(
  audit: AuditLog | undefined,
  outcome: "ok" | "error",
  errorLabel?: string,
): void {
  if (!audit) return;
  try {
    const parts = [`model=haiku`, `outcome=${outcome}`];
    if (errorLabel) parts.push(`reason=${errorLabel}`);
    audit.append({
      action: "vision_llm",
      detail: parts.join(" "),
      ts: new Date(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[vision-brief] audit append failed: ${msg}`);
  }
}

/** True if this app is on the private-app deny-list. */
export function isPrivateApp(app: string | null | undefined): boolean {
  if (!app) return false;
  return PRIVATE_APPS.has(app);
}

// --------------------------- Local heuristics -----------------------------

function buildLocalBrief(frame: ScreenFrame, visibleText: string): VisionBrief {
  const activeApp = frame.active_app ?? null;
  const windowTitle = frame.window_title ?? null;
  const sentiment = classifySentimentHeuristic(frame, visibleText);
  const shortHeuristic = describeHeuristic(visibleText, sentiment);
  const summary = composeSummary(activeApp, windowTitle, shortHeuristic);

  return {
    active_app: activeApp,
    window_title: windowTitle,
    summary,
    visible_text: visibleText,
    sentiment,
    ts: frame.ts.toISOString(),
    source_frame_id: frame.id,
  };
}

function composeSummary(
  app: string | null,
  title: string | null,
  short: string,
): string {
  const appPart = app ?? "Unknown app";
  const titlePart = title && title.trim() ? title : "(no window title)";
  return `${appPart}: ${titlePart} — ${short}`;
}

/**
 * Pick a sentiment based on the app + title + text. Simple rules that hit
 * the common cases — the LLM path refines the rest.
 */
export function classifySentimentHeuristic(
  frame: ScreenFrame,
  visibleText: string,
): VisionSentiment {
  const app = frame.active_app ?? "";
  const title = frame.window_title ?? "";

  if (!app.trim() && !title.trim() && !visibleText.trim()) return "idle";

  if (isComposerContext(app, title, visibleText)) return "composing";
  if (isConsumerContext(app, title, visibleText)) return "consuming";

  // Non-trivial visible text on an editor surface → composing.
  if (EDITOR_APPS.has(app) && visibleText.trim().length > 40) {
    return "composing";
  }

  // Large blob of OCR text on a browser → consuming.
  if (BROWSER_APPS.has(app) && visibleText.trim().length > 200) {
    return "consuming";
  }

  return "focused";
}

function isComposerContext(
  app: string,
  title: string,
  text: string,
): boolean {
  if (COMPOSER_TITLE_PATTERNS.some((p) => p.test(title))) return true;
  if (/\bmail\b/i.test(app) && /\b(draft|compose|reply)\b/i.test(title)) {
    return true;
  }
  if (EDITOR_APPS.has(app) && /\bunsaved\b|•/i.test(title)) return true;
  // Defensive: obvious "writing a message" OCR signature.
  if (/\b(to:|subject:|cc:)\b/i.test(text) && /\b(draft|compose)\b/i.test(title)) {
    return true;
  }
  return false;
}

function isConsumerContext(app: string, title: string, text: string): boolean {
  if (!BROWSER_APPS.has(app)) return false;
  if (VIDEO_HOST_PATTERNS.some((p) => p.test(title) || p.test(text))) {
    return true;
  }
  return false;
}

function describeHeuristic(
  visibleText: string,
  sentiment: VisionSentiment,
): string {
  if (sentiment === "composing") return "appears to be drafting content";
  if (sentiment === "consuming") return "appears to be watching or reading";
  if (sentiment === "idle") return "no active content detected";
  if (visibleText.trim().length === 0) return "no visible text captured";
  return "working in the foreground window";
}

/**
 * Default OCR fn used when the caller does not inject one. Delegates to the
 * real Apple-Vision helper via {@link ocrImage}; any failure (binary missing,
 * file missing, permission) bubbles up and is swallowed by the caller below,
 * so briefs never fail just because OCR is unavailable.
 */
async function defaultOcrFn(pngPath: string): Promise<OcrResult> {
  return ocrImage(pngPath);
}

async function resolveVisibleText(
  frame: ScreenFrame,
  ocrFn: (pngPath: string) => Promise<OcrResult>,
): Promise<string> {
  // Prefer capturer-provided ocr_text when available (Coder 1 may run
  // Apple Vision in the same process).
  if (frame.ocr_text && frame.ocr_text.length > 0) {
    return truncate(frame.ocr_text, VISIBLE_TEXT_CAP);
  }
  try {
    const r = await ocrFn(frame.png_path);
    return truncate(r.text ?? "", VISIBLE_TEXT_CAP);
  } catch {
    // OCR failures must NOT crash the brief — the heuristics still work
    // from app + title alone.
    return "";
  }
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap);
}

// --------------------------- LLM path -------------------------------------

async function callHaikuVision(
  frame: ScreenFrame,
  visibleText: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<LlmBrief> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const prompt = buildLlmUserContent(frame, visibleText);
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`haiku http ${res.status}`);
    }

    const body = (await res.json()) as AnthropicMessagesResponse;
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    const json = extractJson(text);
    if (!json) throw new Error("no JSON block in haiku response");

    return LlmBriefSchema.parse(JSON.parse(json));
  } finally {
    clearTimeout(timer);
  }
}

function buildLlmUserContent(frame: ScreenFrame, visibleText: string): string {
  const title = frame.window_title ?? "(no title)";
  const app = frame.active_app ?? "(unknown app)";
  const shortText = truncate(visibleText, 2_000);
  return (
    `active_app: ${app}\n` +
    `window_title: ${title}\n` +
    `visible_ocr_text:\n${shortText}`
  );
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}
