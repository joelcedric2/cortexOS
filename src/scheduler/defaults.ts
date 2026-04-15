/**
 * Default cron jobs shipped with Nchinda (NCHINDA_PLAN §5.6.3).
 *
 * All 6 jobs are pre-seeded with `enabled=false`; the user opts in during
 * onboarding or via voice ("Nchinda, turn on the morning brief"). Seeding
 * is idempotent — re-running `seedDefaults` will skip any job whose `name`
 * already exists in the registry, so boot-time seeding is safe.
 *
 * Module has no I/O of its own; it operates purely on a `CronJobsDB`
 * handle, which makes it trivially unit-testable.
 */
import type { CronJobInput, CronJobsDB } from "./cron-jobs-db.js";

/** Pre-id shape used for the ship-with-Nchinda set. */
type DefaultJob = Omit<CronJobInput, "id" | "next_run">;

/** Default IANA timezone for seeded jobs. Users can override per-job later. */
const DEFAULT_TZ = "America/New_York";

/**
 * The canonical ship-with-Nchinda job set. Order is stable so tests and
 * onboarding flows can reference by index if they want.
 *
 * `readonly` so consumers can't mutate the array in place.
 */
export const DEFAULT_JOBS: readonly DefaultJob[] = Object.freeze([
  {
    name: "morning_brief",
    cron_expr: "0 8 * * *",
    task: "Summarize overnight emails/messages; draft 3 priority replies",
    role_hint: "researcher",
    depth: "multi-agent",
    enabled: false,
    timezone: DEFAULT_TZ,
    created_by: "onboarding",
  },
  {
    name: "git_watchdog",
    cron_expr: "0 */2 * * *",
    task: "Check known repos for uncommitted work > 2h; nudge gently",
    role_hint: "coder",
    depth: "single-shot",
    enabled: false,
    timezone: DEFAULT_TZ,
    created_by: "onboarding",
  },
  {
    name: "inbox_zero_friday",
    cron_expr: "0 17 * * 5",
    task: "Draft responses to unanswered email threads ≥2 days old",
    role_hint: "researcher",
    depth: "multi-agent",
    enabled: false,
    timezone: DEFAULT_TZ,
    created_by: "onboarding",
  },
  {
    name: "meeting_prep",
    cron_expr: "*/10 * * * *",
    task: "If meeting in 30min has no prep doc, draft one",
    role_hint: "researcher",
    depth: "single-shot",
    enabled: false,
    timezone: DEFAULT_TZ,
    created_by: "onboarding",
  },
  {
    name: "skill_evolution_tick",
    cron_expr: "0 3 * * *",
    task: "Run skill evolution loop",
    depth: "multi-agent",
    enabled: false,
    timezone: DEFAULT_TZ,
    created_by: "onboarding",
  },
  {
    name: "memory_consolidation",
    cron_expr: "0 4 * * *",
    task: "Dedupe memories, promote canon patterns",
    role_hint: "memory-specialist",
    depth: "multi-agent",
    enabled: false,
    timezone: DEFAULT_TZ,
    created_by: "onboarding",
  },
]);

/**
 * Standard cron validator used both at seed time and at API boundaries.
 *
 * Accepts the 5-field POSIX form (minute, hour, day-of-month, month,
 * day-of-week). Each field may be `*`, a number, a range (`a-b`), a list
 * (`a,b,c`), or a step (`* / n`, `a-b/n`). Good enough to catch typos
 * without pulling in node-cron as a dependency here.
 */
export function isValidCronExpr(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;

  const ranges = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 }, // day of week (0 or 7 == Sunday)
  ];

  for (let i = 0; i < 5; i++) {
    if (!isValidField(fields[i]!, ranges[i]!.min, ranges[i]!.max)) return false;
  }
  return true;
}

function isValidField(field: string, min: number, max: number): boolean {
  // Split list: "1,5,10"
  for (const part of field.split(",")) {
    if (!isValidFieldPart(part, min, max)) return false;
  }
  return true;
}

function isValidFieldPart(part: string, min: number, max: number): boolean {
  // Step: "*/5" or "1-10/2"
  const [range, stepStr] = part.split("/");
  if (range === undefined) return false;
  if (stepStr !== undefined) {
    const step = Number(stepStr);
    if (!Number.isInteger(step) || step < 1) return false;
  }
  if (range === "*") return true;
  // Range: "1-5"
  if (range.includes("-")) {
    const [a, b] = range.split("-").map(Number);
    if (a === undefined || b === undefined) return false;
    if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
    if (a < min || b > max || a > b) return false;
    return true;
  }
  const n = Number(range);
  if (!Number.isInteger(n)) return false;
  return n >= min && n <= max;
}

export interface SeedResult {
  inserted: number;
  skipped: number;
  insertedNames: string[];
  skippedNames: string[];
}

/**
 * Insert every default job that doesn't already exist in the DB. Matches
 * by `name`, not by id. Returns a tally so callers can log what happened.
 *
 * Safe to call on every boot — no side effects if all jobs are already
 * present.
 */
export function seedDefaults(db: CronJobsDB): SeedResult {
  const existing = new Set(db.list().map((j) => j.name));
  const inserted: string[] = [];
  const skipped: string[] = [];

  for (const job of DEFAULT_JOBS) {
    if (existing.has(job.name)) {
      skipped.push(job.name);
      continue;
    }
    db.create({
      id: `default_${job.name}`,
      name: job.name,
      cron_expr: job.cron_expr,
      task: job.task,
      role_hint: job.role_hint ?? null,
      depth: job.depth ?? null,
      enabled: job.enabled,
      timezone: job.timezone,
      created_by: job.created_by,
      next_run: null,
    });
    inserted.push(job.name);
  }

  return {
    inserted: inserted.length,
    skipped: skipped.length,
    insertedNames: inserted,
    skippedNames: skipped,
  };
}
