/**
 * Phase 8.5 — 7-day retention downgrader.
 *
 * Scans the `screen_memories` table for rows older than `retentionDays`
 * that still have a `webp_path`, deletes the on-disk WebP file, then
 * nulls the column via `db.dropWebP(id, nowIso)`. The embedding / label /
 * OCR payload survive — only the raw frame is shed. This is the core
 * privacy guarantee of §8.5: "frames don't persist past a week."
 *
 * Nchinda principle (§7.0): retentionDays is a policy-driven default
 * (7), not a hardcoded constant. Every caller can override it. The
 * algorithm never reaches for a magic number.
 */
import { unlink } from "node:fs/promises";

import type { ScreenMemoriesDB } from "./screen-memories-db.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RetentionOptions {
  /** Retention window in days. Default: 7. Caller can override per policy. */
  retentionDays?: number;
  /** Clock override for deterministic tests. */
  now?: () => Date;
  /**
   * When true, only reports what would happen — no fs.unlink, no
   * db.dropWebP. Defaults to false (live mode).
   */
  dryRun?: boolean;
}

export interface RetentionError {
  id: string;
  error: string;
}

export interface RetentionReport {
  /** Rows matched by the cutoff scan (pre-filter). */
  scanned: number;
  /** Rows whose webp_path was successfully nulled. */
  downgraded: number;
  /** Sum of `bytes` reclaimed from downgraded rows. */
  bytesReclaimed: number;
  /** Per-row failures (fs-unlink error, DB error, …). */
  errors: RetentionError[];
  duration_ms: number;
  ts: string;
}

export interface RetentionDeps {
  db: ScreenMemoriesDB;
}

// ─── Policy defaults ─────────────────────────────────────────────────────────

/** Default retention window — policy default, caller can override. */
export const DEFAULT_RETENTION_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Run one retention sweep.
 *
 * Algorithm:
 *   1. cutoff = now() - retentionDays days
 *   2. rows = db.listOlderThan(cutoff)  // only webp_path IS NOT NULL
 *   3. for each row:
 *        - unlink(row.webp_path), swallow ENOENT only
 *        - db.dropWebP(id, nowIso)
 *        - bytesReclaimed += row.bytes
 *      per-row errors are captured, the loop continues
 *   4. return report
 *
 * Re-running immediately after a successful run is a no-op: rows have
 * webp_path=NULL and `listOlderThan` filters them out.
 */
export async function runRetention(
  deps: RetentionDeps,
  opts: RetentionOptions = {},
): Promise<RetentionReport> {
  const clock = opts.now ?? (() => new Date());
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(
      `runRetention: retentionDays must be a non-negative finite number, got ${retentionDays}`,
    );
  }
  const dryRun = opts.dryRun ?? false;

  const startedAt = clock();
  const cutoff = new Date(startedAt.getTime() - retentionDays * MS_PER_DAY);

  const candidates = deps.db.listOlderThan(cutoff);
  const scanned = candidates.length;

  const errors: RetentionError[] = [];
  let downgraded = 0;
  let bytesReclaimed = 0;

  for (const row of candidates) {
    if (!row.webp_path) continue; // belt-and-braces; listOlderThan already filters
    try {
      if (!dryRun) {
        await safeUnlink(row.webp_path);
        deps.db.dropWebP(row.id, startedAt.toISOString());
      }
      downgraded += 1;
      bytesReclaimed += row.bytes;
    } catch (err) {
      errors.push({
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const finishedAt = clock();
  return {
    scanned,
    downgraded,
    bytesReclaimed,
    errors,
    duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    ts: startedAt.toISOString(),
  };
}

/**
 * Delete a file, treating "already gone" as success. Anything else
 * (EACCES, EISDIR, EBUSY, …) propagates up to the retention loop's
 * try/catch where it's captured per-row.
 */
async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return;
    throw err;
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}
