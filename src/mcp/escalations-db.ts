/**
 * `escalations` table — Phase 3 / Resourcefulness ladder rung 7.
 *
 * Lives in the shared `~/.cortexos/registry.db` SQLite file alongside
 * `agents`, `loop_attempts`, `cron_jobs`, and `cron_runs`. Agent A (Phase 3
 * coordination tools) owns this table exclusively; the `nchinda_escalate`
 * MCP tool writes here, and the (forthcoming, Phase 5) voice surface reads
 * back pending rows to bubble up to the user.
 *
 * The schema is intentionally minimal: we only need to remember *what* was
 * escalated, at *what* severity, *which* agent/task it came from, and the
 * resolution once the user answers. The full conversation thread is already
 * in the event bus log + vector-store memories.
 */
import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const INLINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  level TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_escalations_resolved ON escalations(resolved);
CREATE INDEX IF NOT EXISTS idx_escalations_task ON escalations(task_id);
`;

/**
 * Severity level of an escalation.
 *   info     — FYI; user may answer at leisure.
 *   question — agent is genuinely blocked awaiting a clarification.
 *   blocker  — system cannot proceed without human input; page the user.
 */
export type EscalationLevel = "info" | "question" | "blocker";

export interface EscalationRow {
  id: string;
  question: string;
  level: EscalationLevel;
  task_id: string | null;
  agent_id: string | null;
  resolved: boolean;
  resolved_by: string | null;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface EscalationInput {
  question: string;
  level?: EscalationLevel;
  task_id?: string | null;
  agent_id?: string | null;
  /** Explicit id override (primarily for tests). Otherwise a uuid is minted. */
  id?: string;
}

export interface ResolveInput {
  resolution: string;
  resolved_by: string;
}

export interface EscalationsDBOptions {
  /** Override DB path. Defaults to ~/.cortexos/registry.db (shared file). */
  dbPath?: string;
}

const DEFAULT_DB_DIR = join(homedir(), ".cortexos");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "registry.db");

interface RawRow {
  id: string;
  question: string;
  level: EscalationLevel;
  task_id: string | null;
  agent_id: string | null;
  resolved: number;
  resolved_by: string | null;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

function toRow(raw: RawRow | undefined): EscalationRow | undefined {
  if (!raw) return undefined;
  return {
    id: raw.id,
    question: raw.question,
    level: raw.level,
    task_id: raw.task_id,
    agent_id: raw.agent_id,
    resolved: raw.resolved === 1,
    resolved_by: raw.resolved_by,
    resolution: raw.resolution,
    created_at: raw.created_at,
    resolved_at: raw.resolved_at,
  };
}

/**
 * SQLite-backed store for user-surfaced escalations.
 *
 * Kept as a thin CRUD wrapper; business logic (when to escalate, who owns
 * a resolution) lives in the `nchinda_escalate` handler and, later, in the
 * voice agent.
 */
export class EscalationsDB {
  private readonly db: DB;

  constructor(options: EscalationsDBOptions = {}) {
    const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Idempotent — safe to call on every init. */
  private migrate(): void {
    this.db.exec(INLINE_SCHEMA);
  }

  /**
   * Insert a new escalation row. Returns the full row as persisted.
   */
  create(input: EscalationInput): EscalationRow {
    const id = input.id ?? `esc_${randomUUID().slice(0, 12)}`;
    const level = input.level ?? "question";
    const stmt = this.db.prepare(
      `INSERT INTO escalations (id, question, level, task_id, agent_id)
       VALUES (@id, @question, @level, @task_id, @agent_id)`,
    );
    stmt.run({
      id,
      question: input.question,
      level,
      task_id: input.task_id ?? null,
      agent_id: input.agent_id ?? null,
    });
    const row = this.getById(id);
    if (!row) {
      throw new Error(`EscalationsDB.create: insert failed for id '${id}'`);
    }
    return row;
  }

  getById(id: string): EscalationRow | undefined {
    const raw = this.db
      .prepare(`SELECT * FROM escalations WHERE id = ?`)
      .get(id) as RawRow | undefined;
    return toRow(raw);
  }

  /** Pending (unresolved) escalations, most recent first. */
  listPending(): EscalationRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM escalations WHERE resolved = 0 ORDER BY created_at DESC`,
      )
      .all() as RawRow[];
    return rows.map((r) => toRow(r)!).filter(Boolean) as EscalationRow[];
  }

  /** All escalations, most recent first. */
  list(): EscalationRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM escalations ORDER BY created_at DESC`)
      .all() as RawRow[];
    return rows.map((r) => toRow(r)!).filter(Boolean) as EscalationRow[];
  }

  /**
   * Mark an escalation resolved. Throws if the id does not exist. Idempotent
   * in the sense that re-resolving overwrites the resolution/resolver — the
   * caller is responsible for not double-resolving if that matters.
   */
  resolve(id: string, input: ResolveInput): EscalationRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`EscalationsDB.resolve: no escalation with id '${id}'`);
    }
    const stmt = this.db.prepare(
      `UPDATE escalations
         SET resolved = 1,
             resolved_by = @resolved_by,
             resolution = @resolution,
             resolved_at = CURRENT_TIMESTAMP
       WHERE id = @id`,
    );
    stmt.run({
      id,
      resolved_by: input.resolved_by,
      resolution: input.resolution,
    });
    const fresh = this.getById(id);
    if (!fresh) {
      throw new Error(`EscalationsDB.resolve: row vanished after update`);
    }
    return fresh;
  }

  close(): void {
    this.db.close();
  }
}
