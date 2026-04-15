import { z } from "zod";

/**
 * The Designer's Plan contract (Nchinda plan §5.3).
 *
 * RES0 / system-designer no longer emits free text for us to scrape; it
 * emits a structured Plan via the `emit_plan` tool call. The orchestrator
 * validates it with the zod schema below and refuses to proceed if it's
 * malformed — loud failure beats silent format drift.
 */

export const PLAN_COLORS = [
  "green",
  "blue",
  "yellow",
  "magenta",
  "cyan",
  "red",
] as const;
export type PlanColor = (typeof PLAN_COLORS)[number];

export const PLAN_COMPLEXITIES = ["single-shot", "multi-agent"] as const;
export type PlanComplexity = (typeof PLAN_COMPLEXITIES)[number];

export const PlanBudgetSchema = z
  .object({
    max_tokens: z.number().int().positive(),
    max_minutes: z.number().int().positive(),
  })
  .strict();

export const PlanAgentSchema = z
  .object({
    role: z.string().min(1),
    color: z.enum(PLAN_COLORS),
    worktree: z.string().min(1).optional(),
    system_prompt: z.string().min(1).optional(),
    task: z.string().min(1),
    success_criteria: z.string().min(1),
    budget: PlanBudgetSchema,
    depends_on: z.array(z.string()),
  })
  .strict();

export const PlanCoordinationSchema = z
  .object({
    checkpoints: z.array(z.string()),
    reporting_to: z.string().min(1),
  })
  .strict();

export const PlanSchema = z
  .object({
    task_id: z.string().min(1),
    goal: z.string().min(1),
    complexity: z.enum(PLAN_COMPLEXITIES),
    agents: z.array(PlanAgentSchema).min(1),
    coordination: PlanCoordinationSchema,
  })
  .strict();

export type Plan = z.infer<typeof PlanSchema>;
export type PlanAgent = z.infer<typeof PlanAgentSchema>;
export type PlanBudget = z.infer<typeof PlanBudgetSchema>;
export type PlanCoordination = z.infer<typeof PlanCoordinationSchema>;

export class PlanValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = "PlanValidationError";
  }
}

/**
 * Parse+validate a Plan from an unknown JSON value.
 *
 * This is the only supported entry point — callers must never construct a
 * Plan by hand without running it through here.
 */
export function parsePlan(input: unknown): Plan {
  const result = PlanSchema.safeParse(input);
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new PlanValidationError(
      `Invalid Plan: ${summary}`,
      result.error.issues,
    );
  }
  return result.data;
}

/**
 * JSON-schema-ish description of `emit_plan`'s argument shape, usable as
 * an Anthropic tool.input_schema. This is hand-authored (rather than derived
 * from zod) so we can keep the tool contract explicit and reviewable.
 */
export const EMIT_PLAN_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["task_id", "goal", "complexity", "agents", "coordination"],
  properties: {
    task_id: { type: "string" },
    goal: { type: "string" },
    complexity: { type: "string", enum: [...PLAN_COMPLEXITIES] },
    agents: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "role",
          "color",
          "task",
          "success_criteria",
          "budget",
          "depends_on",
        ],
        properties: {
          role: { type: "string" },
          color: { type: "string", enum: [...PLAN_COLORS] },
          worktree: { type: "string" },
          system_prompt: { type: "string" },
          task: { type: "string" },
          success_criteria: { type: "string" },
          budget: {
            type: "object",
            additionalProperties: false,
            required: ["max_tokens", "max_minutes"],
            properties: {
              max_tokens: { type: "integer", minimum: 1 },
              max_minutes: { type: "integer", minimum: 1 },
            },
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
    coordination: {
      type: "object",
      additionalProperties: false,
      required: ["checkpoints", "reporting_to"],
      properties: {
        checkpoints: {
          type: "array",
          items: { type: "string" },
        },
        reporting_to: { type: "string" },
      },
    },
  },
} as const;
