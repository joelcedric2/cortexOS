import type { Agent, AgentConfig, AgentHandle } from "./agent.js";
import type { TmuxManager } from "../tmux/tmux-manager.js";
import { checkBinaryExists } from "./binary-check.js";
import {
  parsePlan,
  PlanValidationError,
  EMIT_PLAN_TOOL_INPUT_SCHEMA,
  type Plan,
} from "../orchestrator/plan-schema.js";

/**
 * The `emit_plan` tool contract the Designer (RES0) uses to hand a
 * structured Plan to the orchestrator. This replaces the old text-scraping
 * `---ASSIGNMENTS---` format (Nchinda plan §3.2 / §5.3).
 *
 * Claude Code CLI does not expose a first-class tool-schema injection from
 * outside the transcript, so we implement the tool as a textual protocol:
 * the Designer prints a fenced block of the form
 *
 *     <emit_plan>
 *     { ...plan JSON... }
 *     </emit_plan>
 *
 * `extractEmittedPlan` walks the pane output, pulls the **last** such
 * block (latest wins — handles a Designer that retries), and validates it
 * through `parsePlan`. Any malformed output raises a loud
 * `PlanValidationError` up the stack — we never silently fall back.
 */
export const EMIT_PLAN_TOOL = {
  name: "emit_plan",
  description:
    "Emit the final, structured execution Plan for this task. Call exactly " +
    "once when your analysis is complete. Arguments must conform to the " +
    "CortexOS Plan schema (see §5.3 of the Nchinda master plan).",
  input_schema: EMIT_PLAN_TOOL_INPUT_SCHEMA,
  /** Opening/closing textual fence the Designer wraps the JSON in. */
  open_tag: "<emit_plan>",
  close_tag: "</emit_plan>",
} as const;

const EMIT_PLAN_RE = /<emit_plan>\s*([\s\S]*?)\s*<\/emit_plan>/g;

/**
 * Scans pane output for `<emit_plan>{...}</emit_plan>` blocks, parses the
 * last one as JSON, and validates it through `parsePlan`. Throws loudly
 * if no block is found or the JSON fails validation.
 */
export function extractEmittedPlan(output: string): Plan {
  const matches = [...output.matchAll(EMIT_PLAN_RE)];
  if (matches.length === 0) {
    throw new PlanValidationError(
      "emit_plan: no <emit_plan>...</emit_plan> block found in Designer output",
      [],
    );
  }
  const raw = matches[matches.length - 1][1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PlanValidationError(
      `emit_plan: block did not contain valid JSON (${message})`,
      [],
    );
  }
  return parsePlan(parsed);
}

/**
 * System-prompt fragment the orchestrator appends to the Designer's task
 * so the model knows the exact output contract. Kept next to the tool so
 * they stay in lockstep.
 */
export const EMIT_PLAN_PROMPT_FRAGMENT = `You MUST respond with a single call to the emit_plan tool. Since the runtime exposes this tool as a textual protocol, output it exactly like this (no extra prose after the closing tag):

<emit_plan>
{
  "task_id": "<uuid>",
  "goal": "<1-line human summary>",
  "complexity": "single-shot" | "multi-agent",
  "agents": [
    {
      "role": "coder" | "tester" | "pentester" | "researcher" | "operator" | ...,
      "color": "green" | "blue" | "yellow" | "magenta" | "cyan" | "red",
      "worktree": "feature/xyz",
      "system_prompt": "optional role-specific prompt",
      "task": "specific task for this agent",
      "success_criteria": "how we know this agent is done",
      "budget": { "max_tokens": 80000, "max_minutes": 15 },
      "depends_on": []
    }
  ],
  "coordination": {
    "checkpoints": ["on_step_complete"],
    "reporting_to": "<agent role that consolidates, e.g. system-designer>"
  }
}
</emit_plan>

Do not emit any other assignment block, table, or free-text plan. Malformed emit_plan output aborts the run.`;

/**
 * Spawns and manages Claude Code CLI instances.
 * Uses `claude` CLI with --dangerously-skip-permissions for automation.
 */
export class ClaudeAgent implements Agent {
  readonly provider = "claude" as const;

  constructor(private readonly tmux: TmuxManager) {}

  async spawn(config: AgentConfig, sessionName: string): Promise<AgentHandle> {
    if (!(await checkBinaryExists("claude"))) {
      throw new Error("claude CLI is not installed. Install it first.");
    }

    // Claude Code auto-discovers CLAUDE.md in its working directory.
    // The controller writes CLAUDE.md into agentWorkDir and sets that as cwd.
    const command = "claude --dangerously-skip-permissions";

    await this.tmux.sendKeys(sessionName, command);

    // Auto-accept the bypass permissions warning screen.
    // Claude shows "1. No, exit / 2. Yes, I accept" — we need to send "2".
    await this.waitAndAcceptPermissions(sessionName);

    return {
      pid: 0,
      slot: -1,
      provider: this.provider,
      role: config.role,
      sessionName,
      startedAt: new Date(),
    };
  }

  async sendTask(handle: AgentHandle, task: string): Promise<void> {
    await this.tmux.sendKeys(handle.sessionName, task);
  }

  async readOutput(handle: AgentHandle): Promise<string> {
    return this.tmux.capturePane(handle.sessionName);
  }

  /**
   * Navigate through all startup TUI prompts (settings errors, permissions, etc.)
   * and accept/continue through each until we reach the ❯ input prompt.
   */
  private async waitAndAcceptPermissions(sessionName: string): Promise<void> {
    const maxWait = 45_000;
    const interval = 1_500;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise((r) => setTimeout(r, interval));
      waited += interval;

      try {
        const output = await this.tmux.capturePane(sessionName);

        // Check if we're at the actual input prompt (fully ready)
        // The ❯ in the input area has no "exit" or "confirm" nearby
        if (output.includes("❯") && !output.includes("Enter to confirm") && !output.includes("No, exit")) {
          return;
        }

        // Any TUI selector prompt — navigate to option 2 (continue/accept) and confirm
        if (output.includes("Enter to confirm")) {
          // Move down to option 2 (Continue/Accept) then press Enter
          await this.tmux.sendKeysRaw(sessionName, "Down");
          await new Promise((r) => setTimeout(r, 300));
          await this.tmux.sendKeysRaw(sessionName, "Enter");
          // Wait a bit for next prompt or initialization
          await new Promise((r) => setTimeout(r, 2_000));
          // Don't return — there may be more prompts. Loop again.
          continue;
        }
      } catch {
        // Session may not be fully ready
      }
    }
    console.log(`[ClaudeAgent] Warning: could not confirm ready state for ${sessionName}, proceeding`);
  }

  async stop(handle: AgentHandle): Promise<void> {
    try {
      await this.tmux.sendKeys(handle.sessionName, "/exit");
    } catch {
      // If /exit fails, force kill with Ctrl-C
      try {
        await this.tmux.sendKeys(handle.sessionName, "C-c");
      } catch {
        // Session may already be gone
      }
    }
  }
}
