/**
 * Phase 8.5 temporary seam for A1's `ScreenMemoriesDB`.
 *
 * A1 (Coder 1 of Phase 8.5) owns the real SQLite-backed store at
 * `src/perception/screen-memories-db.ts`. Until that lands on our base
 * branch, this file defines the *minimal* structural contract we need so
 * the rate-controller + budget gate can be written and tested standalone.
 *
 * Delete at integration — replace imports with:
 *   import { ScreenMemoriesDB, type ScreenMemoryInput } from "./screen-memories-db.js";
 */

/**
 * Structural subset of A1's `ScreenMemoryInput`. The adaptive-capture path
 * only writes a subset of fields (phash + paths + bytes + metadata); the rest
 * are filled by A1's pipeline (embedding, label, ocr).
 */
export interface ScreenMemoryInput {
  id: string;
  captured_at: Date;
  webp_path: string | null;
  phash: bigint | number;
  active_app: string | null;
  window_title: string | null;
  ocr_text_zstd: Buffer | null;
  label: string | null;
  embedding: Buffer;
  task_id: string | null;
  session_id: string | null;
  bytes?: number;
}

/** Structural row type — we only read `bytes` via `bytesInWindow`. */
export interface ScreenMemoryRow {
  id: string;
  captured_at: string;
  webp_path: string | null;
  phash: bigint;
  bytes: number;
}

/**
 * The budget gate + capture pipeline consume *this* slice only. A1's real
 * class implements this trivially; tests pass an in-memory fake.
 */
export interface ScreenMemoriesStore {
  insert(row: ScreenMemoryInput): ScreenMemoryRow;
  bytesInWindow(since: Date): number;
}
