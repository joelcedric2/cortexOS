/**
 * Temporary stub for Agent A's `src/research/research-loop.ts` +
 * `src/research/brief-schema.ts` (Phase 2.5 — those modules live on
 * `phase2.5/research-loop` and haven't merged to `main` yet).
 *
 * At integration time, delete this file and switch imports to the real
 * modules. The exported names + shapes match Agent A's contract verbatim
 * so consumers don't need to change.
 *
 * Contract frozen per §2.3 of docs/NCHINDA_PLAN.md.
 */
import type { EventBus } from "../ipc/event-bus.js";

export interface Hypothesis {
  id: string;
  claim: string;
  evidence_for: string[];
  evidence_against: string[];
  confidence: number;
}

export interface Brief {
  question: string;
  hypotheses: Hypothesis[];
  winning?: string;
  evidence: string[];
  open_questions: string[];
  recommended_action: string;
  confidence: number;
  cost_tokens?: number;
  cost_seconds?: number;
}

export interface ResearchOptions {
  depth?: "normal" | "deep";
  bus?: EventBus;
  task_id?: string;
}

/**
 * Stubbed `runResearch` — returns a deterministic, clearly-marked-as-stub
 * Brief so downstream wiring + tests can exercise the whole flow without
 * pulling in Agent A's branch. Real implementation lives on
 * `phase2.5/research-loop` and will replace this file on merge.
 */
export async function runResearch(
  question: string,
  _opts?: ResearchOptions,
): Promise<Brief> {
  return {
    question,
    hypotheses: [],
    winning: undefined,
    evidence: [],
    open_questions: [
      "Stub runResearch invoked — real research-loop not yet merged",
    ],
    recommended_action:
      "Replace src/research/_research-stub.ts with Agent A's research-loop on integration",
    confidence: 0,
    cost_tokens: 0,
    cost_seconds: 0,
  };
}
