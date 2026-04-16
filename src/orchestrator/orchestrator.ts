import type { CortexController } from "../controller/cortex.js";
import type { TmuxManager } from "../tmux/tmux-manager.js";
import { nextAgentId, getRoleDefinition, isValidRole } from "../agents/roles.js";
import type { AgentRole } from "../agents/roles.js";
import type { AgentProvider } from "../agents/agent.js";
import { extractEmittedPlan } from "../agents/claude-agent.js";
import {
  parsePlan,
  type Plan,
  type PlanAgent,
} from "./plan-schema.js";
import {
  AgentRegistry,
  getAgentRegistry,
} from "../registry/agent-registry.js";
import {
  createEventBus,
  type AgentEvent,
  type EventBus,
} from "../ipc/event-bus.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

const DEFAULT_DONE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per agent
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
  /** Override the process-wide registry. Primarily for tests. */
  registry?: AgentRegistry;
  /** Override the event bus. Production should use the real IPC-backed bus. */
  bus?: EventBus;
  /** Hook for capturing Designer output — injectable for tests. */
  capturePaneOutput?: (slot: number) => Promise<string>;
  /** Hook for waiting until a spawned CLI is at its ❯ prompt. Injectable. */
  waitForReady?: (slot: number) => Promise<void>;
  /** Hook for opening a user-visible Terminal window attached to a pane. Injectable for tests. */
  openTerminal?: (slot: number, agentId: string, role: AgentRole) => Promise<void>;
  /** Per-agent `done` timeout in ms. Default 10 minutes. */
  doneTimeoutMs?: number;
  /** Designer planning timeout in ms. Default 10 minutes. */
  designerTimeoutMs?: number;
  /**
   * Persistence layer for research Briefs. Used when a PlanAgent's role is
   * "researcher" — we run research in-process (no tmux pane) and persist
   * the resulting Brief so future Designer runs can recall it.
   */
  briefStore?: BriefStore;
  /**
   * Injectable override for the research function. Defaults to
   * `runResearch` from `src/research/research-loop.ts` (the real H→P→R→B
   * loop). Tests mock this.
   */
  runResearch?: typeof runResearch;
  /**
   * Phase 3 (Nchinda §6): optional git-worktree allocator. When wired,
   * every spawned executor gets an isolated `agent/<agentId>` branch
   * checked out at the manager's root dir, and that path becomes the
   * pane's working directory. When omitted the Orchestrator preserves
   * the legacy controller-owned `.cortexos-agents/<session>` layout.
   */
  worktreeManager?: WorktreeManager;
}

interface SpawnedExecutor {
  slot: number;
  id: string;
  role: AgentRole;
  planRole: string;
  agent: PlanAgent;
  /**
   * Output produced in-process (no tmux). Set by the researcher-role
   * detour; when present, phase-4 `done` waiting and phase-5 pane capture
   * are skipped for this executor.
   */
  briefOutput?: string;
}

