import type { CortexController } from "../controller/cortex.js";
import type { TmuxManager } from "../tmux/tmux-manager.js";
import { nextAgentId, getRoleDefinition } from "../agents/roles.js";
import type { AgentRole } from "../agents/roles.js";
import type { AgentProvider } from "../agents/agent.js";
import { extractEmittedPlan } from "../agents/claude-agent.js";
import { parsePlan, type Plan, type PlanAgent } from "./plan-schema.js";
import { AgentRegistry, getAgentRegistry } from "../registry/agent-registry.js";
import {
  createEventBus,
  type AgentEvent,
  type EventBus,
} from "../ipc/event-bus.js";
import { randomUUID } from "node:crypto";
import { runResearch } from "../research/research-loop.js";
import type { BriefStore } from "../research/brief-store.js";
import type { WorktreeManager } from "../workspace/worktree-manager.js";
import {
  runResearcherDetour,
  isResearcherRole,
  type ResearcherExecutor,
} from "./researcher-executor.js";
import { buildDesignerPromptWithRecall } from "./designer-recall.js";
import {
  sessionNameForSlot,
  openAgentTerminal,
  waitForPaneReady,
  captureSlotPane,
} from "./pane-helpers.js";
import { resolvePlanRole } from "./plan-role-resolver.js";

const DEFAULT_DONE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DESIGNER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Structured outcome of a single orchestrator attempt. Consumed by the
 * AutonomyLoop (Phase 2) which wraps executeOnce with fallback logic.
 */
export interface OrchestratorResult {
  success: boolean;
  taskId: string;
  error?: string;
}

export interface OrchestratorDeps {
  registry?: AgentRegistry;
  bus?: EventBus;
  capturePaneOutput?: (slot: number) => Promise<string>;
  waitForReady?: (slot: number) => Promise<void>;
  openTerminal?: (slot: number, agentId: string, role: AgentRole) => Promise<void>;
  doneTimeoutMs?: number;
  designerTimeoutMs?: number;
  briefStore?: BriefStore;
  runResearch?: typeof runResearch;
  worktreeManager?: WorktreeManager;
}

interface SpawnedExecutor {
  slot: number;
  id: string;
  role: AgentRole;
  planRole: string;
  agent: PlanAgent;
  /** Output produced in-process by the researcher-role detour. */
  briefOutput?: string;
}

/**
 * CortexOS Orchestrator — the brain (Phase 1 rewrite, Nchinda §6 Phase 1).
 *
 * Flow: task → Designer (RES0) plan → executors → event-driven done → consolidate.
 * Sub-modules: researcher-executor.ts, designer-recall.ts, pane-helpers.ts,
 * plan-role-resolver.ts. See CLAUDE.md §File Organization for the split rationale.
 */
export class Orchestrator {
  private readonly agentIds = new Map<number, string>();
  private readonly registry: AgentRegistry;
  private readonly bus: EventBus;
  private readonly doneTimeoutMs: number;
  private readonly designerTimeoutMs: number;
  private readonly captureOverride?: (slot: number) => Promise<string>;
  private readonly readyOverride?: (slot: number) => Promise<void>;
  private readonly openTerminalOverride?: (
    slot: number,
    agentId: string,
    role: AgentRole,
  ) => Promise<void>;
  private readonly briefStore?: BriefStore;
  private readonly runResearchFn: typeof runResearch;
  private readonly worktreeManager?: WorktreeManager;

  constructor(
    private readonly controller: CortexController,
    private readonly tmux: TmuxManager,
    deps: OrchestratorDeps = {},
  ) {
    this.registry = deps.registry ?? getAgentRegistry();
    this.bus = deps.bus ?? createEventBus();
    this.doneTimeoutMs = deps.doneTimeoutMs ?? DEFAULT_DONE_TIMEOUT_MS;
    this.designerTimeoutMs =
      deps.designerTimeoutMs ?? DEFAULT_DESIGNER_TIMEOUT_MS;
    this.captureOverride = deps.capturePaneOutput;
    this.readyOverride = deps.waitForReady;
    this.openTerminalOverride = deps.openTerminal;
    this.briefStore = deps.briefStore;
    this.runResearchFn = deps.runResearch ?? runResearch;
    this.worktreeManager = deps.worktreeManager;
  }

