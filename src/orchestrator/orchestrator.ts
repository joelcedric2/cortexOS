import type { CortexController } from "../controller/cortex.js";
import type { TmuxManager } from "../tmux/tmux-manager.js";
import { nextAgentId, getRoleDefinition } from "../agents/roles.js";
import type { AgentRole } from "../agents/roles.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

/**
 * CortexOS Orchestrator — the brain.
 *
 * Flow:
 *  1. User gives a task
 *  2. RES0 (Researcher/System Designer) is spawned in slot 0, receives the task
 *  3. RES0 analyzes, researches, produces a plan
 *  4. Orchestrator parses RES0's plan output for agent assignments
 *  5. Executing agents are spawned with specific tasks from RES0's plan
 *  6. Executors work in parallel, visible in their own terminals
 *  7. When done, executors report back. RES0 consolidates.
 */
export class Orchestrator {
  private agentIds: Map<number, string> = new Map(); // slot -> agent ID like "RES0", "SET0"

  constructor(
    private readonly controller: CortexController,
    private readonly tmux: TmuxManager,
  ) {}

  async execute(task: string): Promise<void> {
    console.log(`\n[CortexOS] Received task: "${task}"`);

    // Phase 1: Spawn RES0 (Researcher/System Designer) — always slot 0
    console.log("[CortexOS] Phase 1: Spawning RES0 (Researcher & System Designer)...\n");

    const res0Id = nextAgentId("system-designer");
    const res0Slot = await this.controller.spawnAgent("system-designer", "claude", 0);
    this.agentIds.set(res0Slot, res0Id);

    await this.openTerminal(res0Slot, res0Id, "system-designer");

    // Wait for RES0 to be ready, then send the planning prompt
    await this.waitForReady(res0Slot);

    const planningPrompt = this.buildPlanningPrompt(task);
    await this.controller.sendMessage(res0Slot, planningPrompt);
    console.log(`[CortexOS] ${res0Id} received task. Analyzing and planning...\n`);

    // Wait for RES0 to finish planning
    await this.waitForCompletion([res0Slot], 120_000);

    // Phase 2: Read RES0's plan and spawn executors
    console.log("\n[CortexOS] Phase 2: Parsing RES0's plan and spawning executors...\n");

    const planOutput = await this.captureAgentOutput(res0Slot);
    const assignments = this.parseAssignments(planOutput, task);

    if (assignments.length === 0) {
      console.log("[CortexOS] RES0 handled the task directly. No executors needed.");
      return;
    }

    // Spawn executors in parallel
    const executors: { slot: number; id: string; role: AgentRole }[] = [];

    for (const assignment of assignments) {
      const agentId = nextAgentId(assignment.role);
      const slot = await this.controller.spawnAgent(assignment.role, assignment.provider);
      this.agentIds.set(slot, agentId);
      executors.push({ slot, id: agentId, role: assignment.role });

      await this.openTerminal(slot, agentId, assignment.role);
      await this.waitForReady(slot);
      await this.controller.sendMessage(slot, assignment.prompt);

      console.log(`[CortexOS] ${agentId} (${getRoleDefinition(assignment.role).displayName}) → slot ${slot}`);
    }

    // Phase 3: Monitor executors
    console.log(`\n[CortexOS] Phase 3: ${executors.length} executor(s) working...\n`);
    await this.waitForCompletion(
      executors.map((e) => e.slot),
      300_000,
    );

    // Phase 4: Have RES0 consolidate results
    console.log("\n[CortexOS] Phase 4: RES0 consolidating results...\n");

    const summaries: string[] = [];
    for (const ex of executors) {
      const output = await this.captureAgentOutput(ex.slot);
      const lastLines = output.split("\n").filter((l) => l.trim()).slice(-30).join("\n");
      summaries.push(`=== ${ex.id} (${ex.role}) Results ===\n${lastLines}`);
    }

    const consolidationPrompt = `The following agents completed their work. Consolidate their findings into a final report:\n\n${summaries.join("\n\n")}`;
    await this.controller.sendMessage(res0Slot, consolidationPrompt);

    console.log("[CortexOS] All phases complete. Terminals remain open for review.\n");
  }

  private buildPlanningPrompt(task: string): string {
    return `You are RES0, the Researcher & System Designer for CortexOS.

You have been given this task: "${task}"

Analyze the task and create a plan. Your output MUST end with an ASSIGNMENTS block that tells CortexOS which specialist agents to spawn. Use this exact format:

---ASSIGNMENTS---
ROLE: <role-name> | TASK: <specific task for this agent>
ROLE: <role-name> | TASK: <specific task for this agent>
---END---

Available roles: frontend, backend, security, e2e-tester, internal-apis, cicd, devops-mlops, ai-ml-researcher, visual-tester, security-reviewer, pen-tester

Agent short codes for reference:
FDD=Frontend, BKD=Backend, SET=Security, PET=PenTester, E2E=E2ETester, API=InternalAPIs, CCD=CI/CD, DVO=DevOps, MLR=ML Researcher, VIT=VisualTester, SRV=SecurityReviewer

First research and analyze the task, then output your plan with the ASSIGNMENTS block.`;
  }

