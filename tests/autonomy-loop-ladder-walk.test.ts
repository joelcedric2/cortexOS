/**
 * AutonomyLoop integration test — full Resourcefulness ladder walk
 * (Nchinda §2.1, rungs 4→5→6→7).
 *
 * Scenario: a non-transient failure where rungs 4, 5, and 6 all report
 * "handled: false" (no peer, no recall, no web results). The loop must
 * walk down to rung 7 (escalate), which always handles, and the Policy
 * engine then short-circuits into an ESCALATED terminal state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AutonomyLoop } from "../src/loop/autonomy-loop.js";
import { Policy } from "../src/loop/policy.js";
import {
  AskPeerStrategy,
  RecallMemoryStrategy,
  WebSearchStrategy,
  EscalateStrategy,
} from "../src/loop/fallback-strategies.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import type {
  Orchestrator,
  OrchestratorResult,
} from "../src/orchestrator/orchestrator.js";
import type { Plan } from "../src/orchestrator/plan-schema.js";
import type {
  ClassificationResult,
  Classifier,
} from "../src/loop/types.js";

class FakeOrchestrator {
  public readonly calls: string[] = [];
  constructor(private readonly queue: OrchestratorResult[]) {}
  async executeOnce(_plan: Plan, taskId: string): Promise<OrchestratorResult> {
    this.calls.push(taskId);
    const r = this.queue.shift();
    if (!r) throw new Error("FakeOrchestrator: unexpected extra call");
    return r;
  }
  async execute(): Promise<void> {}
}

const CLASSIFY_MULTI: ClassificationResult = {
  complexity: "multi-agent",
  confidence: 0.9,
  rationale: "test",
};
class FakeClassifier implements Classifier {
  async classify(): Promise<ClassificationResult> {
    return CLASSIFY_MULTI;
  }
}

function samplePlan(taskId: string): Plan {
  return {
    task_id: taskId,
    goal: "x",
    complexity: "multi-agent",
    agents: [
      {
        role: "backend",
        color: "blue",
        task: "t",
        success_criteria: "s",
        budget: { max_tokens: 1000, max_minutes: 1 },
        depends_on: [],
      },
    ],
    coordination: { checkpoints: [], reporting_to: "system-designer" },
  };
}

test("full 4-rung walk: no-peer → no-recall → no-web → escalate", async () => {
  // One failing attempt; rungs 4/5/6 all say handled:false; rung 7 escalates.
  const orch = new FakeOrchestrator([
    { success: false, taskId: "tX", error: "unknown schema error" },
  ]);
  const bus = createEventBus();
  const registry = new AgentRegistry({ dbPath: ":memory:" });

  // Rung 4: designer is NOT in the registry → canHandle=false.
  const rung4 = new AskPeerStrategy({
    listAgents: () => [],
    askPeer: async () => ({ ok: false, reason: "no-peer" }),
  });

  // Rung 5: recall returns no usable hits.
  let recallCalls = 0;
  const rung5 = new RecallMemoryStrategy({
    recall: async () => {
      recallCalls += 1;
      return [];
    },
  });

  // Rung 6: web-search returns no results.
  let webCalls = 0;
  const rung6 = new WebSearchStrategy({
    webSearch: async () => {
      webCalls += 1;
      return [];
    },
  });

  // Rung 7: escalate. Track that it fired.
  let escalateCalls = 0;
  let escalationFlag: string | null = null;
  const rung7 = new EscalateStrategy({
    escalate: () => {
      escalateCalls += 1;
      return { escalation_id: "esc-1" };
    },
    markEscalated: (id) => {
      escalationFlag = id;
    },
  });

  const loop = new AutonomyLoop({
    orchestrator: orch as unknown as Orchestrator,
    registry,
    bus,
    policy: new Policy(),
    classifier: new FakeClassifier(),
    strategies: [rung4, rung5, rung6, rung7],
    budget: { maxAttempts: 2 },
    planFactory: async (_t, tid) => samplePlan(tid),
  });

  const result = await loop.execute("do some schema work", { task_id: "tX" });

  // Rung 7 fires (always handles), so the loop's ADAPT transition sees it.
  // With only 1 attempt budget remaining, the next iteration trips
  // budget-blown / ladder-exhausted, so the terminal state is ESCALATED.
  assert.equal(result.state, "ESCALATED");
  assert.equal(recallCalls, 1, "rung 5 was tried");
  assert.equal(webCalls, 1, "rung 6 was tried");
  assert.equal(escalateCalls, 1, "rung 7 fired as last resort");
  assert.equal(escalationFlag, "esc-1");
  // The attempts log shows the ADAPT step used the escalate strategy.
  const adapt = result.attempts.find((a) => a.strategy === "escalate");
  assert.ok(adapt, "escalate strategy appears in attempts");
  assert.equal(adapt?.rung, 7);
});
