/**
 * Phase 1.5 — Persistent Scheduler ticker.
 *
 * Polls `CronJobsDB.listDue(now)` on a fixed interval and fires each due job
 * via the injected `run` callback. Emits a `cron_fire` EventBus event at the
 * start of each dispatch and calls `db.markRan(...)` when the run settles.
 *
 * Design notes:
 *  - Dispatch is non-blocking: each `run(job)` returns a Promise that we kick
 *    off fire-and-forget. The tick loop never waits on executor completion,
 *    so a long-running autonomy loop cannot starve the ticker.
 *  - Dedup: we track in-flight job ids in a `Set`. If a job is still running
 *    when the next tick arrives, we skip re-dispatch. Prevents duplicate
 *    fires when a cron fires faster than the job completes.
 *  - `stop()` is idempotent: clears the interval and awaits all in-flight
 *    runs so `shutdown()` can guarantee no dangling markRan writes.
 */
import type { CronJob, CronJobsDB, CronOutcome } from "./cron-jobs-db.js";
import type { AgentEvent, EventBus } from "../ipc/event-bus.js";
import { nextRunFromCron } from "./next-run.js";

export type SchedulerRun = (job: CronJob) => Promise<void>;

export interface SchedulerDeps {
  db: CronJobsDB;
  bus: EventBus;
  run: SchedulerRun;
  /** Clock override for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

const DEFAULT_INTERVAL_SEC = 10;

export class Scheduler {
  private readonly db: CronJobsDB;
  private readonly bus: EventBus;
  private readonly run: SchedulerRun;
  private readonly now: () => Date;

  private timer: NodeJS.Timeout | null = null;
  /** Job ids currently being executed — blocks re-dispatch on the next tick. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(deps: SchedulerDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.run = deps.run;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Start polling. Safe to call repeatedly — second call is a no-op.
   * `intervalSec` defaults to 10 seconds per plan §5.6.
   */
  start(intervalSec: number = DEFAULT_INTERVAL_SEC): void {
    if (this.timer) return;
    if (intervalSec <= 0) {
      throw new Error(`Scheduler.start: intervalSec must be > 0, got ${intervalSec}`);
    }
    this.timer = setInterval(() => {
      this.tick();
    }, intervalSec * 1000);
    // Don't hold the event loop open just for the scheduler in short-lived CLIs.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /**
   * Stop the ticker and await all in-flight dispatches. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Copy to a local array — the set mutates as runs settle.
    const pending = Array.from(this.inFlight.values());
    await Promise.allSettled(pending);
  }

  /** Number of jobs currently executing. Primarily for observability/tests. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Single polling tick — exposed for tests that want deterministic control
   * instead of waiting on `setInterval`. Never throws; per-job errors are
   * captured and surfaced through `markRan` with outcome='fail'.
   */
  tick(): void {
    let due: CronJob[];
    try {
      due = this.db.listDue(this.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Scheduler] listDue failed: ${message}`);
      return;
    }

    for (const job of due) {
      if (this.inFlight.has(job.id)) continue;
      this.dispatch(job);
    }
  }

  private dispatch(job: CronJob): void {
    const startedAt = this.now();

    const event: AgentEvent = {
      kind: "cron_fire",
      task_id: job.id,
      payload: { name: job.name, task: job.task },
      ts: startedAt,
    };
    try {
      this.bus.emit(event);
    } catch (err) {
      // Bus failures are non-fatal — we still want to run the job.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Scheduler] bus.emit(cron_fire) failed for ${job.id}: ${message}`);
    }

    const promise = this.runJob(job, startedAt);
    this.inFlight.set(job.id, promise);
    // Ensure the map shrinks even if the executor throws.
    promise.finally(() => {
      this.inFlight.delete(job.id);
    });
  }

  private async runJob(job: CronJob, startedAt: Date): Promise<void> {
    let outcome: CronOutcome = "success";
    let summary: string | undefined;
    try {
      await this.run(job);
    } catch (err) {
      outcome = "fail";
      summary = err instanceof Error ? err.message : String(err);
    }

    const finishedAt = this.now();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

    try {
      this.db.markRan(job.id, outcome, durationMs, summary, finishedAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Scheduler] markRan failed for ${job.id}: ${message}`);
    }

    // Recompute next_run. Without this, once listDue picks up a job the `next_run`
    // never advances and it fires every tick forever (§Phase 1.5 REVIEW Patch 2).
    try {
      const next = nextRunFromCron(job.cron_expr, finishedAt);
      this.db.update(job.id, { next_run: next ?? undefined });
    } catch (err) {
      // Malformed cron_expr slipped past validation: disable the job to prevent
      // a tight loop rather than keep firing it.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Scheduler] disabled ${job.id}: bad cron_expr (${message})`);
      try {
        this.db.update(job.id, { enabled: false });
      } catch {
        // best-effort
      }
    }
  }
}
