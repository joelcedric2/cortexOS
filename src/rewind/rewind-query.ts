/**
 * Phase 15 — Retroactive "Rewind"-style query.
 *
 * Natural-language search over the `screen_memories` store captured in
 * Phase 8/8.5. Given a user utterance like "what was that article I was
 * reading 40 minutes ago?", we:
 *
 *   1. Embed the query text (injected `EmbedderLike`).
 *   2. Over-fetch `limit × 3` semantic candidates from the DB.
 *   3. Apply optional `timeRange` and `app` filters in-process.
 *   4. Decompress the OCR-text zstd blob for the top-N winners only,
 *      then carve a 300-char excerpt centered on query keywords.
 *   5. Return the top `limit` hits ordered by cosine similarity DESC.
 *
 * Design constraints:
 *   - Bound the work: we NEVER decompress more than `limit × 3` OCR blobs
 *     per query (§Rules in the Phase 15 brief).
 *   - Graceful degradation: if decompression fails (corrupt blob, missing
 *     zstd binary, …) we drop the excerpt but still return the row.
 *   - No silent catches: decompression errors are logged once per call but
 *     don't reject the whole query.
 */
import { zstdDecompressSync } from "node:zlib";
import type {
  ScreenMemoriesDB,
  ScreenMemoryRowWithDistance,
} from "../perception/screen-memories-db.js";

/** Anything that turns a string into an int8-packed embedding Buffer. */
export interface RewindEmbedder {
  /** Returns a `Buffer` whose byte-length matches the DB's embedding column. */
  embed(text: string): Promise<Buffer>;
}

export interface RewindQuery {
  /** Natural-language query. Required; empty/blank strings throw. */
  text: string;
  /** Optional `{from, to}` filter applied post-retrieval. */
  timeRange?: { from: Date; to: Date };
  /** Optional active_app bundle/name filter, case-insensitive exact match. */
  app?: string;
  /** Desired result count. Defaults to 5; clamped to [1, 50]. */
  limit?: number;
}

export interface RewindResult {
  id: string;
  captured_at: string;
  label: string;
  active_app: string | null;
  window_title: string | null;
  /** Cosine similarity from the semantic search (0..1). */
  similarity: number;
  /** Up to 300 chars, centered on the first query keyword found. */
  ocr_excerpt?: string;
  /** Null when retention has downgraded the row to embedding-only. */
  webp_path: string | null;
}

