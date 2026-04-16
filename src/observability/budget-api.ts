/**
 * Budget API helpers — Phase 7 §6.5 UI surface.
 *
 * Pulled into its own module so the shared UIApiServer (also touched by
 * C2's antipatterns work) only grows by one option + two route dispatches.
 * All request-parameter parsing happens here via zod; handlers return
 * `{ status, body }` rather than writing to the response, so they compose
 * cleanly with the existing `sendJson` / `sendError` helpers.
 */
import { z } from "zod";
import type { BudgetTracker, AgentBudget, BudgetWindowTotals } from "./budget-tracker.js";

export type BudgetHandlerResult =
  | { status: 200; body: AgentBudget[] | BudgetWindowTotals }
  | { status: 400; body: { error: string } };

const totalsQuery = z.object({
  days: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 1 : Number.parseInt(v, 10)))
    .refine((n) => Number.isFinite(n) && n > 0 && n <= 365, {
      message: "'days' must be a positive integer ≤ 365",
    }),
});

/** GET /ui/budgets — current per-agent budgets, most-recent-first. */
export function handleBudgetsList(tracker: BudgetTracker): BudgetHandlerResult {
  return { status: 200, body: tracker.listActive() };
}

/** GET /ui/budgets/totals?days=<n> — rolling totals window. */
export function handleBudgetsTotals(
  tracker: BudgetTracker,
  params: Record<string, string>,
): BudgetHandlerResult {
  const parsed = totalsQuery.safeParse(params);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    return { status: 400, body: { error: msg } };
  }
  return { status: 200, body: tracker.totalsInWindow(parsed.data.days) };
}