  /** Primary entry point — drive the end-to-end Phase 1 flow for `task`. */
  async execute(task: string): Promise<void> {
    console.log(`\n[CortexOS] Received task: "${task}"`);
    const taskId = randomUUID();

    console.log("[CortexOS] Phase 1: Spawning RES0 (Researcher & System Designer)...\n");
    const designerRole: AgentRole = "system-designer";
    const res0Id = nextAgentId(designerRole);
    const res0Slot = await this.controller.spawnAgent(designerRole, "claude", 0);
    this.agentIds.set(res0Slot, res0Id);

    this.registry.spawn({
      id: res0Id,
      role: designerRole,
      color: "cyan",
      tmux_session: sessionNameForSlot(this.controller, res0Slot),
      task_id: taskId,
    });
    this.registry.markRunning(res0Id);

    await this.openTerminal(res0Slot, res0Id, designerRole);
    await this.waitForReady(res0Slot);

    const planningPrompt = await buildDesignerPromptWithRecall(task, taskId, {
      briefStore: this.briefStore,
    });
    await this.controller.sendMessage(res0Slot, planningPrompt);
    console.log(`[CortexOS] ${res0Id} received task. Analyzing and planning...\n`);

    const plan = await this.awaitPlan(res0Slot, res0Id, taskId);

    if (plan.complexity === "single-shot" || plan.agents.length === 0) {
      console.log("[CortexOS] Designer handled the task directly (single-shot). No executors needed.");
      this.registry.markDone(res0Id);
      return;
    }

    console.log(`\n[CortexOS] Phase 3: Spawning ${plan.agents.length} executor(s) from Plan...\n`);
    const executors: SpawnedExecutor[] = [];
    for (const planAgent of plan.agents) {
      const executor = await this.spawnExecutor(planAgent, taskId);
      if (executor) executors.push(executor);
    }

    if (executors.length === 0) {
      console.log("[CortexOS] Plan contained no executable agents after role validation. Aborting.");
      this.registry.markError(res0Id);
      return;
    }

    console.log(`\n[CortexOS] Phase 4: awaiting 'done' events for ${executors.length} executor(s)...\n`);
    await this.awaitExecutorsDone(executors, taskId);

    console.log("\n[CortexOS] Phase 5: Designer consolidating results...\n");
    const summaries = await this.buildConsolidationSummaries(executors);
    const reportingTarget = plan.coordination.reporting_to;
    const consolidationPrompt =
      `The following agents completed their work on task ${taskId}. ` +
      `You (${reportingTarget}) are the reporting target — consolidate their ` +
      `findings into a final report:\n\n${summaries.join("\n\n")}`;
    await this.controller.sendMessage(res0Slot, consolidationPrompt);

    this.registry.markDone(res0Id);
    console.log("[CortexOS] All phases complete. Terminals remain open for review.\n");
  }

  /** Exposed for tests and call-sites that already have Plan JSON. */
  parsePlanJson(json: unknown): Plan {
    return parsePlan(json);
  }

