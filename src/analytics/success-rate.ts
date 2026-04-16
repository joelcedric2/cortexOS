/**
 * Per-role success-rate dashboard — plan §6 Phase 7 (bullet 3).
 *
 * Joins `loop_attempts` rows with the `agents.role` column via `task_id`
 * so we can answer "how often does the Coder role actually finish without
 * asking a human?" — the autonomy metric the dashboard plots.
 *
 * `loop_attempts` rows from the AutonomyLoop are per-attempt, not per-task.
 * We collapse them here: for each task_id we pick the terminal outcome
 * (DONE-with-no-ADAPT = success, DONE-with-ADAPT = recovered, trailing
 * ATTEMPT/ADAPT only = failed, ESCALATED = escalated) and produce role-level
 * aggregates plus a day-by-day trend for the chart.
 *
 * The join is done in memory rather than via a cross-table SQL query because
 * tests (and many prod deployments) may split `agents` and `loop_attempts`
 * across separate SQLite handles. Passing rows through JS keeps the function
 * backend-agnostic and easy to stub.
 */
import type { AgentRegistry, AgentRecord } from "../registry/agent-registry.js";
import type { LoopAttemptLog, LoopAttemptRow } from "../loop/loop-attempts-db.js";
import Database from "better-sqlite3";

// ─── Public types ────────────────────────────────────────────────────────────

export interface RoleSuccessStats {
  role: string;
  totalAttempts: number;
  successCount: number;
  recoveredCount: number;
  escalatedCount: number;
  failedCount: number;
  /** successCount / totalAttempts (0 when totalAttempts=0). */
  successRate: number;
  /** (successCount + recoveredCount) / totalAttempts — "no human asked". */
  autonomyRate: number;
  avgAttemptsToResolve: number;
  avgDurationMs: number;
  p95DurationMs: number;
}

export interface SuccessRateTrendPoint {
  /** YYYY-MM-DD. */
  day: string;
  successRate: number;
  autonomyRate: number;
  totalAttempts: number;
}

export interface SuccessRateReport {
  windowDays: number;
  byRole: RoleSuccessStats[];
  byOverall: RoleSuccessStats;
  trend: SuccessRateTrendPoint[];
}

export interface ComputeSuccessRateDeps {
  attemptsLog: LoopAttemptLog;
  registry: AgentRegistry;
}

export interface ComputeSuccessRateOpts {
  /** Rolling window. Default 7. */
  windowDays?: number;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

// ─── Internal ────────────────────────────────────────────────────────────────

interface TaskRollup {
  taskId: string;
  role: string;
  outcome: "success" | "recovered" | "failed" | "escalated";
  attempts: number;
  durationMs: number;
  endedAt: Date;
}

const DEFAULT_WINDOW_DAYS = 7;

interface LoopLogInternal {
  db: Database.Database;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function computeSuccessRate(
  deps: ComputeSuccessRateDeps,
  opts: ComputeSuccessRateOpts = {},
): Promise<SuccessRateReport> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? (() => new Date());
  const cutoff = windowCutoff(now(), windowDays);

  const rowsByTask = readAttemptsByTask(deps.attemptsLog, cutoff);
  const rolesByTask = indexAgentsByTask(deps.registry);

  const rollups: TaskRollup[] = [];
  for (const [taskId, rows] of rowsByTask) {
    const role = rolesByTask.get(taskId) ?? "unknown";
    const rollup = collapseAttempts(taskId, role, rows);
    if (rollup) rollups.push(rollup);
  }

  const byRole = aggregate(rollups, (r) => r.role);
  const overallRows = aggregate(rollups, () => "__overall__");
  const byOverall = overallRows[0] ?? emptyStats("all");
  byOverall.role = "all";

  const trend = buildTrend(rollups, now(), windowDays);

  // Sort byRole for deterministic output — useful for snapshots + caching.
  byRole.sort((a, b) => a.role.localeCompare(b.role));