/**
 * CortexOS Orchestrator — the brain (Phase 1 rewrite, Nchinda §6 Phase 1).
 *
 * Flow:
 *  1. User gives a task.
 *  2. RES0 (system-designer) is spawned in slot 0 and asked to call `emit_plan`.
 *  3. Orchestrator parses the structured Plan JSON (loud failure on drift).
 *  4. Executors are spawned per Plan; each gets a registry row (markRunning).
 *  5. Orchestrator waits on `done` events via the EventBus — no polling.
 *  6. Each done event transitions the registry; standby vs done follows policy.
 *  7. RES0 consolidates (reporting_to agent).
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

    // ── Phase 1: Designer (RES0) ───────────────────────────────────────────
    console.log(
      "[CortexOS] Phase 1: Spawning RES0 (Researcher & System Designer)...\n",
    );

    const designerRole: AgentRole = "system-designer";
    const res0Id = nextAgentId(designerRole);
    const res0Slot = await this.controller.spawnAgent(
      designerRole,
      "claude",
      0,
    );
    this.agentIds.set(res0Slot, res0Id);

    // Register the Designer before the CLI emits anything so later events
    // landing on the bus can always find it.
    this.registry.spawn({
      id: res0Id,
      role: designerRole,
      color: "cyan",
      tmux_session: this.sessionNameForSlot(res0Slot),
      task_id: taskId,
    });
    this.registry.markRunning(res0Id);

    await this.openTerminal(res0Slot, res0Id, designerRole);
    await this.waitForReady(res0Slot);

    const planningPrompt = await buildDesignerPromptWithRecall(task, taskId, {
      briefStore: this.briefStore,
    });
    await this.controller.sendMessage(res0Slot, planningPrompt);
    console.log(
      `[CortexOS] ${res0Id} received task. Analyzing and planning...\n`,
    );

    // ── Phase 2: Wait for the plan, parse it ───────────────────────────────
    const plan = await this.awaitPlan(res0Slot, res0Id, taskId);

    if (plan.complexity === "single-shot" || plan.agents.length === 0) {
      console.log(
        "[CortexOS] Designer handled the task directly (single-shot). No executors needed.",
      );
      this.registry.markDone(res0Id);
      return;
    }

    // ── Phase 3: Spawn executors per Plan ──────────────────────────────────
    console.log(
      `\n[CortexOS] Phase 3: Spawning ${plan.agents.length} executor(s) from Plan...\n`,
    );

    const executors: SpawnedExecutor[] = [];
    for (const planAgent of plan.agents) {
      const executor = await this.spawnExecutor(planAgent, taskId);
      if (executor) executors.push(executor);
    }

    if (executors.length === 0) {
      console.log(
        "[CortexOS] Plan contained no executable agents after role validation. Aborting.",
      );
      this.registry.markError(res0Id);
      return;
    }

    // ── Phase 4: Event-driven wait on `done` ───────────────────────────────
    console.log(
      `\n[CortexOS] Phase 4: awaiting 'done' events for ${executors.length} executor(s)...\n`,
    );

    await this.awaitExecutorsDone(executors, taskId);

    // ── Phase 5: Consolidation ─────────────────────────────────────────────
    console.log("\n[CortexOS] Phase 5: Designer consolidating results...\n");

    const summaries: string[] = [];
    for (const ex of executors) {
      // Researcher detour: skip pane capture, use the Brief's recommended
      // action directly (no tmux session existed for this slot).
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

    const reportingTarget = plan.coordination.reporting_to;
    const consolidationPrompt =
      `The following agents completed their work on task ${taskId}. ` +
      `You (${reportingTarget}) are the reporting target — consolidate their ` +
      `findings into a final report:\n\n${summaries.join("\n\n")}`;
    await this.controller.sendMessage(res0Slot, consolidationPrompt);

    this.registry.markDone(res0Id);
    console.log(
      "[CortexOS] All phases complete. Terminals remain open for review.\n",
    );
  }

  /** Exposed for tests and call-sites that already have Plan JSON. */
  parsePlanJson(json: unknown): Plan {
    return parsePlan(json);
  }

  /**
   * Single-attempt execution path used by the AutonomyLoop (Phase 2).
   *
   * Given a pre-built Plan and task_id, this spawns the Plan's executors,
   * waits for their `done` events, and returns a structured result instead
   * of driving the full Designer → executors → consolidation pipeline.
   *
   * The Designer is intentionally not involved here — the loop's caller has
   * already decided on a Plan (either from a cache, a previous attempt, or
   * a fallback strategy). `execute(task)` remains the production entry point
   * for the "cold start, run Designer" path.
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
        // Researcher detour already finished in-process; no `done` event
        // will ever arrive for it. Registry was already transitioned.
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
          // Phase 3 teardown: `executeOnce` always drives to a terminal
          // outcome (no standby heuristic here), so release whenever we
          // had a manager wired and reached terminal.
          if (this.worktreeManager && reachedTerminal) {
            try {
              await this.worktreeManager.release(ex.id);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.warn(
                `[CortexOS] Worktree release failed for ${ex.id}: ${message}`,
              );
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

  // ─── Designer / plan ───────────────────────────────────────────────────────

  /**
   * Wait for the Designer to emit a Plan. Prefers a `plan_emitted` bus event
   * (Agent A's Stop/PreCompact hook is expected to push one). Falls back to
   * the Designer's own `done` event and scrapes the pane for the emit_plan
   * block if the richer signal didn't land.
   */
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

    // If the Designer sent a plan directly in the event payload, prefer it.
    if (winner.kind === "plan_emitted" && winner.payload) {
      return parsePlan(winner.payload);
    }

    // Otherwise, read the Designer's pane and extract the emit_plan block.
    const output = await this.capturePaneOutput(slot);
    try {
      return extractEmittedPlan(output);
    } catch (err) {
      this.registry.markError(agentId);
      throw err;
    }
  }

  // ─── Executor lifecycle ──────────────────────────────────────────────────

  private async spawnExecutor(
    planAgent: PlanAgent,
    taskId: string,
  ): Promise<SpawnedExecutor | null> {
    // Researcher roles don't get a tmux pane — they run research in-process
    // via `runResearch`, persist the Brief, and return a virtual executor
    // whose `briefOutput` feeds the Designer's phase-5 consolidation.
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

    // Map the open-ended Plan role onto a known AgentRole. If we don't
    // recognize it, fall back to `backend` (the "generic coder" role) so
    // the Designer can still emit new role names (e.g. "ui-ux") without
    // blowing up the run, but log loudly for observability.
    const { role, ok } = resolvePlanRole(planAgent.role);
    if (!ok) {
      console.warn(
        `[CortexOS] Plan role "${planAgent.role}" is not a known AgentRole; mapping to ${role}`,
      );
    }

    const def = getRoleDefinition(role);
    const provider: AgentProvider = def.defaultProvider;

    const agentId = nextAgentId(role);

    // Phase 3 (Nchinda §6): allocate a dedicated git worktree BEFORE the
    // tmux session is created so the pane starts in the agent's own
    // `agent/<agentId>` branch checkout. If allocation fails we log and
    // fall back to the controller's legacy `.cortexos-agents` path so a
    // flaky git doesn't block the whole run.
    let worktreePath: string | undefined;
    let worktreeBranch: string | null = planAgent.worktree ?? null;
    if (this.worktreeManager) {
      try {
        const info = await this.worktreeManager.allocate(agentId);
        worktreePath = info.path;
        worktreeBranch = info.branch;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[CortexOS] Worktree allocation failed for ${agentId}: ${message}. Falling back to default working dir.`,
        );
      }
    }

    const slot = await this.controller.spawnAgent(
      role,
      provider,
      undefined,
      worktreePath,
    );
    this.agentIds.set(slot, agentId);

    const sessionName = this.sessionNameForSlot(slot);

    this.registry.spawn({
      id: agentId,
      role: planAgent.role,
      color: planAgent.color,
      tmux_session: sessionName,
      worktree: worktreeBranch,
      task_id: taskId,
    });
    this.registry.markRunning(agentId);

    await this.openTerminal(slot, agentId, role);
    await this.waitForReady(slot);
    await this.controller.sendMessage(slot, this.buildExecutorPrompt(planAgent));

    console.log(
      `[CortexOS] ${agentId} (${def.displayName}) → slot ${slot} [plan-role="${planAgent.role}", color=${planAgent.color}]`,
    );

    return { slot, id: agentId, role, planRole: planAgent.role, agent: planAgent };
  }

  private buildExecutorPrompt(planAgent: PlanAgent): string {
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

  /**
   * Event-driven replacement for the old `waitForCompletion` polling loop.
   *
   * Subscribes once per executor to `{kind:'done', slot, task_id}` with a
   * 10-minute timeout (per agent, run in parallel). On receipt, transitions
   * the registry per `coordination.checkpoints` policy:
   *
   *  - if the plan says `checkpoints` includes "on_step_complete" → markDone
   *  - otherwise → markStandby (keep the session warm for follow-up)
   *
   * Errors land as `markError`; timeouts are treated as errors as well.
   */
  private async awaitExecutorsDone(
    executors: SpawnedExecutor[],
    taskId: string,
  ): Promise<void> {
    await Promise.all(
      executors.map(async (ex) => {
        // Researcher detour already completed in-process — no `done` event
        // will arrive from a tmux pane that was never created.
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
            console.error(
              `[CortexOS] ${ex.id} reported failure on done event.`,
            );
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
          console.error(
            `[CortexOS] ${ex.id} did not emit 'done' in time: ${message}`,
          );
          terminal = "error";
        }
        // Phase 3 teardown: release the worktree only on terminal states.
        // `standby` keeps the working copy live for potential follow-up
        // work; `done`/`error` let us reclaim disk by removing the
        // worktree dir + branch.
        if (
          this.worktreeManager &&
          (terminal === "done" || terminal === "error")
        ) {
          try {
            await this.worktreeManager.release(ex.id);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
              `[CortexOS] Worktree release failed for ${ex.id}: ${message}`,
            );
          }
        }
      }),
    );
  }

  // ─── Terminal / pane helpers ────────────────────────────────────────────

  private sessionNameForSlot(slot: number): string {
    const handle = (this.controller as unknown as {
      handles: Map<number, { sessionName: string }>;
    }).handles.get(slot);
    return handle?.sessionName ?? `slot${slot}`;
  }

  private async openTerminal(
    slot: number,
    agentId: string,
    role: AgentRole,
  ): Promise<void> {
    if (this.openTerminalOverride) return this.openTerminalOverride(slot, agentId, role);

    const sessionName = this.sessionNameForSlot(slot);
    if (!sessionName) return;

    const attachName = `cortexos_${sessionName}`;
    const def = getRoleDefinition(role);
    const title = `${agentId} (${def.displayName})`;

    try {
      await execFileAsync("osascript", [
        "-e",
        `tell application "Terminal"
          activate
          do script "printf '\\\\e]0;${title}\\\\a' && tmux attach-session -t ${attachName}"
        end tell`,
      ]);
      console.log(`[CortexOS] Terminal opened: ${title}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[CortexOS] Could not open terminal: ${message}`);
    }
  }

  private async waitForReady(slot: number): Promise<void> {
    if (this.readyOverride) return this.readyOverride(slot);

    const sessionName = this.sessionNameForSlot(slot);
    if (!sessionName) return;

    const maxWait = 50_000;
    const interval = 2_000;
    let waited = 0;

    while (waited < maxWait) {
      try {
        const output = await this.tmux.capturePane(sessionName);
        if (output.includes("❯") && !output.includes("Enter to confirm")) {
          return;
        }
      } catch {
        // Session not yet ready — keep polling until the overall budget is
        // exhausted. This is a startup check, not a task-completion check.
      }
      await new Promise((r) => setTimeout(r, interval));
      waited += interval;
    }
  }

  private async capturePaneOutput(slot: number): Promise<string> {
    if (this.captureOverride) return this.captureOverride(slot);
    const sessionName = this.sessionNameForSlot(slot);
    if (!sessionName) return "";
    return this.tmux.capturePane(sessionName, 500);
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Map a Plan's open-ended role string onto a known AgentRole. Unknown roles
 * fall through to `backend` (the "generic coder") so planners can introduce
 * new role names over time without requiring a code change here.
 */
function resolvePlanRole(planRole: string): { role: AgentRole; ok: boolean } {
  if (isValidRole(planRole)) return { role: planRole, ok: true };

  const aliases: Record<string, AgentRole> = {
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
  const alias = aliases[planRole.toLowerCase()];
  if (alias) return { role: alias, ok: true };

  return { role: "backend", ok: false };
}

/**
 * Policy for what to do after a `done` event. Defaults to `done`; switches to
 * `standby` only if the Plan explicitly says to keep this role warm via the
 * `keep_warm` checkpoint flag (future extension).
 */
function inferDonePolicy(_planAgent: PlanAgent): "done" | "standby" {
  // Today: always transition to `done`. Phase 2 will introduce the policy
  // engine that can keep specific roles in standby for follow-up work.
  return "done";
}
