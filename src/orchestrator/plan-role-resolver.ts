/**
 * Plan-role → AgentRole resolver — extracted from `orchestrator.ts` so
 * the main class stays under the 500-LOC budget (CLAUDE.md project rule).
 *
 * The Plan schema lets the Designer emit open-ended `agents[].role`
 * strings. Before we spawn a tmux pane we need to map each such string
 * onto one of the concrete `AgentRole`s the controller knows how to
 * boot. Unknown roles fall through to `backend` (the "generic coder") so
 * the Designer can coin new names without a code change; we log loudly
 * via the `ok: false` signal so the orchestrator can warn.
 */
import type { AgentRole } from "../agents/roles.js";
import { isValidRole } from "../agents/roles.js";

const ROLE_ALIASES: Record<string, AgentRole> = {
  architect: "system-designer",
  designer: "system-designer",
  researcher: "ai-ml-researcher",
  coder: "backend",
  operator: "devops-mlops",
  tester: "e2e-tester",
  pentester: "pen-tester",
  ui: "frontend",
  "ui-ux": "frontend",
};

export function resolvePlanRole(
  planRole: string,
): { role: AgentRole; ok: boolean } {
  if (isValidRole(planRole)) return { role: planRole, ok: true };
  const alias = ROLE_ALIASES[planRole.toLowerCase()];
  if (alias) return { role: alias, ok: true };
  return { role: "backend", ok: false };
}
