/**
 * Skill usage telemetry ledger (plan §5.5.2).
 *
 * Records every skill run in a SQLite table for usage analytics,
 * failure tracking, and evolution-loop input. Prepared statements only.
 */
import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  skill_version TEXT NOT NULL DEFAULT '1.0.0',
  input_hash TEXT NOT NULL,
  input_category TEXT,
  output_summary TEXT,
  outcome TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  token_cost INTEGER,
  error_msg TEXT,
  error_class TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_skill_runs_name ON skill_runs(skill_name);
CREATE INDEX IF NOT EXISTS idx_skill_runs_outcome ON skill_runs(outcome);
`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SkillRunInput {
  skill_name: string;
  skill_version?: string;
  input_hash: string;
  input_category?: string;
  output_summary?: string;
  outcome: "success" | "fail" | "error" | "timeout";
  latency_ms: number;
  token_cost?: number;
  error_msg?: string;
  error_class?: string;
}

export interface SkillRunRow {
  id: number;
  skill_name: string;
  skill_version: string;
  input_hash: string;
  input_category: string | null;
  output_summary: string | null;
  outcome: string;
  latency_ms: number;
  token_cost: number | null;
  error_msg: string | null;
  error_class: string | null;
  created_at: string;
}

// ─── Class ──────────────────────────────────────────────────────────────────

export class SkillUsageLedger {
  private readonly db: DB;

  private readonly stmtInsert;
  private readonly stmtBySkill;
  private readonly stmtFailures;
  private readonly stmtSuccessRate;

  constructor(opts?: { dbPath?: string }) {
    const dbPath = opts?.dbPath ?? defaultDbPath();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);

    this.stmtInsert = this.db.prepare(`
      INSERT INTO skill_runs
        (skill_name, skill_version, input_hash, input_category,
         output_summary, outcome, latency_ms, token_cost,
         error_msg, error_class, created_at)
      VALUES
        (@skill_name, @skill_version, @input_hash, @input_category,
         @output_summary, @outcome, @latency_ms, @token_cost,
         @error_msg, @error_class, @created_at)
    `);

    this.stmtBySkill = this.db.prepare(`
      SELECT * FROM skill_runs
      WHERE skill_name = ?
      ORDER BY id DESC
      LIMIT ?
    `);

    this.stmtFailures = this.db.prepare(`
      SELECT * FROM skill_runs
      WHERE skill_name = ?
        AND outcome != 'success'
        AND created_at >= ?
      ORDER BY id DESC
    `);

    this.stmtSuccessRate = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes
      FROM skill_runs
      WHERE skill_name = ?
        AND created_at >= ?
    `);
  }

  /** Record a skill run. Returns the inserted row. */
  record(run: SkillRunInput): SkillRunRow {
    const now = new Date().toISOString();
    const info = this.stmtInsert.run({
      skill_name: run.skill_name,
      skill_version: run.skill_version ?? "1.0.0",
      input_hash: run.input_hash,
      input_category: run.input_category ?? null,
      output_summary: run.output_summary ?? null,
      outcome: run.outcome,
      latency_ms: run.latency_ms,
      token_cost: run.token_cost ?? null,
      error_msg: run.error_msg ?? null,
      error_class: run.error_class ?? null,
      created_at: now,
    });
    return {
      id: Number(info.lastInsertRowid),
      skill_name: run.skill_name,
      skill_version: run.skill_version ?? "1.0.0",
      input_hash: run.input_hash,
      input_category: run.input_category ?? null,
      output_summary: run.output_summary ?? null,
      outcome: run.outcome,
      latency_ms: run.latency_ms,
      token_cost: run.token_cost ?? null,
      error_msg: run.error_msg ?? null,
      error_class: run.error_class ?? null,
      created_at: now,
    };
  }

  /** Retrieve runs for a skill, most recent first. */
  bySkill(name: string, limit = 100): SkillRunRow[] {
    return this.stmtBySkill.all(name, limit) as SkillRunRow[];
  }

  /** Retrieve non-success runs within a time window. */
  failuresBySkill(name: string, windowDays = 7): SkillRunRow[] {
    const cutoff = windowCutoff(windowDays);
    return this.stmtFailures.all(name, cutoff) as SkillRunRow[];
  }

  /** Success rate as a number 0..1. Returns 0 if no runs in the window. */
  successRate(name: string, windowDays = 30): number {
    const cutoff = windowCutoff(windowDays);
    const row = this.stmtSuccessRate.get(name, cutoff) as {
      total: number;
      successes: number;
    };
    if (row.total === 0) return 0;
    return row.successes / row.total;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function defaultDbPath(): string {
  const dir = join(homedir(), ".cortexos");
  mkdirSync(dir, { recursive: true });
  return join(dir, "registry.db");
}

function windowCutoff(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}