  /**
   * Single-attempt execution path used by the AutonomyLoop (Phase 2). Given a
   * pre-built Plan and task_id, spawns executors and returns a structured
   * result instead of driving the full Designer → consolidate pipeline.
   */
  async executeOnce(plan: Plan, taskId: string): Promise<OrchestratorResult> {
    if (plan.complexity === "single-shot" || plan.agents.length === 0) {
      return { success: true, taskId };
    }

    const executors: SpawnedExecutor[] = [];
    for (const planAgent of plan.agents) {
      const executor = await this.spawnExecutor(planAgent, taskId);
      if (executor) executors.push(executor);
    }

    if (executors.length === 0) {
      return { success: false, taskId, error: "plan produced no executable agents" };
    }

    let anyFailed = false;
    const failures: string[] = [];

    await Promise.all(
      executors.map(async (ex) => {
        if (ex.briefOutput !== undefined) return;
        let reachedTerminal = false;
        try {
          const event = await this.bus.once(
            { kind: "done", slot: ex.slot, task_id: taskId },
            this.doneTimeoutMs,
          );
          const payload =
            typeof event.payload === "object" && event.payload !== null
              ? (event.payload as { success?: boolean; error?: string })
              : {};
          if (payload.success === false) {
            anyFailed = true;
            failures.push(`${ex.id}: ${payload.error ?? "reported failure"}`);
            this.registry.markError(ex.id);
            reachedTerminal = true;
            return;
          }
          this.registry.markDone(ex.id);
          reachedTerminal = true;
        } catch (err) {
          anyFailed = true;
          failures.push(
            `${ex.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.registry.markError(ex.id);
          reachedTerminal = true;
        } finally {
          if (this.worktreeManager && reachedTerminal) {
            try {
              await this.worktreeManager.release(ex.id);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.warn(`[CortexOS] Worktree release failed for ${ex.id}: ${message}`);
            }
          }
        }
      }),
    );

    if (anyFailed) {
      return { success: false, taskId, error: failures.join("; ") };
    }
    return { success: true, taskId };
  }

  // ─── Designer / plan ────────────────────────────────────────────────────

  private async awaitPlan(
    slot: number,
    agentId: string,
    taskId: string,
  ): Promise<Plan> {
    const planEvent = this.bus.once(
      { kind: "plan_emitted", task_id: taskId },
      this.designerTimeoutMs,
    );
    const doneEvent = this.bus.once(
      { kind: "done", slot, task_id: taskId },
      this.designerTimeoutMs,
    );

    let winner: AgentEvent;
    try {
      winner = await Promise.race([planEvent, doneEvent]);
    } catch (err) {
      this.registry.markError(agentId);
      throw err instanceof Error
        ? err
        : new Error(`Designer timed out without emitting a plan`);
    }

    if (winner.kind === "plan_emitted" && winner.payload) {
      return parsePlan(winner.payload);
    }

    const output = await this.capturePaneOutput(slot);
    try {
      return extractEmittedPlan(output);
    } catch (err) {
      this.registry.markError(agentId);
      throw err;
    }
  }

  private async buildConsolidationSummaries(
    executors: SpawnedExecutor[],
  ): Promise<string[]> {
    const summaries: string[] = [];
    for (const ex of executors) {
      if (ex.briefOutput !== undefined) {
        summaries.push(
          `=== ${ex.id} (${ex.planRole}) Results ===\n${ex.briefOutput}`,
        );
        continue;
      }
      const output = await this.capturePaneOutput(ex.slot);
      const lastLines = output
        .split("\n")
        .filter((l) => l.trim())
        .slice(-30)
        .join("\n");
      summaries.push(`=== ${ex.id} (${ex.planRole}) Results ===\n${lastLines}`);
    }
    return summaries;
  }

  // ─── Executor lifecycle ─────────────────────────────────────────────────

  private async spawnExecutor(
    planAgent: PlanAgent,
    taskId: string,
  ): Promise<SpawnedExecutor | null> {
    if (isResearcherRole(planAgent.role)) {
      const detour: ResearcherExecutor | null = await runResearcherDetour(
        planAgent,
        taskId,
        {
          registry: this.registry,
          bus: this.bus,
          briefStore: this.briefStore,
          runResearch: this.runResearchFn,
          allocateVirtualSlot: (agentId) => {
            const slot = -(this.agentIds.size + 1);
            this.agentIds.set(slot, agentId);
            return slot;
          },
        },
      );
      return detour;
    }

    const { role, ok } = resolvePlanRole(planAgent.role);
    if (!ok) {
      console.warn(`[CortexOS] Plan role "${planAgent.role}" is not a known AgentRole; mapping to ${role}`);
    }

    const def = getRoleDefinition(role);
    const provider: AgentProvider = def.defaultProvider;
    const agentId = nextAgentId(role);

    let worktreePath: string | undefined;
    let worktreeBranch: string | null = planAgent.worktree ?? null;
    if (this.worktreeManager) {
      try {
        const info = await this.worktreeManager.allocate(agentId);
        worktreePath = info.path;
        worktreeBranch = info.branch;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[CortexOS] Worktree allocation failed for ${agentId}: ${message}. Falling back to default working dir.`);
      }
    }

    const slot = await this.controller.spawnAgent(
      role,
      provider,
      undefined,
      worktreePath,
    );
    this.agentIds.set(slot, agentId);

    this.registry.spawn({
      id: agentId,
      role: planAgent.role,
      color: planAgent.color,
      tmux_session: sessionNameForSlot(this.controller, slot),
      worktree: worktreeBranch,
      task_id: taskId,
    });
    this.registry.markRunning(agentId);

    await this.openTerminal(slot, agentId, role);
    await this.waitForReady(slot);
    await this.controller.sendMessage(slot, buildExecutorPrompt(planAgent));

    console.log(`[CortexOS] ${agentId} (${def.displayName}) → slot ${slot} [plan-role="${planAgent.role}", color=${planAgent.color}]`);

    return { slot, id: agentId, role, planRole: planAgent.role, agent: planAgent };
  }

  private async awaitExecutorsDone(
    executors: SpawnedExecutor[],
    taskId: string,
  ): Promise<void> {
    await Promise.all(
      executors.map(async (ex) => {
        if (ex.briefOutput !== undefined) return;
        let terminal: "done" | "error" | "standby" = "done";
        try {
          const event = await this.bus.once(
            { kind: "done", slot: ex.slot, task_id: taskId },
            this.doneTimeoutMs,
          );
          const payload =
            typeof event.payload === "object" && event.payload !== null
              ? (event.payload as { success?: boolean })
              : {};
          if (payload.success === false) {
            this.registry.markError(ex.id);
            console.error(`[CortexOS] ${ex.id} reported failure on done event.`);
            terminal = "error";
          } else {
            const policy =
              ex.agent.depends_on.length > 0
                ? "done"
                : inferDonePolicy(ex.agent);
            if (policy === "standby") {
              this.registry.markStandby(ex.id);
              terminal = "standby";
            } else {
              this.registry.markDone(ex.id);
              terminal = "done";
            }
            console.log(`[CortexOS] ${ex.id} → ${policy}.`);
          }
        } catch (err) {
          this.registry.markError(ex.id);
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[CortexOS] ${ex.id} did not emit 'done' in time: ${message}`);
          terminal = "error";
        }
        if (
          this.worktreeManager &&
          (terminal === "done" || terminal === "error")
        ) {
          try {
            await this.worktreeManager.release(ex.id);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[CortexOS] Worktree release failed for ${ex.id}: ${message}`);
          }
        }
      }),
    );
  }