  private parseAssignments(
    output: string,
    fallbackTask: string,
  ): { role: AgentRole; prompt: string; provider?: "claude" | "gemini" | "codex" }[] {
    const assignments: { role: AgentRole; prompt: string; provider?: "claude" | "gemini" | "codex" }[] = [];

    // Try to parse structured assignments from RES0's output
    const assignmentBlock = output.match(/---ASSIGNMENTS---\s*([\s\S]*?)\s*---END---/);
    if (assignmentBlock) {
      const lines = assignmentBlock[1].split("\n").filter((l) => l.trim());
      for (const line of lines) {
        const match = line.match(/ROLE:\s*(\S+)\s*\|\s*TASK:\s*(.+)/i);
        if (match) {
          const role = match[1].trim() as AgentRole;
          const prompt = match[2].trim();
          const def = getRoleDefinition(role);
          if (def) {
            assignments.push({ role, prompt, provider: def.defaultProvider });
          }
        }
      }
    }

    // Fallback: if RES0 didn't produce structured output, infer from task
    if (assignments.length === 0) {
      const lower = fallbackTask.toLowerCase();
      if (lower.includes("vulnerab") || lower.includes("security") || lower.includes("audit")) {
        assignments.push(
          { role: "security", prompt: `Security audit: ${fallbackTask}` },
          { role: "pen-tester", prompt: `Penetration test: ${fallbackTask}` },
        );
      } else if (lower.includes("build") || lower.includes("implement")) {
        assignments.push(
          { role: "backend", prompt: `Implement backend: ${fallbackTask}` },
          { role: "frontend", prompt: `Implement frontend: ${fallbackTask}` },
        );
      } else {
        // Single agent fallback
        assignments.push({ role: "backend", prompt: fallbackTask });
      }
    }

    // Limit to available slots (max 3 rotating)
    return assignments.slice(0, 3);
  }

  private async openTerminal(slot: number, agentId: string, role: AgentRole): Promise<void> {
    const handle = (this.controller as any).handles.get(slot);
    if (!handle) return;

    const sessionName = `cortexos_${handle.sessionName}`;
    const def = getRoleDefinition(role);
    const title = `${agentId} (${def.displayName})`;

    try {
      await execFileAsync("osascript", [
        "-e",
        `tell application "Terminal"
          activate
          do script "printf '\\\\e]0;${title}\\\\a' && tmux attach-session -t ${sessionName}"
        end tell`,
      ]);
      console.log(`[CortexOS] Terminal opened: ${title}`);
    } catch (err) {
      console.log(`[CortexOS] Could not open terminal: ${err}`);
    }
  }

  private async waitForReady(slot: number): Promise<void> {
    const handle = (this.controller as any).handles.get(slot);
    if (!handle) return;

    const maxWait = 50_000;
    const interval = 2_000;
    let waited = 0;

    while (waited < maxWait) {
      try {
        const output = await this.tmux.capturePane(handle.sessionName);
        if (output.includes("❯") && !output.includes("Enter to confirm")) {
          return;
        }
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, interval));
      waited += interval;
    }
  }

  private async captureAgentOutput(slot: number): Promise<string> {
    const handle = (this.controller as any).handles.get(slot);
    if (!handle) return "";
    return this.tmux.capturePane(handle.sessionName, 500);
  }

  /**
   * Wait for agents to finish by checking if their Claude Code prompt (❯) is idle.
   * An agent is "done" when we see ❯ at the end of its output AND
   * the output hasn't changed for several consecutive polls.
   */
  private async waitForCompletion(slots: number[], maxWait: number): Promise<void> {
    const stableThreshold = 4;
    const pollInterval = 5_000;
    const stableCounts = new Map<number, number>();
    const lastHashes = new Map<number, string>();
    const hasStarted = new Map<number, boolean>();

    for (const s of slots) {
      stableCounts.set(s, 0);
      lastHashes.set(s, "");
      hasStarted.set(s, false);
    }

    // Initial delay for agents to start producing output
    await new Promise((r) => setTimeout(r, 20_000));

    let waited = 20_000;
    while (waited < maxWait) {
      let allDone = true;

      for (const slot of slots) {
        const handle = (this.controller as any).handles.get(slot);
        if (!handle) { stableCounts.set(slot, stableThreshold); continue; }

        try {
          const output = await this.tmux.capturePane(handle.sessionName, 50);
          const hash = createHash("sha256").update(output).digest("hex");

          // Check if agent has started working (output changed from initial)
          if (hash !== lastHashes.get(slot) && lastHashes.get(slot) !== "") {
            hasStarted.set(slot, true);
          }

          if (hash === lastHashes.get(slot)) {
            stableCounts.set(slot, (stableCounts.get(slot) ?? 0) + 1);
          } else {
            stableCounts.set(slot, 0);
            lastHashes.set(slot, hash);
          }

          // Agent is done when: output is stable AND it has started AND
          // the last line shows the ❯ prompt (Claude finished and is waiting)
          const lines = output.split("\n").filter((l) => l.trim());
          const lastLine = lines[lines.length - 1] ?? "";
          const hasPrompt = lastLine.includes("❯") || lastLine.includes("bypass permissions");
          const isStable = (stableCounts.get(slot) ?? 0) >= stableThreshold;
          const started = hasStarted.get(slot) ?? false;

          if (!(started && isStable && hasPrompt)) {
            allDone = false;
          }
        } catch {
          stableCounts.set(slot, stableThreshold);
        }
      }

      if (allDone) {
        console.log("\n[CortexOS] All agents finished.");
        return;
      }

      await new Promise((r) => setTimeout(r, pollInterval));
      waited += pollInterval;

      const parts = slots.map((s) => {
        const id = this.agentIds.get(s) ?? `slot${s}`;
        const stable = (stableCounts.get(s) ?? 0) >= stableThreshold;
        const started = hasStarted.get(s) ?? false;
        const status = !started ? "starting" : stable ? "done" : "working";
        return `${id}:${status}`;
      });
      process.stdout.write(`\r[CortexOS] ${parts.join(" | ")}  `);
    }
    console.log("\n[CortexOS] Timed out.");
  }
}
