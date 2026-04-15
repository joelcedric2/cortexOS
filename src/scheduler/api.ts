/**
 * CRUD surface for cron jobs — the seam between IPC handlers / MCP tools
 * and the storage layer (`_cron-jobs-db-stub.ts` today, real
 * `cron-jobs-db.ts` once Agent A's table lands on main).
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
import type { CronJob, CronJobInput, CronJobsDB } from "./_cron-jobs-db-stub.js";
import { isValidCronExpr } from "./defaults.js";

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

/** `cron.list` — all rows. Ordering delegated to DB. */
export function cronList(db: CronJobsDB): CronJob[] {
  return db.listAll();
}

/** `cron.create` — validate + insert. Returns the full persisted row. */
export function cronCreate(db: CronJobsDB, raw: unknown): CronJob {
  const input = CronCreateInputSchema.parse(raw);
  const dbInput: CronJobInput = {
    name: input.name,
    cron_expr: input.cron_expr,
    task: input.task,
    role_hint: input.role_hint,
    depth: input.depth,
    enabled: input.enabled,
    timezone: input.timezone,
    created_by: input.created_by,
  };
  return db.insert(dbInput);
}

/** `cron.update` — patch fields on an existing job. */
export function cronUpdate(
  db: CronJobsDB,
  rawId: unknown,
  rawPatch: unknown,
): CronJob {
  const id = IdSchema.parse(rawId);
  const patch = CronUpdateInputSchema.parse(rawPatch);
  db.update(id, patch);
  const row = db.getById(id);
  if (!row) throw new Error(`cron job not found: ${id}`);
  return row;
}

/** `cron.enable` — flip enabled=true. */
export function cronEnable(db: CronJobsDB, rawId: unknown): CronJob {
  const id = IdSchema.parse(rawId);
  db.update(id, { enabled: true });
  const row = db.getById(id);
  if (!row) throw new Error(`cron job not found: ${id}`);
  return row;
}

/** `cron.disable` — flip enabled=false. */
export function cronDisable(db: CronJobsDB, rawId: unknown): CronJob {
  const id = IdSchema.parse(rawId);
  db.update(id, { enabled: false });
  const row = db.getById(id);
  if (!row) throw new Error(`cron job not found: ${id}`);
  return row;
}

/** `cron.delete` — hard delete. */
export function cronDelete(db: CronJobsDB, rawId: unknown): { id: string } {
  const id = IdSchema.parse(rawId);
  db.delete(id);
  return { id };
}

/**
 * `cron.history` — return a job + its run history. The stub DB keeps
 * `outcome_history` on the row itself; normalize to a plain array.
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
  const runs = (job.outcome_history ?? []).map((r) => ({
    run_at: r.run_at instanceof Date ? r.run_at.toISOString() : String(r.run_at),
    outcome: r.outcome,
    duration_ms: r.duration_ms,
    summary: r.summary,
  }));
  return { job, runs };
}
