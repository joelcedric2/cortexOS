/**
 * Stress harness — Phase 7 §6 bullet 4.
 *
 * Runs a battery of synthetic tasks through a caller-supplied `runTaskFn`
 * and produces an aggregate `StressReport` measuring autonomy %, outcome
 * distribution, token spend, and per-complexity success rates.
 *
 * Design points:
 *   - The harness is runner-agnostic. `runTaskFn` is injected so we can
 *     exercise the same battery against the real autonomy loop, a mocked
 *     scripted runner (for tests), or a shadow-mode dry run.
 *   - A bounded worker pool enforces `concurrency`. At most N tasks are
 *     in-flight at any time; completion frees a slot for the next one.
 *   - Timeouts are enforced by the harness (not the runner). A task that
 *     does not resolve within `perTaskTimeoutMs` is recorded as a
 *     `timeout` outcome and the slot is released — we do NOT await the
 *     dangling promise. This means `runStressBattery` always completes.
 *   - `runStressBattery` never throws. Runner exceptions become
 *     `outcome: 'failed'` with the error message captured.
 */

export type StressComplexity = "simple" | "moderate" | "complex";
export type StressOutcome =
  | "success"
  | "recovered"
  | "failed"
  | "escalated"
  | "timeout";
export type StressExpectedOutcome = "success" | "escalation-acceptable";

export interface StressTask {
  id: string;
  complexity: StressComplexity;
  task: string; // natural-language instruction
  expectedOutcome: StressExpectedOutcome;
  expectedMaxAttempts: number;
}

export interface StressResult {
  taskId: string;
  outcome: StressOutcome;
  attempts: number;
  duration_ms: number;
  tokens_in?: number;
  tokens_out?: number;
  error?: string;
}

export interface StressRunOptions {
  tasks: StressTask[];
  concurrency?: number; // default 4
  runTaskFn: (task: StressTask) => Promise<StressResult>;
  perTaskTimeoutMs?: number; // default 300_000 (5 min)
  /** Optional hook fired after each task completes — useful for progress UIs. */
  onProgress?: (result: StressResult, completed: number, total: number) => void;
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface StressComplexityBreakdown {
  total: number;
  autonomyPct: number;
}

export interface StressReport {
  total: number;
  byOutcome: Record<StressOutcome, number>;
  autonomyPct: number; // (success + recovered) / total × 100
  successPct: number;
  avgDuration_ms: number;
  p95Duration_ms: number;
  totalTokens: { in: number; out: number };
  byComplexity: Record<StressComplexity, StressComplexityBreakdown>;
  failures: StressResult[]; // for postmortem — every non-success-or-recovered outcome
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PER_TASK_TIMEOUT_MS = 300_000;

const AUTONOMY_OUTCOMES: ReadonlySet<StressOutcome> = new Set([
  "success",
  "recovered",
]);

/**
 * Run the battery. Never throws — any per-task failure becomes a
 * `failed` or `timeout` result and is included in the report.
 */
export async function runStressBattery(
  opts: StressRunOptions,
): Promise<StressReport> {
  const tasks = opts.tasks;
  if (tasks.length === 0) {
    return emptyReport();
  }

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = Math.max(1, opts.perTaskTimeoutMs ?? DEFAULT_PER_TASK_TIMEOUT_MS);
  const now = opts.now ?? Date.now;

  const results: StressResult[] = new Array(tasks.length);

  let cursor = 0;
  let completed = 0;

  const runOne = async (idx: number): Promise<void> => {
    const task = tasks[idx];
    const started = now();
    const result = await runWithTimeout(task, opts.runTaskFn, timeoutMs, started, now);
    results[idx] = result;
    completed += 1;
    if (opts.onProgress) {
      try {
        opts.onProgress(result, completed, tasks.length);
      } catch {
        // progress callbacks must not break the run
      }
    }
  };

  const workers: Array<Promise<void>> = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      await runOne(idx);
    }
  };