export interface RewindDeps {
  db: ScreenMemoriesDB;
  embedder: RewindEmbedder;
  /**
   * Optional sink for zstd-decompression warnings. Defaults to console.warn.
   * Wired for tests that want silent failure.
   */
  onDecompressError?: (err: unknown, rowId: string) => void;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const OVER_FETCH_MULTIPLIER = 3;
const EXCERPT_LEN = 300;

/** Policy-tunable defaults per §7.0. */
export const REWIND_DEFAULTS = Object.freeze({
  /** Maximum decompressed OCR text per row. 1 MB >> any realistic screen. */
  maxOcrBytes: 1_000_000,
});

const TRUNCATED_MARKER = " [truncated]";

/**
 * Search the screen-memories store with a natural-language query.
 *
 * @throws `Error` when the query text is empty / whitespace-only.
 */
export async function rewindSearch(
  query: RewindQuery,
  deps: RewindDeps,
): Promise<RewindResult[]> {
  const text = typeof query.text === "string" ? query.text.trim() : "";
  if (text.length === 0) {
    throw new Error("rewindSearch: query.text must be a non-empty string");
  }

  const limit = clamp(query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const overFetchK = limit * OVER_FETCH_MULTIPLIER;

  const embedding = await deps.embedder.embed(text);
  const raw = deps.db.semanticSearch(embedding, overFetchK);

  // ── Filters ────────────────────────────────────────────────────────────
  const afterFilter = raw.filter((row) =>
    matchesFilters(row, query.timeRange, query.app),
  );

  // Already sorted DESC by the DB; re-sort defensively.
  afterFilter.sort((a, b) => b.similarity - a.similarity);

  // Bound the decompression work to `limit × 3` at most.
  const decompressBudget = Math.min(afterFilter.length, overFetchK);
  const keywords = extractKeywords(text);

  const warn =
    deps.onDecompressError ??
    ((err, rowId) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[rewindSearch] ocr decompress failed for ${rowId}: ${msg}`,
      );
    });

  const results: RewindResult[] = [];
  for (let i = 0; i < decompressBudget && results.length < limit; i++) {
    const row = afterFilter[i]!;
    const excerpt = safeExcerpt(row, keywords, warn);
    results.push({
      id: row.id,
      captured_at: row.captured_at,
      label: row.label ?? "",
      active_app: row.active_app,
      window_title: row.window_title,
      similarity: row.similarity,
      ...(excerpt !== null ? { ocr_excerpt: excerpt } : {}),
      webp_path: row.webp_path,
    });
  }
  return results;
}

// ────────────────────────── helpers ─────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function matchesFilters(
  row: ScreenMemoryRowWithDistance,
  timeRange: { from: Date; to: Date } | undefined,
  app: string | undefined,
): boolean {
  if (timeRange) {
    const t = Date.parse(row.captured_at);
    if (!Number.isFinite(t)) return false;
    const from = timeRange.from.getTime();
    const to = timeRange.to.getTime();
    // Inclusive on both ends — users saying "40 minutes ago" want the exact
    // boundary hit to count.
    if (t < from || t > to) return false;
  }
  if (app && app.length > 0) {
    const actual = row.active_app ?? "";
    if (actual.toLowerCase() !== app.toLowerCase()) return false;
  }
  return true;
}

/**
 * Extract keywords from the query (alphanumeric words ≥ 3 chars, lowercased,
 * deduplicated, order preserved). Stop-words are filtered out. Used to pick
 * the excerpt anchor; if no keywords match the OCR text, we fall back to a
 * head-of-string excerpt.
 */
function extractKeywords(text: string): string[] {
  const STOP = new Set([
    "the",
    "and",
    "for",
    "was",
    "that",
    "this",
    "with",
    "what",
    "from",
    "were",
    "are",
    "have",
    "has",
    "had",
    "not",
    "but",
    "you",
    "your",
    "about",
    "into",
    "over",
    "any",
    "all",
    "can",
    "did",
    "does",
    "been",
    "ago",
    "minute",
    "minutes",
    "hour",
    "hours",
    "day",
    "days",
    "week",
    "weeks",
    "yesterday",
    "today",
    "morning",
    "afternoon",
    "evening",
    "night",
  ]);
  const out: string[] = [];
  const seen = new Set<string>();
  const tokens = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  for (const tok of tokens) {
    if (STOP.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function safeExcerpt(
  row: ScreenMemoryRowWithDistance,
  keywords: string[],
  warn: (err: unknown, rowId: string) => void,
): string | null {
  if (!row.ocr_text_zstd) return null;
  let full: string;
  try {
    const buf = zstdDecompressSync(row.ocr_text_zstd, {
      maxOutputLength: REWIND_DEFAULTS.maxOcrBytes,
    });
    full = buf.toString("utf8");
    if (buf.byteLength >= REWIND_DEFAULTS.maxOcrBytes) {
      // Blob decompressed to exactly the cap — likely truncated.
      full = full.slice(0, full.length - TRUNCATED_MARKER.length) +
        TRUNCATED_MARKER;
    }
  } catch (err) {
    warn(err, row.id);
    return null;
  }
  return carveExcerpt(full, keywords);
}

/**
 * Carve a ≤300-char excerpt of `text` centered on the first keyword match.
 * Falls back to the first 300 chars when no keyword matches. Whitespace is
 * collapsed to single spaces so the excerpt renders cleanly in voice replies.
 */
export function carveExcerpt(text: string, keywords: string[]): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return "";
  if (clean.length <= EXCERPT_LEN) return clean;

  let anchor = -1;
  for (const kw of keywords) {
    const idx = clean.toLowerCase().indexOf(kw);
    if (idx >= 0) {
      anchor = idx;
      break;
    }
  }
  if (anchor < 0) {
    return clean.slice(0, EXCERPT_LEN);
  }

  const half = Math.floor(EXCERPT_LEN / 2);
  let start = Math.max(0, anchor - half);
  let end = start + EXCERPT_LEN;
  if (end > clean.length) {
    end = clean.length;
    start = Math.max(0, end - EXCERPT_LEN);
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < clean.length ? "…" : "";
  const body = clean.slice(start, end);
  return `${prefix}${body}${suffix}`;
}
