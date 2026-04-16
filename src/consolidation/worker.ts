/**
 * Nightly consolidation worker — Phase 7 piece 3.
 *
 * Orchestrates dedup + canon promotion in sequence, emits bus events for
 * observability, and writes an audit JSON file so ops can replay any run.
 *
 * Run order is deterministic: dedup first (collapses noise) then canon
 * promotion (so we don't promote a row that would have been a dup victim).
 *
 * This module also exposes a `buildConsolidationRunHandler` adapter that the
 * Controller wires into the Scheduler for the `memory_consolidation` job
 * (see docs/phase-7/DECISIONS.md).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { EventBus } from "../ipc/event-bus.js";
import type { VectorStore } from "../memory/vector-store.js";
import type { Embedder } from "../memory/embedder.js";
import type { CronJob } from "../scheduler/cron-jobs-db.js";

import {
  dedupMemories,
  type DedupOptions,
  type DedupReport,
} from "./dedup.js";
import {
  promoteCanonPatterns,
  type CanonPromotionOptions,
  type CanonPromotionReport,
} from "./canon.js";
import type { ScreenMemoriesDB } from "../perception/screen-memories-db.js";
import {
  runRetention,
  type RetentionOptions,
  type RetentionReport,
} from "../perception/retention.js";

export interface ConsolidationRunReport {
  dedup: DedupReport;
  canon: CanonPromotionReport;
  /**
   * Phase 8.5 — screen-memories retention downgrader. Present only when
   * `deps.screenMemoriesDB` is supplied (opt-in; existing callers keep
   * the old shape unchanged).
   */
  retention?: RetentionReport;
  duration_ms: number;
  ts: string;
}

export interface ConsolidationDeps {
  vectorStore: VectorStore;
  embedder: Embedder;
  bus?: EventBus;
  /** Override the audit dir; defaults to ~/.cortexos/consolidation/runs. */
  auditDir?: string;
  /** Clock override for deterministic tests. */
  now?: () => Date;
  /**
   * Phase 8.5 — when present, the worker runs the 7-day retention sweep
   * after dedup + canon promotion.
   */
  screenMemoriesDB?: ScreenMemoriesDB;
}

export interface ConsolidationRunOptions {
  dedupOpts?: DedupOptions;
  canonOpts?: CanonPromotionOptions;
  /** Phase 8.5 — override retentionDays / dryRun for the retention sweep. */
  retentionOpts?: RetentionOptions;
  /** If true, skip persisting the report JSON. Tests opt-in. */
  skipPersist?: boolean;
}

const DEFAULT_AUDIT_DIR = join(homedir(), ".cortexos", "consolidation", "runs");

/**
 * Run the full consolidation pass. Safe to invoke from both the scheduler
 * and the CLI.
 */
export async function runConsolidation(
  deps: ConsolidationDeps,
  opts: ConsolidationRunOptions = {},
): Promise<ConsolidationRunReport> {
  const clock = deps.now ?? (() => new Date());
  const startedAt = clock();
  const startIso = startedAt.toISOString();

  emit(deps.bus, "CONSOLIDATION_STARTED", startedAt, { ts: startIso });

  // Worker entrypoint flips dryRun to false unless caller forces a dry run.
  const dedupOpts: DedupOptions = {
    dryRun: false,
    ...(opts.dedupOpts ?? {}),
  };
  const canonOpts: CanonPromotionOptions = {
    dryRun: false,
    now: clock,
    ...(opts.canonOpts ?? {}),
  };

  const dedup = await dedupMemories(
    { vectorStore: deps.vectorStore, embedder: deps.embedder },
    dedupOpts,
  );
  const canon = await promoteCanonPatterns(
    { vectorStore: deps.vectorStore },
    canonOpts,
  );

  // Phase 8.5 — retention runs after dedup + canon so both passes operate
  // on the full screen-memory set before frames are shed. Opt-in: only
  // runs when the caller supplies a screenMemoriesDB.
  let retention: RetentionReport | undefined;
  if (deps.screenMemoriesDB) {
    const retentionOpts: RetentionOptions = {
      now: clock,
      ...(opts.retentionOpts ?? {}),
    };
    retention = await runRetention(
      { db: deps.screenMemoriesDB },
      retentionOpts,
    );
    emit(deps.bus, "RETENTION_COMPLETE", clock(), { report: retention });
  }

  const finishedAt = clock();
  const report: ConsolidationRunReport = {
    dedup,
    canon,
    ...(retention ? { retention } : {}),
    duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    ts: startIso,
  };

  if (!opts.skipPersist) {
    try {
      await persistReport(report, deps.auditDir ?? DEFAULT_AUDIT_DIR);
    } catch (err) {
      // Persistence failure must not fail the consolidation itself — log and
      // surface via the bus so observability picks it up.
      const message = err instanceof Error ? err.message : String(err);
      emit(deps.bus, "CONSOLIDATION_PERSIST_FAILED", finishedAt, {
        error: message,
        ts: startIso,
      });
    }
  }

  emit(deps.bus, "CONSOLIDATION_COMPLETE", finishedAt, { report });
  return report;
}

/**
 * Build a scheduler-compatible handler that the Controller can register
 * against the `memory_consolidation` cron job.
 *
 * The handler is a `(job: CronJob) => Promise<void>` — exactly what
 * `SchedulerDeps.run` expects — so the Controller can delegate any job
 * named `memory_consolidation` to this function and leave everything else
 * on its normal autonomy-loop path.
 */
export function buildConsolidationRunHandler(
  deps: ConsolidationDeps,
  opts: ConsolidationRunOptions = {},
): (job: CronJob) => Promise<void> {
  return async (_job: CronJob): Promise<void> => {
    await runConsolidation(deps, opts);
  };
}

async function persistReport(
  report: ConsolidationRunReport,
  dir: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  // Filename-safe ISO — replace `:` which Windows FS rejects.
  const fname = `${report.ts.replace(/:/g, "-")}.json`;
  const target = join(dir, fname);
  // Sanitize: ensure target remains inside dir after any normalization.
  const normalized = join(target);
  if (dirname(normalized) !== dir) {
    throw new Error(`persistReport: refusing to write outside ${dir}`);
  }
  await writeFile(normalized, JSON.stringify(report, null, 2), "utf8");
  return normalized;
}

function emit(
  bus: EventBus | undefined,
  phase:
    | "CONSOLIDATION_STARTED"
    | "CONSOLIDATION_COMPLETE"
    | "CONSOLIDATION_PERSIST_FAILED"
    | "RETENTION_COMPLETE",
  ts: Date,
  payload: Record<string, unknown>,
): void {
  if (!bus) return;
  try {
    bus.emit({
      kind: "plan_emitted",
      payload: { phase, ...payload },
      ts,
    });
  } catch {
    // Bus failures are non-fatal — observability-only signal.
  }
}
