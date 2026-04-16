/**
 * Phase 8.5 — `screen_memories` SQLite wrapper.
 *
 * Owns the `screen_memories` table in the shared `~/.cortexos/registry.db`.
 * Migration is idempotent: we only CREATE IF NOT EXISTS so coexisting tables
 * (agents, skills, …) are untouched.
 *
 * Schema + retention are specified in docs/phase-8/VISION.md §8.5:
 *  - phash is a 64-bit perceptual hash stored as signed INTEGER (SQLite's
 *    native integer column is 8 bytes — room for the full 64 bits).
 *  - webp_path is nulled out after the 7-day retention sweep downgrades
 *    a row from "frames-present" to "embedding-only".
 *
 * Prepared statements only; no string concatenation. bigint arithmetic
 * (popcount for Hamming) is pure TS — we rely on SQLite only for the
 * equality-match fast path, then filter neighbors in-process.
 */
import Database, { type Database as DB, type Statement } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS screen_memories (
  id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  webp_path TEXT,
  phash INTEGER NOT NULL,
  active_app TEXT,
  window_title TEXT,
  ocr_text_zstd BLOB,
  label TEXT,
  embedding BLOB NOT NULL,
  task_id TEXT,
  session_id TEXT,
  bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sm_task ON screen_memories(task_id);
CREATE INDEX IF NOT EXISTS idx_sm_captured ON screen_memories(captured_at);
CREATE INDEX IF NOT EXISTS idx_sm_phash ON screen_memories(phash);
CREATE INDEX IF NOT EXISTS idx_sm_webp_path ON screen_memories(webp_path) WHERE webp_path IS NOT NULL;
`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScreenMemoryInput {
  id: string;
  captured_at: Date;
  webp_path: string | null;
  /**
   * 64-bit perceptual hash. Accepts bigint or number; numbers are coerced
   * to bigint before binding so full 64-bit values round-trip without the
   * 2^53 JS-number truncation.
   */
  phash: bigint | number;
  active_app: string | null;
  window_title: string | null;
  ocr_text_zstd: Buffer | null;
  label: string | null;
  /** Typically a 512-dim int8 CLIP vector packed as a Buffer. */
  embedding: Buffer;
  task_id: string | null;
  session_id: string | null;
  bytes?: number;
}

export interface ScreenMemoryRow {
  id: string;
  captured_at: string;
  webp_path: string | null;
  /** Always bigint — safeIntegers mode preserves the full 64 bits. */
  phash: bigint;
  active_app: string | null;
  window_title: string | null;
  ocr_text_zstd: Buffer | null;
  label: string | null;
  embedding: Buffer;
  task_id: string | null;
  session_id: string | null;
  bytes: number;
}

export interface ScreenMemoryRowWithDistance extends ScreenMemoryRow {
  /** Cosine similarity (0–1, higher = closer). */
  similarity: number;
}

export interface ScreenMemoryRowWithHamming extends ScreenMemoryRow {
  /** Hamming distance (0 = identical, 64 = maximally different). */
  hamming: number;
}

export interface ScreenMemoriesDBOptions {
  /** Override DB path. Defaults to ~/.cortexos/registry.db. */
  dbPath?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_DB_DIR = join(homedir(), ".cortexos");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "registry.db");

function defaultDbPath(): string {
  mkdirSync(DEFAULT_DB_DIR, { recursive: true });
  return DEFAULT_DB_PATH;
}

/**
 * popcount for 64-bit bigint — used by the Hamming filter.
 * Loop is cheap; we only call it per-candidate in byPhash.
 */
function popcount64(x: bigint): number {
  let v = x & 0xffffffffffffffffn;
  let count = 0;
  while (v !== 0n) {
    v &= v - 1n; // clear lowest set bit
    count++;
  }
  return count;
}

/**
 * Signed 64-bit wrap for the phash column. SQLite INTEGER columns are
 * signed 8-byte — values in the unsigned range [2^63, 2^64) must be
 * re-encoded as negative signed bigints for storage, then flipped back
 * on read by the caller if they want unsigned semantics. We store
 * canonical signed bigint here; consumers compare with `==` on signed.
 */
function toSignedInt64(value: bigint | number): bigint {
  const big = typeof value === "bigint" ? value : BigInt(value);
  const TWO_63 = 1n << 63n;
  const TWO_64 = 1n << 64n;
  if (big >= TWO_63 && big < TWO_64) return big - TWO_64;
  if (big < -TWO_63 || big >= TWO_64) {
    throw new Error(
      `phash out of 64-bit range: ${big.toString()} (must fit signed or unsigned 64)`,
    );
  }
  return big;
}

/**
 * Cosine similarity over two equal-length int8-as-Buffer vectors.
 * Treats bytes as signed int8 (two's complement), per the CLIP int8
 * packing convention used elsewhere in Nchinda.
 */
function cosineInt8(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    // readInt8 is equivalent but loop overhead matters — do the
    // conversion inline.
    const x = a[i]! > 127 ? a[i]! - 256 : a[i]!;
    const y = b[i]! > 127 ? b[i]! - 256 : b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─── Row type as it comes back from better-sqlite3 ──────────────────────────
// (phash is bigint because we flip safeIntegers on for the statements that
// touch it; embedding stays as Buffer; captured_at stays as TEXT ISO-8601.)

interface RawRow {
  id: string;
  captured_at: string;
  webp_path: string | null;
  phash: bigint;
  active_app: string | null;
  window_title: string | null;
  ocr_text_zstd: Buffer | null;
  label: string | null;
  embedding: Buffer;
  task_id: string | null;
  session_id: string | null;
  bytes: bigint | number;
}

function normalizeRow(raw: RawRow): ScreenMemoryRow {
  return {
    id: raw.id,
    captured_at: raw.captured_at,
    webp_path: raw.webp_path,
    phash: raw.phash,
    active_app: raw.active_app,
    window_title: raw.window_title,
    ocr_text_zstd: raw.ocr_text_zstd,
    label: raw.label,
    embedding: raw.embedding,
    task_id: raw.task_id,
    session_id: raw.session_id,
    bytes: typeof raw.bytes === "bigint" ? Number(raw.bytes) : raw.bytes,
  };
}

// ─── Class ───────────────────────────────────────────────────────────────────

export class ScreenMemoriesDB {
  private readonly db: DB;

  private readonly stmtInsert: Statement;
  private readonly stmtGet: Statement;
  private readonly stmtListOlderThan: Statement;
  private readonly stmtListOlderThanLimited: Statement;
  private readonly stmtDropWebP: Statement;
  private readonly stmtByTask: Statement;
  private readonly stmtByPhashExact: Statement;
  private readonly stmtAllWithPhash: Statement;
  private readonly stmtBytesInWindow: Statement;
  private readonly stmtAllForSearch: Statement;

  constructor(opts?: ScreenMemoriesDBOptions) {
    const dbPath = opts?.dbPath ?? defaultDbPath();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // Global safeIntegers for this connection — needed so the 64-bit phash
    // column doesn't silently truncate above 2^53.
    this.db.defaultSafeIntegers(true);
    this.db.exec(SCHEMA);

    this.stmtInsert = this.db.prepare(`
      INSERT INTO screen_memories (
        id, captured_at, webp_path, phash, active_app, window_title,
        ocr_text_zstd, label, embedding, task_id, session_id, bytes
      ) VALUES (
        @id, @captured_at, @webp_path, @phash, @active_app, @window_title,
        @ocr_text_zstd, @label, @embedding, @task_id, @session_id, @bytes
      )
    `);

    this.stmtGet = this.db.prepare(`
      SELECT * FROM screen_memories WHERE id = ?
    `);

    this.stmtListOlderThan = this.db.prepare(`
      SELECT * FROM screen_memories
      WHERE captured_at < @cutoff AND webp_path IS NOT NULL
      ORDER BY captured_at ASC, id ASC
    `);

    this.stmtListOlderThanLimited = this.db.prepare(`
      SELECT * FROM screen_memories
      WHERE captured_at < @cutoff AND webp_path IS NOT NULL
      ORDER BY captured_at ASC, id ASC
      LIMIT @limit
    `);

    this.stmtDropWebP = this.db.prepare(`
      UPDATE screen_memories
      SET webp_path = NULL, bytes = 0
      WHERE id = @id AND webp_path IS NOT NULL
    `);

    this.stmtByTask = this.db.prepare(`
      SELECT * FROM screen_memories
      WHERE task_id = ?
      ORDER BY captured_at ASC, id ASC
    `);

    this.stmtByPhashExact = this.db.prepare(`
      SELECT * FROM screen_memories WHERE phash = @phash
    `);

    // For Hamming neighbor scans we need every phash — embedding/ocr payloads
    // would blow the page cache, so fetch just id+phash then rehydrate the
    // winners with stmtGet.
    this.stmtAllWithPhash = this.db.prepare(`
      SELECT id, phash FROM screen_memories
    `);

    this.stmtBytesInWindow = this.db.prepare(`
      SELECT COALESCE(SUM(bytes), 0) AS total
      FROM screen_memories
      WHERE captured_at >= @since
    `);

    // Linear scan for semantic search — small corpora for now, index
    // optimization in a later pass.
    this.stmtAllForSearch = this.db.prepare(`
      SELECT * FROM screen_memories
    `);
  }

  /**
   * Insert a new screen memory and return the stored row (re-reads to
   * surface the canonical signed-int phash + coerced bytes).
   */
  insert(row: ScreenMemoryInput): ScreenMemoryRow {
    const bytes = row.bytes ?? 0;
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error(`insert: bytes must be a non-negative finite number`);
    }
    this.stmtInsert.run({
      id: row.id,
      captured_at: row.captured_at.toISOString(),
      webp_path: row.webp_path,
      phash: toSignedInt64(row.phash),
      active_app: row.active_app,
      window_title: row.window_title,
      ocr_text_zstd: row.ocr_text_zstd,
      label: row.label,
      embedding: row.embedding,
      task_id: row.task_id,
      session_id: row.session_id,
      bytes,
    });
    const stored = this.get(row.id);
    if (!stored) {
      throw new Error(`insert: row ${row.id} missing after INSERT`);
    }
    return stored;
  }

  /** Get one row by id, or null if absent. */
  get(id: string): ScreenMemoryRow | null {
    const raw = this.stmtGet.get(id) as RawRow | undefined;
    return raw ? normalizeRow(raw) : null;
  }

  /**
   * All rows with `captured_at < cutoff` AND `webp_path IS NOT NULL` —
   * i.e. candidates for the retention downgrade.
   */
  listOlderThan(cutoff: Date, limit?: number): ScreenMemoryRow[] {
    const cutoffIso = cutoff.toISOString();
    const raws = (
      typeof limit === "number"
        ? this.stmtListOlderThanLimited.all({ cutoff: cutoffIso, limit })
        : this.stmtListOlderThan.all({ cutoff: cutoffIso })
    ) as RawRow[];
    return raws.map(normalizeRow);
  }

  /**
   * Null out `webp_path` for one row. No-op if already null (retention
   * idempotency hinges on this). `nowIso` is accepted for symmetry with
   * other downgraders; the column itself doesn't store the drop time.
   */
  dropWebP(id: string, _nowIso: string): void {
    this.stmtDropWebP.run({ id });
  }

  /** All rows attached to a task, ordered chronologically. */
  byTask(task_id: string): ScreenMemoryRow[] {
    const raws = this.stmtByTask.all(task_id) as RawRow[];
    return raws.map(normalizeRow);
  }

  /**
   * Exact phash match + optional Hamming neighbors (hammingMax, inclusive).
   * When hammingMax is undefined, returns only exact hits (cheap fast path).
   * Neighbors are ranked by ascending hamming then captured_at ASC.
   */
  byPhash(phash: bigint, hammingMax?: number): ScreenMemoryRowWithHamming[] {
    const signed = toSignedInt64(phash);
    if (typeof hammingMax !== "number" || hammingMax < 0) {
      const raws = this.stmtByPhashExact.all({ phash: signed }) as RawRow[];
      return raws.map((r) => ({ ...normalizeRow(r), hamming: 0 }));
    }
    // Fetch (id, phash) pairs, filter by hamming, then rehydrate winners.
    const pairs = this.stmtAllWithPhash.all() as Array<{
      id: string;
      phash: bigint;
    }>;
    const hits: Array<{ id: string; hamming: number }> = [];
    for (const p of pairs) {
      const xor = (p.phash ^ signed) & 0xffffffffffffffffn;
      const h = popcount64(xor);
      if (h <= hammingMax) hits.push({ id: p.id, hamming: h });
    }
    hits.sort((a, b) => a.hamming - b.hamming);
    const out: ScreenMemoryRowWithHamming[] = [];
    for (const h of hits) {
      const raw = this.stmtGet.get(h.id) as RawRow | undefined;
      if (raw) out.push({ ...normalizeRow(raw), hamming: h.hamming });
    }
    // Stable-ish secondary ordering by captured_at — JS sort is stable in V8,
    // but we sort once more with a composite key for determinism.
    out.sort((a, b) => {
      if (a.hamming !== b.hamming) return a.hamming - b.hamming;
      return a.captured_at.localeCompare(b.captured_at);
    });
    return out;
  }

  /** Sum of `bytes` for rows with `captured_at >= since`. */
  bytesInWindow(since: Date): number {
    const row = this.stmtBytesInWindow.get({
      since: since.toISOString(),
    }) as { total: bigint | number };
    return typeof row.total === "bigint" ? Number(row.total) : row.total;
  }

  /**
   * Linear cosine scan over embeddings. k defaults to 10. Returns rows
   * sorted by similarity DESC. We intentionally keep this naive — a real
   * ANN index is future work (§8.5 open item).
   */
  semanticSearch(embedding: Buffer, k = 10): ScreenMemoryRowWithDistance[] {
    if (k <= 0) return [];
    const raws = this.stmtAllForSearch.all() as RawRow[];
    const scored: ScreenMemoryRowWithDistance[] = raws.map((r) => ({
      ...normalizeRow(r),
      similarity: cosineInt8(embedding, r.embedding),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }

  /** Close the underlying connection. Idempotent. */
  close(): void {
    if (this.db.open) this.db.close();
  }
}
