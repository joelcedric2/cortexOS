/**
 * cron_jobs + cron_runs tables — persistent scheduler storage.
 *
 * Lives inside `~/.cortexos/registry.db` alongside `agents` (Phase 1) and
 * `loop_attempts` (Phase 2). Agent A for Phase 1.5 owns these tables
 * exclusively; Agent B (NL parser / defaults / API) only reads via the CRUD
 * surface exported here.
 *
 * Schema is defined in `src/scheduler/cron-jobs.schema.sql` and inlined here
 * as the runtime fallback so a build artifact missing the sidecar file still
 * initializes correctly (same pattern as `src/registry/agent-registry.ts`).
 */
import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const INLINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  task TEXT NOT NULL,
  role_hint TEXT,
  depth TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  last_run TEXT,
  next_run TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run);

CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  summary TEXT,
  FOREIGN KEY (job_id) REFERENCES cron_jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_cron_runs_run_at ON cron_runs(run_at);
`;

/** Who/what created a cron job. Mirrors §5.6.2 `created_by`. */
export type CronCreator =
  | "user"
  | "nchinda_proactive"
  | "skill_install"
  | "onboarding";

/** Spawn depth hint forwarded to the Autonomy Loop when firing. */
export type CronDepth = "single-shot" | "multi-agent";

/** Terminal outcome for a single run of a cron job. */
export type CronOutcome = "success" | "fail" | "escalated";

/** Persistent shape of a row in `cron_jobs`. */
export interface CronJob {
  id: string;
  name: string;
  cron_expr: string;
  task: string;
  role_hint: string | null;
  depth: CronDepth | null;
  enabled: boolean;
  timezone: string;
  last_run: string | null;
  next_run: string | null;
  created_by: CronCreator;
  created_at: string;
}

/** Insert shape. `id`, `name`, `cron_expr`, `task`, `created_by` required. */
export interface CronJobInput {
  id: string;
  name: string;
  cron_expr: string;
  task: string;
  role_hint?: string | null;
  depth?: CronDepth | null;
  enabled?: boolean;
  timezone?: string;
  next_run?: Date | null;
  created_by: CronCreator;
}

/** Fields that may be mutated after creation. */
export interface CronJobUpdate {
  name?: string;
  cron_expr?: string;
  task?: string;
  role_hint?: string | null;
  depth?: CronDepth | null;
  enabled?: boolean;
  timezone?: string;
  next_run?: Date | null;
}

/** Persistent shape of a row in `cron_runs`. */
export interface CronRun {
  id: number;
  job_id: string;
  run_at: string;
  outcome: CronOutcome;
  duration_ms: number;
  summary: string | null;
}

export interface CronJobsDBOptions {
  /** Override DB path (primarily for tests). Defaults to `~/.cortexos/registry.db`. */
  dbPath?: string;
}

const DEFAULT_DB_DIR = join(homedir(), ".cortexos");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "registry.db");

interface CronJobRow {
  id: string;
  name: string;
  cron_expr: string;
  task: string;
  role_hint: string | null;
  depth: string | null;
  enabled: number;
  timezone: string;
  last_run: string | null;
  next_run: string | null;
  created_by: string;
  created_at: string;
}

function rowToJob(row: CronJobRow): CronJob {
  return {
    id: row.id,
    name: row.name,
    cron_expr: row.cron_expr,
    task: row.task,
    role_hint: row.role_hint,
    depth: (row.depth as CronDepth | null) ?? null,
    enabled: row.enabled === 1,
    timezone: row.timezone,
    last_run: row.last_run,
    next_run: row.next_run,
    created_by: row.created_by as CronCreator,
    created_at: row.created_at,
  };
}

/**
 * SQLite-backed store of cron jobs + their run history.
 *
 * CRUD surface + a `listDue(now)` helper the `Scheduler` polls on every tick.
 * All timestamps are stored as ISO-8601 UTC strings; comparisons happen in
 * string-space because ISO-8601 sorts lexicographically.
 */
export class CronJobsDB {
  private readonly db: DB;
  private readonly owned: boolean;

  constructor(options: CronJobsDBOptions = {}, sharedDb?: DB) {
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
      this.db.pragma("foreign_keys = ON");
      this.owned = true;
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(INLINE_SCHEMA);
  }

  /** Insert a new cron job. Throws on duplicate id. */
  create(input: CronJobInput): CronJob {
    const stmt = this.db.prepare(
      `INSERT INTO cron_jobs
         (id, name, cron_expr, task, role_hint, depth, enabled, timezone, next_run, created_by)
       VALUES
         (@id, @name, @cron_expr, @task, @role_hint, @depth, @enabled, @timezone, @next_run, @created_by)`,
    );
    stmt.run({
      id: input.id,
      name: input.name,
      cron_expr: input.cron_expr,
      task: input.task,
      role_hint: input.role_hint ?? null,
      depth: input.depth ?? null,
      enabled: input.enabled ? 1 : 0,
      timezone: input.timezone ?? "America/New_York",
      next_run: input.next_run ? input.next_run.toISOString() : null,
      created_by: input.created_by,
    });
    const row = this.getById(input.id);
    if (!row) {
      throw new Error(`CronJobsDB.create: insert failed for job ${input.id}`);
    }
    return row;
  }

  /** Fetch a job by id, or `undefined` if missing. */
  getById(id: string): CronJob | undefined {
    const row = this.db
      .prepare(`SELECT * FROM cron_jobs WHERE id = ?`)
      .get(id) as CronJobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  /** Return all jobs ordered by creation time ascending. */
  list(): CronJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM cron_jobs ORDER BY created_at ASC, id ASC`)
      .all() as CronJobRow[];
    return rows.map(rowToJob);
  }

  /**
   * Jobs due to fire at or before `now`: enabled AND (next_run IS NOT NULL
   * AND next_run <= now). Jobs with a null `next_run` are considered "not
   * scheduled yet" and are skipped — the caller is expected to compute and
   * persist `next_run` via `update()` on create.
   */
  listDue(now: Date): CronJob[] {
    const nowIso = now.toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM cron_jobs
         WHERE enabled = 1
           AND next_run IS NOT NULL
           AND next_run <= ?
         ORDER BY next_run ASC, id ASC`,
      )
      .all(nowIso) as CronJobRow[];
    return rows.map(rowToJob);
  }

  /** Patch-style update. Omitted fields are left alone. Throws if id missing. */
  update(id: string, patch: CronJobUpdate): CronJob {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (patch.name !== undefined) {
      sets.push("name = @name");
      params.name = patch.name;
    }
    if (patch.cron_expr !== undefined) {
      sets.push("cron_expr = @cron_expr");
      params.cron_expr = patch.cron_expr;
    }
    if (patch.task !== undefined) {
      sets.push("task = @task");
      params.task = patch.task;
    }
    if (patch.role_hint !== undefined) {
      sets.push("role_hint = @role_hint");
      params.role_hint = patch.role_hint;
    }
    if (patch.depth !== undefined) {
      sets.push("depth = @depth");
      params.depth = patch.depth;
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = @enabled");
      params.enabled = patch.enabled ? 1 : 0;
    }
    if (patch.timezone !== undefined) {
      sets.push("timezone = @timezone");
      params.timezone = patch.timezone;
    }
    if (patch.next_run !== undefined) {
      sets.push("next_run = @next_run");
      params.next_run = patch.next_run ? patch.next_run.toISOString() : null;
    }

    if (sets.length === 0) {
      const existing = this.getById(id);
      if (!existing) {
        throw new Error(`CronJobsDB.update: no job with id '${id}'`);
      }
      return existing;
    }

    const info = this.db
      .prepare(`UPDATE cron_jobs SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
    if (info.changes === 0) {
      throw new Error(`CronJobsDB.update: no job with id '${id}'`);
    }
    const row = this.getById(id);
    if (!row) {
      throw new Error(`CronJobsDB.update: row vanished after update for '${id}'`);
    }
    return row;
  }

  /** Delete a job. Also deletes its run history (FK cascade is manual here). */
  delete(id: string): void {
    const tx = this.db.transaction((jobId: string) => {
      this.db.prepare(`DELETE FROM cron_runs WHERE job_id = ?`).run(jobId);
      const info = this.db.prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(jobId);
      if (info.changes === 0) {
        throw new Error(`CronJobsDB.delete: no job with id '${jobId}'`);
      }
    });
    tx(id);
  }

  /**
   * Record a completed run. Updates `last_run` on the job and inserts a row
   * in `cron_runs`. The caller is responsible for computing + persisting the
   * new `next_run` separately via `update()` — we don't own cron math here.
   */
  markRan(
    id: string,
    outcome: CronOutcome,
    durationMs: number,
    summary?: string,
    runAt: Date = new Date(),
  ): CronRun {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`CronJobsDB.markRan: no job with id '${id}'`);
    }
    const runAtIso = runAt.toISOString();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE cron_jobs SET last_run = ? WHERE id = ?`)
        .run(runAtIso, id);
      const info = this.db
        .prepare(
          `INSERT INTO cron_runs (job_id, run_at, outcome, duration_ms, summary)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, runAtIso, outcome, durationMs, summary ?? null);
      return info.lastInsertRowid;
    });
    const rowId = tx() as number | bigint;
    const row = this.db
      .prepare(`SELECT * FROM cron_runs WHERE id = ?`)
      .get(rowId) as CronRun;
    return row;
  }

  /** Fetch run history for a job, most-recent first. */
  runsByJob(id: string, limit = 50): CronRun[] {
    return this.db
      .prepare(
        `SELECT * FROM cron_runs
         WHERE job_id = ?
         ORDER BY run_at DESC, id DESC
         LIMIT ?`,
      )
      .all(id, limit) as CronRun[];
  }

  /** Close the DB if we opened it ourselves. No-op when sharing. */
  close(): void {
    if (this.owned) this.db.close();
  }
}
