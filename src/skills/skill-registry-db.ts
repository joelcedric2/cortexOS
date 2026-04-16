import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT,
  commit_sha TEXT,
  subpath TEXT,
  installed_at TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'unvetted',
  preferred_for_tags TEXT NOT NULL DEFAULT '[]',
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  quarantined_at TEXT,
  skill_md_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_skills_trust ON skills(trust_level);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
`;

// ─── Types ──────────────────────────────────────────────────────────────────

export type TrustLevel =
  | "unvetted"
  | "user-trusted"
  | "system-trusted"
  | "quarantined";

export interface SkillRow {
  id: string;
  name: string;
  repo_url: string | null;
  commit_sha: string | null;
  subpath: string | null;
  installed_at: string;
  trust_level: TrustLevel;
  preferred_for_tags: string;
  success_count: number;
  fail_count: number;
  quarantined_at: string | null;
  skill_md_path: string | null;
}

export interface SkillInsert {
  id: string;
  name: string;
  repo_url?: string;
  commit_sha?: string;
  subpath?: string;
  trust_level?: TrustLevel;
  preferred_for_tags?: string[];
  skill_md_path?: string;
}

export interface ListOpts {
  trust_level?: TrustLevel;
  limit?: number;
}

// ─── Class ──────────────────────────────────────────────────────────────────

export class SkillRegistryDB {
  private readonly db: DB;

  private readonly stmtInsert;
  private readonly stmtGet;
  private readonly stmtListAll;
  private readonly stmtListByTrust;
  private readonly stmtSetTrust;
  private readonly stmtRecordSuccess;
  private readonly stmtRecordFail;
  private readonly stmtSetQuarantined;
  private readonly stmtDelete;

  constructor(opts?: { dbPath?: string }) {
    const dbPath = opts?.dbPath ?? defaultDbPath();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);

    this.stmtInsert = this.db.prepare(`
      INSERT INTO skills (id, name, repo_url, commit_sha, subpath, installed_at,
                          trust_level, preferred_for_tags, skill_md_path)
      VALUES (@id, @name, @repo_url, @commit_sha, @subpath, @installed_at,
              @trust_level, @preferred_for_tags, @skill_md_path)
    `);

    this.stmtGet = this.db.prepare(`SELECT * FROM skills WHERE id = ?`);

    this.stmtListAll = this.db.prepare(
      `SELECT * FROM skills ORDER BY installed_at DESC LIMIT ?`,
    );

    this.stmtListByTrust = this.db.prepare(
      `SELECT * FROM skills WHERE trust_level = ? ORDER BY installed_at DESC LIMIT ?`,
    );

    this.stmtSetTrust = this.db.prepare(
      `UPDATE skills SET trust_level = ? WHERE id = ?`,
    );

    this.stmtRecordSuccess = this.db.prepare(
      `UPDATE skills SET success_count = success_count + 1 WHERE id = ?`,
    );

    this.stmtRecordFail = this.db.prepare(
      `UPDATE skills SET fail_count = fail_count + 1 WHERE id = ?`,
    );

    this.stmtSetQuarantined = this.db.prepare(
      `UPDATE skills SET trust_level = 'quarantined', quarantined_at = ? WHERE id = ?`,
    );

    this.stmtDelete = this.db.prepare(`DELETE FROM skills WHERE id = ?`);
  }

  insert(skill: SkillInsert): SkillRow {
    const now = new Date().toISOString();
    this.stmtInsert.run({
      id: skill.id,
      name: skill.name,
      repo_url: skill.repo_url ?? null,
      commit_sha: skill.commit_sha ?? null,
      subpath: skill.subpath ?? null,
      installed_at: now,
      trust_level: skill.trust_level ?? "unvetted",
      preferred_for_tags: JSON.stringify(skill.preferred_for_tags ?? []),
      skill_md_path: skill.skill_md_path ?? null,
    });
    return this.get(skill.id)!;
  }

  get(id: string): SkillRow | undefined {
    return this.stmtGet.get(id) as SkillRow | undefined;
  }

  list(opts?: ListOpts): SkillRow[] {
    const limit = opts?.limit ?? 100;
    if (opts?.trust_level) {
      return this.stmtListByTrust.all(opts.trust_level, limit) as SkillRow[];
    }
    return this.stmtListAll.all(limit) as SkillRow[];
  }

  setTrustLevel(id: string, level: TrustLevel): void {
    if (level === "quarantined") {
      this.stmtSetQuarantined.run(new Date().toISOString(), id);
      return;
    }
    this.stmtSetTrust.run(level, id);
  }

  recordRun(id: string, outcome: "success" | "fail"): void {
    if (outcome === "success") {
      this.stmtRecordSuccess.run(id);
    } else {
      this.stmtRecordFail.run(id);
    }
  }

  /**
   * Promote a skill to system-trusted if it has >= threshold successful runs
   * and its current trust_level is user-trusted.
   * Returns true if promotion happened.
   */
  promoteToSystemTrusted(id: string, threshold = 20): boolean {
    const row = this.get(id);
    if (!row) return false;
    if (row.trust_level !== "user-trusted") return false;
    if (row.success_count < threshold) return false;
    this.setTrustLevel(id, "system-trusted");
    return true;
  }

  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
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
