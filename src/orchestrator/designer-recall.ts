/**
 * Designer prior-research recall + prompt injection — extracted from
 * `orchestrator.ts` so the main class stays under the 500-LOC budget
 * (CLAUDE.md project rule).
 *
 * On every new run, the Orchestrator asks the `BriefStore` for Briefs whose
 * questions are semantically similar to the incoming task, formats the
 * top matches as a `## Relevant prior research` section, and splices it
 * into the Designer's planning prompt so RES0 can re-use past conclusions
 * instead of repeating research from scratch.
 *
 * The behavior is preserved verbatim from the pre-split code path —
 * `buildPriorResearchSection` + `buildPlanningPrompt` live here now, and
 * the Orchestrator's `execute(task)` calls `buildDesignerPromptWithRecall`.
 */
import { EMIT_PLAN_PROMPT_FRAGMENT } from "../agents/claude-agent.js";
import type { BriefStore } from "../research/brief-store.js";

export interface DesignerPromptDeps {
  /** Optional — when absent, no prior-research section is injected. */
  briefStore?: BriefStore;
}

/**
 * Build the Designer's full planning prompt, including (if available) a
 * "Relevant prior research" block sourced from the BriefStore.
 *
 * Pure function except for BriefStore recall I/O; errors from recall are
 * swallowed + logged so a flaky vector store never blocks planning.
 */
export async function buildDesignerPromptWithRecall(
  task: string,
  taskId: string,
  deps: DesignerPromptDeps,
): Promise<string> {
  const priorResearch = await buildPriorResearchSection(task, deps);
  const header =
    `You are RES0, the Researcher & System Designer for CortexOS.\n\n` +
    `Task ID: ${taskId}\n` +
    `Goal: "${task}"\n\n`;
  const recallSection = priorResearch ? `${priorResearch}\n\n` : "";
  return (
    `${header}${recallSection}` +
    `Analyze the task, then emit a structured execution Plan.\n\n` +
    `${EMIT_PLAN_PROMPT_FRAGMENT}\n\n` +
    `Available example roles (not exhaustive — coin new ones if useful): ` +
    `coder, frontend, backend, tester, e2e-tester, pentester, security, ` +
    `researcher, operator, devops, cicd. The Plan's agents[].role field is free-form text.`
  );
}

/**
 * Look up prior research Briefs similar to the incoming task and format
 * them as a "## Relevant prior research" block. Empty string when the
 * BriefStore is absent or no Briefs clear the 0.5 similarity threshold.
 */
export async function buildPriorResearchSection(
  task: string,
  deps: DesignerPromptDeps,
): Promise<string> {
  if (!deps.briefStore) return "";
  let matches;
  try {
    matches = await deps.briefStore.recall(task, 3, 0.5);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[CortexOS] Brief recall failed: ${message}`);
    return "";
  }
  if (matches.length === 0) return "";
  const lines = matches.map(({ brief }) => {
    const winner = brief.winning ?? "inconclusive";
    return (
      `- Q: ${brief.question}\n` +
      `  Winner: ${winner} (confidence ${brief.confidence})\n` +
      `  Recommendation: ${brief.recommended_action}`
    );
  });
  return `## Relevant prior research\n\n${lines.join("\n")}`;
}
