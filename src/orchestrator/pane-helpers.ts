/**
 * Pane / terminal helpers — extracted from `orchestrator.ts` so the main
 * class stays under the 500-LOC budget (CLAUDE.md project rule).
 *
 * These wrappers isolate the platform-specific osascript Terminal opener,
 * the tmux-pane readiness poller, and pane-capture convenience, keeping
 * the Orchestrator free of child-process + macOS plumbing.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CortexController } from "../controller/cortex.js";
import type { TmuxManager } from "../tmux/tmux-manager.js";
import { getRoleDefinition } from "../agents/roles.js";
import type { AgentRole } from "../agents/roles.js";

const execFileAsync = promisify(execFile);

/** Look up the tmux session name for `slot` from the controller's handle map. */
export function sessionNameForSlot(
  controller: CortexController,
  slot: number,
): string {
  const handle = (controller as unknown as {
    handles: Map<number, { sessionName: string }>;
  }).handles.get(slot);
  return handle?.sessionName ?? `slot${slot}`;
}

/**
 * Open a user-visible Terminal.app window attached to the agent's tmux
 * session. Best-effort — logs and returns on any osascript failure.
 */
export async function openAgentTerminal(
  controller: CortexController,
  slot: number,
  agentId: string,
  role: AgentRole,
): Promise<void> {
  const sessionName = sessionNameForSlot(controller, slot);
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

/**
 * Poll the tmux pane for the CLI's `❯` prompt. Returns once seen, or after
 * `maxWaitMs` (best-effort — a missed ready signal just means the first
 * sendMessage might race the prompt, not a correctness bug).
 */
export async function waitForPaneReady(
  controller: CortexController,
  tmux: TmuxManager,
  slot: number,
  maxWaitMs = 50_000,
  intervalMs = 2_000,
): Promise<void> {
  const sessionName = sessionNameForSlot(controller, slot);
  if (!sessionName) return;

  let waited = 0;
  while (waited < maxWaitMs) {
    try {
      const output = await tmux.capturePane(sessionName);
      if (output.includes("❯") && !output.includes("Enter to confirm")) {
        return;
      }
    } catch {
      // Session not yet ready — keep polling until the overall budget is
      // exhausted. This is a startup check, not a task-completion check.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    waited += intervalMs;
  }
}

/**
 * Capture the last 500 lines of the tmux pane for a slot. Returns empty
 * string when no session is allocated to that slot.
 */
export async function captureSlotPane(
  controller: CortexController,
  tmux: TmuxManager,
  slot: number,
): Promise<string> {
  const sessionName = sessionNameForSlot(controller, slot);
  if (!sessionName) return "";
  return tmux.capturePane(sessionName, 500);
}
