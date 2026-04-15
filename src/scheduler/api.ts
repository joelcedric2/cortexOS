/**
 * CRUD surface for cron jobs — the seam between IPC handlers / MCP tools
 * and the storage layer (`cron-jobs-db.ts`).
 *
 * Each function validates its `input`/`patch` at the boundary with zod so
 * callers (IPC, MCP, tests) cannot sneak in malformed rows. The DB layer
 * is treated as a trusted narrow adapter — we do not re-validate shapes
 * it returns.
 *
 * No silent catches: parse failures throw zod `ZodError`, missing rows
 * throw generic `Error` with a short, non-sensitive message. Callers
 * (IPC handler) are responsible for converting to `{ok:false, error}`.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { CronJob, CronJobInput, CronJobsDB } from "./cron-jobs-db.js";
import { isValidCronExpr } from "./defaults.js";
import { nextRunFromCron } from "./next-run.js";

const CreatedBySchema = z.enum([
  "user",
  "nchinda_proactive",
  "skill_install",
  "onboarding",
]);

const DepthSchema = z.enum(["single-shot", "multi-agent"]);

const CronExprSchema = z
  .string()
  .min(3)
  .refine((v) => isValidCronExpr(v), {
    message: "not a valid 5-field cron expression",
  });

export const CronCreateInputSchema = z.object({
  name: z.string().min(1).max(128),
  cron_expr: CronExprSchema,
  task: z.string().min(1).max(4_000),
  role_hint: z.string().min(1).max(64).optional(),
  depth: DepthSchema.optional(),
  enabled: z.boolean().default(false),
  timezone: z.string().min(1).max(64).default("America/New_York"),
  created_by: CreatedBySchema,
  /** Optional override for tests — normally computed from `cron_expr`. */
  next_run: z.date().optional(),
  /** Optional explicit id — normally auto-generated. */
  id: z.string().min(1).optional(),
});

export const CronUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    cron_expr: CronExprSchema.optional(),
    task: z.string().min(1).max(4_000).optional(),
    role_hint: z.string().min(1).max(64).optional(),
    depth: DepthSchema.optional(),
    enabled: z.boolean().optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "update patch must not be empty",
  });

const IdSchema = z.string().min(1);

export type CronCreateInput = z.infer<typeof CronCreateInputSchema>;
export type CronUpdateInput = z.infer<typeof CronUpdateInputSchema>;

function generateId(): string {
  return `cron_${randomUUID().slice(0, 12)}`;
}

/** `cron.list` — all rows. Ordering delegated to DB. */
export function cronList(db: CronJobsDB): CronJob[] {
  return db.list();
}

/** `cron.create` — validate + insert. Returns the full persisted row. */
export function cronCreate(db: CronJobsDB, raw: unknown): CronJob {
  const input = CronCreateInputSchema.parse(raw);
  const nextRun =
    input.next_run ?? nextRunFromCron(input.cron_expr, new Date());
  const dbInput: CronJobInput = {
    id: input.id ?? generateId(),
    name: input.name,
    cron_expr: input.cron_expr,
    task: input.task,
    role_hint: input.role_hint ?? null,
    depth: input.depth ?? null,
    enabled: input.enabled,
    timezone: input.timezone,
    next_run: nextRun,
    created_by: input.created_by,
  };
  return db.create(dbInput);
}

/** `cron.update` — patch fields on an existing job. */
export function cronUpdate(
  db: CronJobsDB,
  rawId: unknown,
  rawPatch: unknown,
): CronJob {
  const id = IdSchema.parse(rawId);
  const patch = CronUpdateInputSchema.parse(rawPatch);
  return db.update(id, patch);
}

/** `cron.enable` — flip enabled=true. */
export function cronEnable(db: CronJobsDB, rawId: unknown): CronJob {
  const id = IdSchema.parse(rawId);
  return db.update(id, { enabled: true });
}

/** `cron.disable` — flip enabled=false. */
export function cronDisable(db: CronJobsDB, rawId: unknown): CronJob {
  const id = IdSchema.parse(rawId);
  return db.update(id, { enabled: false });
}

/** `cron.delete` — hard delete. */
export function cronDelete(db: CronJobsDB, rawId: unknown): { id: string } {
  const id = IdSchema.parse(rawId);
  db.delete(id);
  return { id };
}

/**
 * `cron.history` — return a job + its run history. Runs are read from the
 * `cron_runs` table via `db.runsByJob()` (most-recent first).
 */
export interface CronHistoryResult {
  job: CronJob;
  runs: Array<{
    run_at: string;
    outcome: "success" | "fail" | "escalated";
    duration_ms: number;
    summary?: string;
  }>;
}

export function cronHistory(db: CronJobsDB, rawId: unknown): CronHistoryResult {
  const id = IdSchema.parse(rawId);
  const job = db.getById(id);
  if (!job) throw new Error(`cron job not found: ${id}`);
  const runs = db.runsByJob(id).map((r) => ({
    run_at: r.run_at,
    outcome: r.outcome,
    duration_ms: r.duration_ms,
    summary: r.summary ?? undefined,
  }));
  return { job, runs };
}
