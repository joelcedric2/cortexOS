/**
 * loop_attempts table — persistent trace of every AutonomyLoop iteration.
 *
 * Lives inside `~/.cortexos/registry.db` alongside the `agents` table that
 * Phase 1 owns. Agent A for Phase 2 owns this table exclusively; do not
 * touch `agents` or any table Agent B (classifier/MCP) adds here.
 */
import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS loop_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  rung INTEGER,
  strategy TEXT,
  error TEXT,
  note TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loop_attempts_task ON loop_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_loop_attempts_state ON loop_attempts(state);
`;

export interface LoopAttemptRow {
  id: number;
  task_id: string;
  attempt: number;
  state: string;
  rung: number | null;
  strategy: string | null;
  error: string | null;
  note: string | null;
  started_at: string;
  ended_at: string;
}

export interface LoopAttemptInput {
  taskId: string;
  attempt: number;
  state: string;
  rung?: number;
  strategy?: string;
  error?: string;
  note?: string;
  startedAt: Date;
  endedAt: Date;
}

export interface LoopAttemptsOptions {
  /** Override DB path. Defaults to `~/.cortexos/registry.db` (shared). */
  dbPath?: string;
}

const DEFAULT_DB_DIR = join(homedir(), ".cortexos");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "registry.db");

/**
 * Thin wrapper around the `loop_attempts` table. Not a full repository —
 * just enough to record transitions and query them back during tests.
 */
export class LoopAttemptLog {
  private readonly db: DB;
  private readonly owned: boolean;

  constructor(options: LoopAttemptsOptions = {}, sharedDb?: DB) {
    if (sharedDb) {
      this.db = sharedDb;
      this.owned = false;
    } else {
      const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
      if (dbPath !== ":memory:") {
        mkdirSync(dirname(dbPath), { recursive: true });
      }
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.owned = true;
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(MIGRATION);
  }

  record(input: LoopAttemptInput): LoopAttemptRow {
    const stmt = this.db.prepare(
      `INSERT INTO loop_attempts
         (task_id, attempt, state, rung, strategy, error, note, started_at, ended_at)
       VALUES (@task_id, @attempt, @state, @rung, @strategy, @error, @note, @started_at, @ended_at)`,
    );
    const info = stmt.run({
      task_id: input.taskId,
      attempt: input.attempt,
      state: input.state,
      rung: input.rung ?? null,
      strategy: input.strategy ?? null,
      error: input.error ?? null,
      note: input.note ?? null,
      started_at: input.startedAt.toISOString(),
      ended_at: input.endedAt.toISOString(),
    });
    const row = this.db
      .prepare(`SELECT * FROM loop_attempts WHERE id = ?`)
      .get(info.lastInsertRowid) as LoopAttemptRow;
    return row;
  }

  byTask(taskId: string): LoopAttemptRow[] {
    return this.db
      .prepare(`SELECT * FROM loop_attempts WHERE task_id = ? ORDER BY id ASC`)
      .all(taskId) as LoopAttemptRow[];
  }

  /** Close the DB if we opened it ourselves. No-op when sharing. */
  close(): void {
    if (this.owned) this.db.close();
  }
}