  // ─── Pane helper wrappers (override-aware, delegate to pane-helpers.ts) ──

  private async openTerminal(
    slot: number,
    agentId: string,
    role: AgentRole,
  ): Promise<void> {
    if (this.openTerminalOverride) return this.openTerminalOverride(slot, agentId, role);
    return openAgentTerminal(this.controller, slot, agentId, role);
  }

  private async waitForReady(slot: number): Promise<void> {
    if (this.readyOverride) return this.readyOverride(slot);
    return waitForPaneReady(this.controller, this.tmux, slot);
  }

  private async capturePaneOutput(slot: number): Promise<string> {
    if (this.captureOverride) return this.captureOverride(slot);
    return captureSlotPane(this.controller, this.tmux, slot);
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function buildExecutorPrompt(planAgent: PlanAgent): string {
  const header = planAgent.system_prompt
    ? `${planAgent.system_prompt}\n\n`
    : "";
  return (
    `${header}Task: ${planAgent.task}\n\n` +
    `Success criteria: ${planAgent.success_criteria}\n` +
    `Budget: up to ${planAgent.budget.max_tokens} tokens, ${planAgent.budget.max_minutes} minutes.\n` +
    (planAgent.depends_on.length
      ? `Depends on: ${planAgent.depends_on.join(", ")}\n`
      : "") +
    (planAgent.worktree ? `Worktree: ${planAgent.worktree}\n` : "")
  );
}

function inferDonePolicy(_planAgent: PlanAgent): "done" | "standby" {
  return "done";
}
