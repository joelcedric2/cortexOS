/**
 * SQLite tables for the Social Operator Layer (§5.4.5 safety rails).
 *
 * `social_contacts` — tracks first-send status per (platform, target).
 * `social_actions`  — audit log of every send attempt with rate-limit
 *                     enforcement (max 20 DMs/platform/hour).
 *
 * Lives in the shared `~/.cortexos/registry.db` alongside escalations,
 * agents, cron_jobs, etc.
 */
import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS social_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  target TEXT NOT NULL,
  first_sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, target)
);
CREATE INDEX IF NOT EXISTS idx_social_contacts_pt
  ON social_contacts(platform, target);

CREATE TABLE IF NOT EXISTS social_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  target TEXT NOT NULL,
  message TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  outcome TEXT NOT NULL,
  driver_version TEXT NOT NULL DEFAULT '0.1.0'
);
CREATE INDEX IF NOT EXISTS idx_social_actions_platform_time
  ON social_actions(platform, sent_at);
`;

export interface SocialActionRow {
  id: number;
  platform: string;
  target: string;
  message: string;
  sent_at: string;
  outcome: string;
  driver_version: string;
}

export class SocialDB {
  private readonly db: DB;

  constructor(dbPath?: string) {
    const resolved =
      dbPath ?? join(homedir(), ".cortexos", "registry.db");
    mkdirSync(join(resolved, ".."), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /* ------------------------------------------------------------------ */
  /*  Contacts — first-send tracking                                     */
  /* ------------------------------------------------------------------ */

  /** Returns true if we have previously sent to (platform, target). */
  isKnownContact(platform: string, target: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM social_contacts WHERE platform = ? AND target = ?")
      .get(platform, target);
    return row !== undefined;
  }

  /** Record a new contact after the first confirmed send. */
  recordContact(platform: string, target: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO social_contacts (platform, target) VALUES (?, ?)",
      )
      .run(platform, target);
  }

  /* ------------------------------------------------------------------ */
  /*  Actions — audit log + rate limiting                                */
  /* ------------------------------------------------------------------ */

  /** Log a send attempt. */
  logAction(
    platform: string,
    target: string,
    message: string,
    outcome: string,
    driverVersion?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO social_actions (platform, target, message, outcome, driver_version)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(platform, target, message, outcome, driverVersion ?? "0.1.0");
  }

  /**
   * Count sends on a platform within the last `windowMs` milliseconds.
   * Default window: 1 hour (3_600_000 ms).
   */
  countRecentActions(platform: string, windowMs = 3_600_000): number {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM social_actions WHERE platform = ? AND sent_at >= ?",
      )
      .get(platform, cutoff) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /** Tear down — close the underlying SQLite handle. */
  close(): void {
    this.db.close();
  }
}
