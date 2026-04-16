/**
 * Researcher-role detour — extracted from `orchestrator.ts` so the main
 * class stays under the 500-LOC budget (CLAUDE.md project rule).
 *
 * Flow: no tmux pane, no Claude Code spawn. Runs `runResearch` in-process,
 * persists the resulting Brief via `BriefStore` (if wired), and returns a
 * "virtual executor" whose `briefOutput` is the Brief's `recommended_action`
 * so the Designer sees it as this slot's result during phase-5 consolidation.
 *
 * Behavior is preserved verbatim from the pre-split code path. The signature
 * accepts a `deps` bag so the Orchestrator can pass its narrow internal
 * handles without exposing them as public API.
 */
import type { AgentRole } from "../agents/roles.js";
import { nextAgentId } from "../agents/roles.js";
import type { PlanAgent } from "./plan-schema.js";
import type { AgentRegistry } from "../registry/agent-registry.js";
import type { EventBus } from "../ipc/event-bus.js";
import type { BriefStore } from "../research/brief-store.js";
import type { runResearch as runResearchFn } from "../research/research-loop.js";

/**
 * A "virtual executor" produced by the researcher detour. Mirrors the shape
 * of `SpawnedExecutor` used by the Orchestrator — intentionally structural
 * so we don't export a private interface just to share a type name.
 */
export interface ResearcherExecutor {
  slot: number;
  id: string;
  role: AgentRole;
  planRole: string;
  agent: PlanAgent;
  briefOutput: string;
}

export interface ResearcherDetourDeps {
  registry: AgentRegistry;
  bus: EventBus;
  briefStore?: BriefStore;
  runResearch: typeof runResearchFn;
  /**
   * Monotonic virtual-slot allocator. The Orchestrator owns the agentIds
   * map; we ask it for a negative slot so researcher slots can never
   * collide with a real tmux slot (allocated by SlotManager).
   */
  allocateVirtualSlot: (agentId: string) => number;
}

/**
 * Run the researcher-role detour for a single `PlanAgent`. Returns a
 * virtual executor on success, or `null` if research failed (the registry
 * is transitioned to `error` in that case).
 */
export async function runResearcherDetour(
  planAgent: PlanAgent,
  taskId: string,
  deps: ResearcherDetourDeps,
): Promise<ResearcherExecutor | null> {
  const researcherRole: AgentRole = "ai-ml-researcher";
  const agentId = nextAgentId(researcherRole);

  const slot = deps.allocateVirtualSlot(agentId);

  deps.registry.spawn({
    id: agentId,
    role: planAgent.role,
    color: planAgent.color,
    tmux_session: `inline:researcher:${agentId}`,
    worktree: planAgent.worktree ?? null,
    task_id: taskId,
  });
  deps.registry.markRunning(agentId);

  console.log(
    `[CortexOS] ${agentId} (researcher) → inline (no tmux) [plan-role="${planAgent.role}"]`,
  );

  let brief;
  try {
    const depth =
      planAgent.budget?.max_minutes && planAgent.budget.max_minutes > 3
        ? ("deep" as const)
        : ("normal" as const);
    brief = await deps.runResearch(planAgent.task, {
      depth,
      bus: deps.bus,
      task_id: taskId,
    });
  } catch (err) {
    deps.registry.markError(agentId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[CortexOS] ${agentId} research failed: ${message}`);
    return null;
  }

  if (deps.briefStore) {
    try {
      await deps.briefStore.persist(brief, {
        task_id: taskId,
        agent_role: planAgent.role,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[CortexOS] ${agentId} brief persistence failed: ${message}`,
      );
    }
  }

  deps.registry.markDone(agentId);

  return {
    slot,
    id: agentId,
    role: researcherRole,
    planRole: planAgent.role,
    agent: planAgent,
    briefOutput: brief.recommended_action,
  };
}

/**
 * Case-insensitive check for the researcher family of plan roles. Kept
 * permissive so Designer synonyms like "Researcher" or "ai-ml-researcher"
 * all take the in-process detour.
 */
export function isResearcherRole(planRole: string): boolean {
  const n = planRole.toLowerCase().trim();
  return n === "researcher" || n === "ai-ml-researcher";
}
