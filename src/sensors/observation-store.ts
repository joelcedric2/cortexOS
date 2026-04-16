/**
 * SQLite-backed observation store for sensor samples (plan §5.7).
 *
 * Stores sensor observations with retention management, suppression,
 * and pending-surface queries. Prepared statements only.
 */
import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SensorSample } from "./sensor.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor_name TEXT NOT NULL,
  observation TEXT NOT NULL,
  urgency REAL NOT NULL,
  data_json TEXT,
  sampled_at TEXT NOT NULL,
  acted_on INTEGER NOT NULL DEFAULT 0,
  suppressed_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_obs_sensor ON observations(sensor_name);
CREATE INDEX IF NOT EXISTS idx_obs_acted ON observations(acted_on);
`;

// ─── Row type ────────────────────────────────────────────────────────────────

export interface ObservationRow {
  id: number;
  sensor_name: string;
  observation: string;
  urgency: number;
  data_json: string | null;
  sampled_at: string;
  acted_on: number;
  suppressed_until: string | null;
}

// ─── Class ───────────────────────────────────────────────────────────────────

export class ObservationStore {
  private readonly db: DB;

  private readonly stmtInsert;
  private readonly stmtPending;
  private readonly stmtMarkActedOn;
  private readonly stmtSuppress;
  private readonly stmtSuppressByType;
  private readonly stmtCleanup;

  constructor(opts?: { dbPath?: string }) {
    const dbPath = opts?.dbPath ?? defaultDbPath();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);

    this.stmtInsert = this.db.prepare(`
      INSERT INTO observations
        (sensor_name, observation, urgency, data_json, sampled_at)
      VALUES
        (@sensor_name, @observation, @urgency, @data_json, @sampled_at)
    `);

    this.stmtPending = this.db.prepare(`
      SELECT * FROM observations
      WHERE acted_on = 0
        AND (suppressed_until IS NULL OR suppressed_until < @now)
      ORDER BY urgency DESC, id DESC
      LIMIT @limit
    `);

    this.stmtMarkActedOn = this.db.prepare(`
      UPDATE observations SET acted_on = 1 WHERE id = ?
    `);

    this.stmtSuppress = this.db.prepare(`
      UPDATE observations SET suppressed_until = ? WHERE id = ?
    `);

    this.stmtSuppressByType = this.db.prepare(`
      UPDATE observations
      SET suppressed_until = ?
      WHERE sensor_name = ? AND acted_on = 0
    `);

    this.stmtCleanup = this.db.prepare(`
      DELETE FROM observations
      WHERE sampled_at < ?
    `);
  }

  /** Insert a sensor sample into the store. Returns the new row id. */
  insert(sample: SensorSample): number {
    const info = this.stmtInsert.run({
      sensor_name: sample.sensorName,
      observation: sample.observation,
      urgency: sample.urgency,
      data_json: sample.data ? JSON.stringify(sample.data) : null,
      sampled_at: sample.sampledAt.toISOString(),
    });
    return Number(info.lastInsertRowid);
  }

  /**
   * Return pending observations: not acted on, not suppressed.
   * Ordered by urgency DESC then id DESC.
   */
  pending(limit = 50): ObservationRow[] {
    return this.stmtPending.all({
      now: new Date().toISOString(),
      limit,
    }) as ObservationRow[];
  }

  /** Mark a single observation as acted upon. */
  markActedOn(id: number): void {
    this.stmtMarkActedOn.run(id);
  }

  /** Suppress a single observation until the given date. */
  suppress(id: number, until: Date): void {
    this.stmtSuppress.run(until.toISOString(), id);
  }

  /** Suppress all pending observations from a sensor until the given date. */
  suppressByType(sensorName: string, until: Date): void {
    this.stmtSuppressByType.run(until.toISOString(), sensorName);
  }

  /** Delete observations older than `retentionDays`. */
  cleanup(retentionDays: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const info = this.stmtCleanup.run(cutoff.toISOString());
    return info.changes;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultDbPath(): string {
  const dir = join(homedir(), ".cortexos");
  mkdirSync(dir, { recursive: true });
  return join(dir, "observations.db");
}
