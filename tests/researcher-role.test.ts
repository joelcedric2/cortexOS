import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { OrchestratorDeps } from "../src/orchestrator/orchestrator.js";
import type { Plan } from "../src/orchestrator/plan-schema.js";
import type { CortexController } from "../src/controller/cortex.js";
import type { TmuxManager } from "../src/tmux/tmux-manager.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { BriefStore } from "../src/research/brief-store.js";
import type { Brief } from "../src/research/brief-schema.js";
import type {
  MemoryRecord,
  MemorySearchResult,
} from "../src/memory/vector-store.js";

class FakeController {
  spawnCalls: Array<{ role: string; slot?: number }> = [];
  sendCalls: Array<{ slot: number; message: string }> = [];
  nextSlot = 10;

  async spawnAgent(
    role: string,
    _provider?: string,
    slot?: number,
  ): Promise<number> {
    this.spawnCalls.push({ role, slot });
    if (slot !== undefined) return slot;
    return this.nextSlot++;
  }

  async sendMessage(slot: number, message: string): Promise<void> {
    this.sendCalls.push({ slot, message });
  }

  get handles(): Map<number, { sessionName: string }> {
    const m = new Map<number, { sessionName: string }>();
    for (const c of this.spawnCalls) {
      if (typeof c.slot === "number") {
        m.set(c.slot, { sessionName: `slot${c.slot}` });
      }
    }
    return m;
  }
}

class FakeTmuxManager {
  async capturePane(_session: string, _lines?: number): Promise<string> {
    return "pane output";
  }
}

class FakeVectorStore {
  readonly rows = new Map<string, MemoryRecord>();
  private nextId = 1;
  async storeMemory(
    record: Omit<MemoryRecord, "id" | "createdAt">,
  ): Promise<string> {
    const id = `mem-${this.nextId++}`;
    this.rows.set(id, { ...record, id, createdAt: new Date() });
    return id;
  }
  async searchMemories(): Promise<MemorySearchResult[]> {
    return [];
  }
}

class FakeEmbedder {
  async embed(_text: string): Promise<number[]> {
    return new Array(384).fill(0);
  }
}

const SAMPLE_BRIEF: Brief = {
  question: "auth approach?",
  hypotheses: [],
  winning: "JWT",
  evidence: ["evidence A"],
  open_questions: [],
  recommended_action: "Use JWT with refresh tokens",
  confidence: 0.9,
};

const RESEARCHER_PLAN: Plan = {
  task_id: "T1",
  goal: "decide auth",
  complexity: "multi-agent",
  agents: [
    {
      role: "researcher",
      color: "cyan",
      task: "which auth strategy is safest?",
      success_criteria: "brief emitted",
      budget: { max_tokens: 8000, max_minutes: 5 },
      depends_on: [],
    },
  ],
  coordination: { checkpoints: ["on_step_complete"], reporting_to: "system-designer" },
};

const MIXED_PLAN: Plan = {
  task_id: "T2",
  goal: "ship auth",
  complexity: "multi-agent",
  agents: [
    {
      role: "researcher",
      color: "cyan",
      task: "pick a strategy",
      success_criteria: "brief emitted",
      budget: { max_tokens: 8000, max_minutes: 5 },
      depends_on: [],
    },
    {
      role: "coder",
      color: "blue",
      task: "implement it",
      success_criteria: "tests pass",
      budget: { max_tokens: 80_000, max_minutes: 15 },
      depends_on: [],
    },
  ],
  coordination: { checkpoints: ["on_step_complete"], reporting_to: "system-designer" },
};

function makeOrchestrator(
  deps: Partial<OrchestratorDeps> & {
    controller?: FakeController;
  } = {},
): {
  orch: Orchestrator;
  controller: FakeController;
  bus: ReturnType<typeof createEventBus>;
  registry: AgentRegistry;
} {
  const controller = deps.controller ?? new FakeController();
  const tmux = new FakeTmuxManager();
  const bus = createEventBus();
  const registry = new AgentRegistry({ dbPath: ":memory:" });
  const orch = new Orchestrator(
    controller as unknown as CortexController,
    tmux as unknown as TmuxManager,
    {
      bus,
      registry,
      capturePaneOutput: async () => "captured",
      waitForReady: async () => {},
      openTerminal: async () => {},
      doneTimeoutMs: 200,
      designerTimeoutMs: 200,
      ...deps,
    },
  );
  return { orch, controller, bus, registry };
}

