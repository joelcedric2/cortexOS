import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BriefStore } from "../src/research/brief-store.js";
import type {
  MemoryRecord,
  MemorySearchResult,
} from "../src/memory/vector-store.js";
import type { Brief } from "../src/research/brief-schema.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { OrchestratorDeps } from "../src/orchestrator/orchestrator.js";
import type { CortexController } from "../src/controller/cortex.js";
import type { TmuxManager } from "../src/tmux/tmux-manager.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";

// ─── Fakes ──────────────────────────────────────────────────────────────────

class FakeVectorStore {
  readonly rows = new Map<string, MemoryRecord>();
  similarityMap = new Map<string, number>();
  private nextId = 1;
  async storeMemory(
    record: Omit<MemoryRecord, "id" | "createdAt">,
  ): Promise<string> {
    const id = `mem-${this.nextId++}`;
    this.rows.set(id, { ...record, id, createdAt: new Date() });
    return id;
  }
  async searchMemories(
    _embedding: number[],
    topK: number,
    filters?: { taskType?: string },
  ): Promise<MemorySearchResult[]> {
    const out: MemorySearchResult[] = [];
    for (const row of this.rows.values()) {
      if (filters?.taskType && row.taskType !== filters.taskType) continue;
      out.push({ ...row, similarity: this.similarityMap.get(row.id) ?? 0 });
    }
    out.sort((a, b) => b.similarity - a.similarity);
    return out.slice(0, topK);
  }
}

class FakeEmbedder {
  async embed(_t: string): Promise<number[]> {
    return new Array(384).fill(0);
  }
}

class FakeController {
  sends: Array<{ slot: number; message: string }> = [];
  async spawnAgent(
    _role: string,
    _provider?: string,
    slot?: number,
  ): Promise<number> {
    return slot ?? 0;
  }
  async sendMessage(slot: number, message: string): Promise<void> {
    this.sends.push({ slot, message });
  }
  get handles(): Map<number, { sessionName: string }> {
    return new Map([[0, { sessionName: "slot0" }]]);
  }
}

class FakeTmuxManager {
  async capturePane(): Promise<string> {
    return "";
  }
}

const PRIOR_BRIEF: Brief = {
  question: "Which DB for user sessions?",
  hypotheses: [],
  winning: "Redis",
  evidence: ["low-latency"],
  open_questions: [],
  recommended_action: "Use Redis for sessions, Postgres for durable state",
  confidence: 0.87,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function runDesignerPrompt(opts: {
  briefStore?: BriefStore;
  task: string;
}): Promise<string> {
  const tmux = new FakeTmuxManager();
  const bus = createEventBus();
  const registry = new AgentRegistry({ dbPath: ":memory:" });

  // The Designer's planning prompt mentions the real taskId. The Orchestrator
  // assigns it inside `execute` via randomUUID(), so the only reliable way
  // to emit a matching plan_emitted event is to observe what taskId appears
  // in the first sendMessage call and fire the event then.
  const controller = new FakeController();
  const originalSend = controller.sendMessage.bind(controller);
  controller.sendMessage = async (slot: number, message: string) => {
    await originalSend(slot, message);
    const match = message.match(/Task ID:\s+([0-9a-f-]+)/i);
    if (match) {
      setImmediate(() => {
        bus.emit({
          kind: "plan_emitted",
          task_id: match[1],
          payload: {
            task_id: match[1],
            goal: "done",
            complexity: "single-shot",
            agents: [
              {
                role: "backend",
                color: "blue",
                task: "noop",
                success_criteria: "ok",
                budget: { max_tokens: 100, max_minutes: 1 },
                depends_on: [],
              },
            ],
            coordination: { checkpoints: [], reporting_to: "system-designer" },
          },
          ts: new Date(),
        });
      });
    }
  };

  const deps: OrchestratorDeps = {
    bus,
    registry,
    briefStore: opts.briefStore,
    capturePaneOutput: async () => "",
    waitForReady: async () => {},
    openTerminal: async () => {},
    doneTimeoutMs: 200,
    designerTimeoutMs: 2000,
  };

  const orch = new Orchestrator(
    controller as unknown as CortexController,
    tmux as unknown as TmuxManager,
    deps,
  );

  await orch.execute(opts.task);

  const planningSend = controller.sends.find((s) => s.slot === 0);
  return planningSend?.message ?? "";
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Designer prior-research injection", () => {
  test("injects a 'Relevant prior research' section when recall matches ≥ 0.5", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const store = new BriefStore({ vectorStore: vs, embedder: emb });

    const id = await store.persist(PRIOR_BRIEF, { task_id: "t-prior" });
    vs.similarityMap.set(id, 0.9);

    const prompt = await runDesignerPrompt({
      briefStore: store,
      task: "Pick a session backend",
    });

    assert.match(prompt, /## Relevant prior research/);
    assert.match(prompt, /Q: Which DB for user sessions\?/);
    assert.match(prompt, /Winner: Redis \(confidence 0\.87\)/);
    assert.match(prompt, /Recommendation: Use Redis for sessions/);
  });

  test("does NOT inject when every recall result is below 0.5", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const store = new BriefStore({ vectorStore: vs, embedder: emb });

    const id = await store.persist(PRIOR_BRIEF, { task_id: "t-low" });
    vs.similarityMap.set(id, 0.3);

    const prompt = await runDesignerPrompt({
      briefStore: store,
      task: "A totally unrelated task",
    });

    assert.doesNotMatch(prompt, /## Relevant prior research/);
  });

  test("does NOT inject when recall returns empty", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const store = new BriefStore({ vectorStore: vs, embedder: emb });

    const prompt = await runDesignerPrompt({
      briefStore: store,
      task: "Nothing in memory yet",
    });

    assert.doesNotMatch(prompt, /## Relevant prior research/);
  });

  test("does NOT inject when no BriefStore is wired", async () => {
    const prompt = await runDesignerPrompt({
      task: "No brief store at all",
    });
    assert.doesNotMatch(prompt, /## Relevant prior research/);
  });

  test("inconclusive Brief (no winning) renders as 'inconclusive'", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const store = new BriefStore({ vectorStore: vs, embedder: emb });

    const id = await store.persist(
      { ...PRIOR_BRIEF, winning: undefined },
      { task_id: "t-inc" },
    );
    vs.similarityMap.set(id, 0.95);

    const prompt = await runDesignerPrompt({
      briefStore: store,
      task: "ask again",
    });

    assert.match(prompt, /Winner: inconclusive \(confidence 0\.87\)/);
  });
});