  return { windowDays, byRole, byOverall, trend };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function collapseAttempts(
  taskId: string,
  role: string,
  rows: LoopAttemptRow[],
): TaskRollup | null {
  if (rows.length === 0) return null;

  // Sort ascending by id so the last row is the terminal state.
  rows.sort((a, b) => a.id - b.id);
  const terminal = rows[rows.length - 1];

  const sawDone = rows.some((r) => r.state === "DONE");
  const sawAdapt = rows.some((r) => r.state === "ADAPT");
  const sawEscalated = rows.some((r) => r.state === "ESCALATED");

  let outcome: TaskRollup["outcome"];
  if (sawEscalated) outcome = "escalated";
  else if (sawDone && sawAdapt) outcome = "recovered";
  else if (sawDone) outcome = "success";
  else outcome = "failed";

  const attemptNums = rows
    .filter((r) => r.state === "ATTEMPT" || r.state === "DONE")
    .map((r) => r.attempt);
  const attempts = attemptNums.length > 0 ? Math.max(...attemptNums) : rows.length;

  // Duration: first started_at → terminal ended_at.
  const startedAt = new Date(rows[0].started_at).getTime();
  const endedAt = new Date(terminal.ended_at).getTime();
  const durationMs = Math.max(0, endedAt - startedAt);

  return {
    taskId,
    role,
    outcome,
    attempts,
    durationMs,
    endedAt: new Date(terminal.ended_at),
  };
}

function aggregate(
  rollups: TaskRollup[],
  keyFn: (r: TaskRollup) => string,
): RoleSuccessStats[] {
  const byKey = new Map<string, TaskRollup[]>();
  for (const r of rollups) {
    const k = keyFn(r);
    const bucket = byKey.get(k);
    if (bucket) bucket.push(r);
    else byKey.set(k, [r]);
  }

  const out: RoleSuccessStats[] = [];
  for (const [key, bucket] of byKey) {
    out.push(toStats(key, bucket));
  }
  return out;
}

function toStats(role: string, rollups: TaskRollup[]): RoleSuccessStats {
  const total = rollups.length;
  if (total === 0) return emptyStats(role);

  let success = 0;
  let recovered = 0;
  let escalated = 0;
  let failed = 0;
  const attemptCounts: number[] = [];
  const durations: number[] = [];

  for (const r of rollups) {
    switch (r.outcome) {
      case "success":
        success += 1;
        break;
      case "recovered":
        recovered += 1;
        break;
      case "escalated":
        escalated += 1;
        break;
      case "failed":
        failed += 1;
        break;
    }
    if (r.outcome === "success" || r.outcome === "recovered") {
      attemptCounts.push(r.attempts);
    }
    durations.push(r.durationMs);
  }

  const avgAttempts = attemptCounts.length === 0
    ? 0
    : attemptCounts.reduce((a, b) => a + b, 0) / attemptCounts.length;
  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  const p95 = percentile(durations, 95);

  return {
    role,
    totalAttempts: total,
    successCount: success,
    recoveredCount: recovered,
    escalatedCount: escalated,
    failedCount: failed,
    successRate: round(success / total),
    autonomyRate: round((success + recovered) / total),
    avgAttemptsToResolve: round(avgAttempts),
    avgDurationMs: Math.round(avgDuration),
    p95DurationMs: Math.round(p95),
  };
}

function buildTrend(
  rollups: TaskRollup[],
  now: Date,
  windowDays: number,
): SuccessRateTrendPoint[] {
  // Pre-seed every day in the window with zeros so the chart has a contiguous
  // x-axis — gaps in the data would otherwise render as misleading jumps.
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(dayKey(d));
  }

  const byDay = new Map<string, TaskRollup[]>();
  for (const r of rollups) {
    const k = dayKey(r.endedAt);
    const bucket = byDay.get(k);
    if (bucket) bucket.push(r);
    else byDay.set(k, [r]);
  }

  return days.map((day) => {
    const bucket = byDay.get(day) ?? [];
    if (bucket.length === 0) {
      return { day, successRate: 0, autonomyRate: 0, totalAttempts: 0 };
    }
    const s = toStats("day", bucket);
    return {
      day,
      successRate: s.successRate,
      autonomyRate: s.autonomyRate,
      totalAttempts: s.totalAttempts,
    };
  });
}

// ─── DB reads ────────────────────────────────────────────────────────────────

function readAttemptsByTask(
  log: LoopAttemptLog,
  cutoffISO: string,
): Map<string, LoopAttemptRow[]> {
  const db = (log as unknown as LoopLogInternal).db;
  if (!db || typeof db.prepare !== "function") {
    throw new Error("readAttemptsByTask: LoopAttemptLog did not expose a SQLite handle");
  }
  const rows = db
    .prepare(`SELECT * FROM loop_attempts WHERE ended_at >= ? ORDER BY id ASC`)
    .all(cutoffISO) as LoopAttemptRow[];

  const byTask = new Map<string, LoopAttemptRow[]>();
  for (const r of rows) {
    const bucket = byTask.get(r.task_id);
    if (bucket) bucket.push(r);
    else byTask.set(r.task_id, [r]);
  }
  return byTask;
}

function indexAgentsByTask(registry: AgentRegistry): Map<string, string> {
  const byTask = new Map<string, string>();
  const agents: AgentRecord[] = registry.list();
  for (const a of agents) {
    if (!a.task_id) continue;
    // If multiple agents share a task_id (coordinator + specialists), the
    // first one we see wins. list() is started_at DESC so we keep the
    // most recent binding as the primary role for the dashboard bucket.
    if (!byTask.has(a.task_id)) byTask.set(a.task_id, a.role);
  }
  return byTask;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyStats(role: string): RoleSuccessStats {
  return {
    role,
    totalAttempts: 0,
    successCount: 0,
    recoveredCount: 0,
    escalatedCount: 0,
    failedCount: 0,
    successRate: 0,
    autonomyRate: 0,
    avgAttemptsToResolve: 0,
    avgDurationMs: 0,
    p95DurationMs: 0,
  };
}

function windowCutoff(now: Date, days: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function dayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function round(n: number): number {
  // Four-decimal precision is enough for the dashboard and keeps JSON diffs
  // stable in tests. Math.round ensures we don't emit -0.
  return Math.round(n * 10000) / 10000;
}
