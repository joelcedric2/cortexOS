/**
 * TEMPORARY stub of Agent A's `src/scheduler/cron-jobs-db.ts`.
 *
 * Agent A owns the real implementation (SQLite-backed `cron_jobs` table).
 * This stub exists ONLY so Agent B's work (NL parser, defaults, API, MCP
 * tool) can land and be independently tested while Agent A is in flight.
 *
 * DELETE THIS FILE once `cron-jobs-db.ts` lands on `main` and every import
 * of `./_cron-jobs-db-stub.js` has been flipped to `./cron-jobs-db.js`.
 *
 * Contract mirrors the one in the Phase 1.5 brief verbatim:
 *
 *   class CronJobsDB {
 *     insert(job: CronJobInput): CronJob
 *     update(id: string, patch: Partial<CronJobInput>): void
 *     delete(id: string): void
 *     listAll(): CronJob[]
 *     listDue(now: Date): CronJob[]
 *     markRan(id, outcome, durationMs, summary?): void
 *     getById(id: string): CronJob | null
 *   }
 */

export type CronOutcome = "success" | "fail" | "escalated";

export type CronCreatedBy =
  | "user"
  | "nchinda_proactive"
  | "skill_install"
  | "onboarding";

export interface CronRunRecord {
  run_at: Date;
  outcome: CronOutcome;
  duration_ms: number;
  summary?: string;
}

export interface CronJobInput {
  name: string;
  cron_expr: string;
  task: string;
  role_hint?: string;
  depth?: "single-shot" | "multi-agent";
  enabled: boolean;
  timezone: string;
  created_by: CronCreatedBy;
}

export interface CronJob extends CronJobInput {
  id: string;
  last_run?: Date;
  next_run: Date;
  outcome_history: CronRunRecord[];
  created_at: Date;
}

export class CronJobsDB {
  private readonly rows = new Map<string, CronJob>();
  private seq = 0;

  insert(input: CronJobInput): CronJob {
    this.seq += 1;
    const id = `cron_${this.seq}`;
    const now = new Date();
    const row: CronJob = {
      ...input,
      id,
      next_run: new Date(now.getTime() + 60_000), // placeholder; real impl uses cron parser
      outcome_history: [],
      created_at: now,
    };
    this.rows.set(id, row);
    return row;
  }

  update(id: string, patch: Partial<CronJobInput>): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`cron job not found: ${id}`);
    Object.assign(row, patch);
  }

  delete(id: string): void {
    if (!this.rows.delete(id)) {
      throw new Error(`cron job not found: ${id}`);
    }
  }

  listAll(): CronJob[] {
    return [...this.rows.values()];
  }

  listDue(now: Date): CronJob[] {
    return this.listAll().filter((j) => j.enabled && j.next_run <= now);
  }

  markRan(
    id: string,
    outcome: CronOutcome,
    durationMs: number,
    summary?: string,
  ): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`cron job not found: ${id}`);
    row.last_run = new Date();
    row.outcome_history.push({
      run_at: row.last_run,
      outcome,
      duration_ms: durationMs,
      summary,
    });
  }

  getById(id: string): CronJob | null {
    return this.rows.get(id) ?? null;
  }
}