describe("Orchestrator researcher-role detour", () => {
  test("calls runResearch, persists Brief, skips tmux spawn", async () => {
    const runResearch = async (_q: string) => SAMPLE_BRIEF;
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const briefStore = new BriefStore({ vectorStore: vs, embedder: emb });

    const { orch, controller } = makeOrchestrator({
      briefStore,
      runResearch,
    });

    const result = await orch.executeOnce(RESEARCHER_PLAN, "T1");
    assert.equal(result.success, true);
    assert.equal(controller.spawnCalls.length, 0);
    assert.equal(vs.rows.size, 1);
    const row = [...vs.rows.values()][0];
    assert.equal(row.taskType, "research_brief");
    const parsed = JSON.parse(row.content) as Brief;
    assert.equal(parsed.winning, "JWT");
  });

  test("passes depth=normal when max_minutes <= 3", async () => {
    const calls: Array<{ q: string; opts: unknown }> = [];
    const runResearch = async (q: string, opts: unknown) => {
      calls.push({ q, opts });
      return SAMPLE_BRIEF;
    };
    const shortPlan: Plan = {
      ...RESEARCHER_PLAN,
      agents: [
        {
          ...RESEARCHER_PLAN.agents[0],
          budget: { max_tokens: 8000, max_minutes: 2 },
        },
      ],
    };

    const { orch } = makeOrchestrator({ runResearch });
    await orch.executeOnce(shortPlan, "T1");
    assert.equal(calls.length, 1);
    assert.equal((calls[0].opts as { depth: string }).depth, "normal");
  });

  test("passes depth=deep when max_minutes > 3", async () => {
    const calls: Array<{ q: string; opts: unknown }> = [];
    const runResearch = async (q: string, opts: unknown) => {
      calls.push({ q, opts });
      return SAMPLE_BRIEF;
    };

    const { orch } = makeOrchestrator({ runResearch });
    await orch.executeOnce(RESEARCHER_PLAN, "T1");
    assert.equal(calls.length, 1);
    assert.equal((calls[0].opts as { depth: string }).depth, "deep");
  });

  test("mixed plan: researcher inline; coder spawns tmux and awaits done", async () => {
    const runResearch = async () => SAMPLE_BRIEF;
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const briefStore = new BriefStore({ vectorStore: vs, embedder: emb });

    const { orch, controller, bus } = makeOrchestrator({
      briefStore,
      runResearch,
    });

    setTimeout(() => {
      bus.emit({
        kind: "done",
        slot: 10,
        task_id: "T2",
        payload: { success: true },
        ts: new Date(),
      });
    }, 20);

    const result = await orch.executeOnce(MIXED_PLAN, "T2");
    assert.equal(result.success, true);
    assert.equal(controller.spawnCalls.length, 1);
    assert.equal(controller.spawnCalls[0].role, "backend");
    assert.equal(vs.rows.size, 1);
  });

  test("detour works without a briefStore wired", async () => {
    const runResearch = async () => SAMPLE_BRIEF;
    const { orch } = makeOrchestrator({ runResearch });
    const result = await orch.executeOnce(RESEARCHER_PLAN, "T1");
    assert.equal(result.success, true);
  });

  test("case-insensitive detection: 'Researcher' also detours", async () => {
    let called = false;
    const runResearch = async () => {
      called = true;
      return SAMPLE_BRIEF;
    };
    const cased: Plan = {
      ...RESEARCHER_PLAN,
      agents: [{ ...RESEARCHER_PLAN.agents[0], role: "Researcher" }],
    };
    const { orch, controller } = makeOrchestrator({ runResearch });
    await orch.executeOnce(cased, "T1");
    assert.equal(called, true);
    assert.equal(controller.spawnCalls.length, 0);
  });
});