  const n = Math.min(concurrency, tasks.length);
  for (let i = 0; i < n; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return buildReport(tasks, results);
}

/**
 * Race the runner against a timer. If the timer wins, return a
 * `timeout` result immediately; do NOT await the dangling promise.
 * If the runner throws, coerce to a `failed` result.
 */
async function runWithTimeout(
  task: StressTask,
  runTaskFn: (task: StressTask) => Promise<StressResult>,
  timeoutMs: number,
  started: number,
  now: () => number,
): Promise<StressResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<StressResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        taskId: task.id,
        outcome: "timeout",
        attempts: 1,
        duration_ms: now() - started,
        error: `timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    // Avoid holding the event loop open in short-lived tests.
    if (typeof timer.unref === "function") timer.unref();
  });

  const runnerPromise = Promise.resolve()
    .then(() => runTaskFn(task))
    .then<StressResult>((r) => {
      // Defensive normalization: runner may return partial data.
      return {
        taskId: r.taskId ?? task.id,
        outcome: r.outcome,
        attempts: Math.max(1, Math.floor(r.attempts ?? 1)),
        duration_ms: Math.max(0, Math.floor(r.duration_ms ?? now() - started)),
        tokens_in: r.tokens_in,
        tokens_out: r.tokens_out,
        error: r.error,
      };
    })
    .catch<StressResult>((err: unknown) => ({
      taskId: task.id,
      outcome: "failed",
      attempts: 1,
      duration_ms: now() - started,
      error: err instanceof Error ? err.message : String(err),
    }));

  const winner = await Promise.race([runnerPromise, timeoutPromise]);
  if (timer !== undefined) clearTimeout(timer);
  return winner;
}

function buildReport(
  tasks: StressTask[],
  results: StressResult[],
): StressReport {
  const byOutcome: Record<StressOutcome, number> = {
    success: 0,
    recovered: 0,
    failed: 0,
    escalated: 0,
    timeout: 0,
  };
  let totalDuration = 0;
  let tokens_in = 0;
  let tokens_out = 0;

  const byComplexityCounts: Record<
    StressComplexity,
    { total: number; autonomous: number }
  > = {
    simple: { total: 0, autonomous: 0 },
    moderate: { total: 0, autonomous: 0 },
    complex: { total: 0, autonomous: 0 },
  };

  const failures: StressResult[] = [];
  const durations: number[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const r = results[i];
    if (!r) continue; // shouldn't happen, but be defensive
    byOutcome[r.outcome] += 1;
    totalDuration += r.duration_ms;
    durations.push(r.duration_ms);
    tokens_in += r.tokens_in ?? 0;
    tokens_out += r.tokens_out ?? 0;

    const bucket = byComplexityCounts[task.complexity];
    bucket.total += 1;
    if (isAutonomyOutcome(r, task)) bucket.autonomous += 1;

    if (!isAutonomyOutcome(r, task)) failures.push(r);
  }

  const total = tasks.length;
  const autonomous =
    byComplexityCounts.simple.autonomous +
    byComplexityCounts.moderate.autonomous +
    byComplexityCounts.complex.autonomous;

  const byComplexity: Record<StressComplexity, StressComplexityBreakdown> = {
    simple: pctBucket(byComplexityCounts.simple),
    moderate: pctBucket(byComplexityCounts.moderate),
    complex: pctBucket(byComplexityCounts.complex),
  };

  return {
    total,
    byOutcome,
    autonomyPct: pct(autonomous, total),
    successPct: pct(byOutcome.success, total),
    avgDuration_ms: total === 0 ? 0 : Math.round(totalDuration / total),
    p95Duration_ms: percentile(durations, 95),
    totalTokens: { in: tokens_in, out: tokens_out },
    byComplexity,
    failures,
  };
}

/**
 * "Autonomy" = the agent handled it end-to-end (or self-recovered).
 * `escalated` is counted as autonomy ONLY when the task explicitly
 * expected escalation — otherwise it counts as a failure to complete.
 */
function isAutonomyOutcome(r: StressResult, task: StressTask): boolean {
  if (AUTONOMY_OUTCOMES.has(r.outcome)) return true;
  if (r.outcome === "escalated" && task.expectedOutcome === "escalation-acceptable") {
    return true;
  }
  return false;
}

function pctBucket(b: { total: number; autonomous: number }): StressComplexityBreakdown {
  return { total: b.total, autonomyPct: pct(b.autonomous, b.total) };
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 10_000) / 100; // two decimal places
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank method
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

function emptyReport(): StressReport {
  return {
    total: 0,
    byOutcome: { success: 0, recovered: 0, failed: 0, escalated: 0, timeout: 0 },
    autonomyPct: 0,
    successPct: 0,
    avgDuration_ms: 0,
    p95Duration_ms: 0,
    totalTokens: { in: 0, out: 0 },
    byComplexity: {
      simple: { total: 0, autonomyPct: 0 },
      moderate: { total: 0, autonomyPct: 0 },
      complex: { total: 0, autonomyPct: 0 },
    },
    failures: [],
  };
}
