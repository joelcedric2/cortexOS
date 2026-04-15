/**
 * Phase 2.5 Definition-of-Done smoke test.
 *
 * Proves the full H→P→R→B auto-research loop end-to-end, per §6 Phase 2.5
 * DoD in docs/NCHINDA_PLAN.md:
 *
 *   "ask Nchinda an open question with unknowns; it enumerates 3+
 *    hypotheses, runs parallel probes, produces a structured brief with
 *    confidence. The brief gets recalled next time a similar question is
 *    asked."
 *
 * Wiring:
 *   - real `Orchestrator` shell (tmux + claude-agent spawns faked — the
 *     Designer tmux flow isn't what we're testing)
 *   - real `BriefStore` backed by an in-memory VectorStore + Embedder
 *   - real `EventBus`
 *   - real `runResearch` from `src/research/research-loop.ts`, driven by
 *     a scripted fetch (mocked Haiku)
 *
 * Coverage:
 *   1. Plan with role=researcher → Orchestrator detours: no tmux spawn,
 *      `runResearch` invoked with the PlanAgent's task.
 *   2. Brief persisted via BriefStore → FakeVectorStore received an
 *      embed + storeMemory call tagged `research_brief`.
 *   3. Event bus saw `plan_emitted` phase transitions (HYPOTHESIZE,
 *      DESIGN_PROBES, EXECUTE_PROBES, UPDATE_BELIEFS, BRIEF) and a final
 *      `research_brief_emitted`.
 *   4. A second Designer run with a similar task description recalls the
 *      prior Brief and injects a "## Relevant prior research" section
 *      into the Designer's system prompt.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { OrchestratorDeps } from "../src/orchestrator/orchestrator.js";
import type { CortexController } from "../src/controller/cortex.js";
import type { TmuxManager } from "../src/tmux/tmux-manager.js";
import { createEventBus, type AgentEvent } from "../src/ipc/event-bus.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { BriefStore } from "../src/research/brief-store.js";
import {
  runResearch,
  type ResearchOptions,
} from "../src/research/research-loop.js";
import type {
  MemoryRecord,
  MemorySearchResult,
} from "../src/memory/vector-store.js";

// ─── Haiku script helpers (mirrors tests/research-loop.test.ts) ──────────────

interface ScriptedResp {
  body?: unknown;
  status?: number;
}

function scriptedFetch(responses: ScriptedResp[]): typeof fetch {
  let idx = 0;
  return async (_url, _init) => {
    const resp = responses[idx] ?? responses[responses.length - 1]!;
    idx++;
    const status = resp.status ?? 200;
    return new Response(JSON.stringify(resp.body ?? {}), { status });
  };
}

function haikuContent(json: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

const THREE_HYPOTHESES = {
  hypotheses: [
    {
      h: "Postgres is fine; sqlite gains are marginal for our write volume",
      prior: 0.35,
      probe: "benchmark pg vs sqlite at our current QPS",
    },
    {
      h: "sqlite would reduce ops burden substantially with little perf loss",
      prior: 0.4,
      probe: "measure p99 latency on the hot registry read path",
    },
    {
      h: "We should stay on pg — replication + durability matter more than ops",
      prior: 0.25,
      probe: "audit which registry reads require transactional guarantees",
    },
  ],
};

const SCORES_SQLITE_WINS = {
  scores: [
    { id: "h1", likelihood: 0.3, verdict: "inconclusive" as const },
    { id: "h2", likelihood: 0.85, verdict: "confirmed" as const },
    { id: "h3", likelihood: 0.4, verdict: "inconclusive" as const },
  ],
};

const BRIEF_DRAFT = {
  winning:
    "sqlite would reduce ops burden substantially with little perf loss",
  evidence: [
    "sqlite p99 < 2ms on 10k-row registry reads",
    "no replication requirement for the local agent registry",
  ],
  open_questions: ["what happens to registry during full-disk scenarios?"],
  recommended_action:
    "Migrate the agent registry to sqlite; keep pg for durable event log",
};

// ─── Fakes ───────────────────────────────────────────────────────────────────

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
  calls: string[] = [];
  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    return new Array(384).fill(0);
  }
}

/**
 * Minimal controller fake. Records every spawn + sendMessage call so we
 * can assert the researcher slot never got a tmux spawn. A tiny
 * sendMessage hook emits a scripted `plan_emitted` event so the real
 * Orchestrator's Phase 2 `awaitPlan` resolves.
 */
class FakeController {
  spawnCalls: Array<{ role: string; slot?: number }> = [];
  sendCalls: Array<{ slot: number; message: string }> = [];
  private nextSlot = 10;
  onPlanningPrompt?: (message: string) => void;

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
    this.onPlanningPrompt?.(message);
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
  async capturePane(): Promise<string> {
    return "";
  }
}

// ─── Test harness ────────────────────────────────────────────────────────────

interface HarnessArgs {
  haikuResponses: ScriptedResp[];
  briefStore?: BriefStore;
  /** Optional bus so a single bus can be shared across two `execute` runs. */
  bus?: ReturnType<typeof createEventBus>;
}

function buildHarness(args: HarnessArgs) {
  const controller = new FakeController();
  const tmux = new FakeTmuxManager();
  const bus = args.bus ?? createEventBus();
  const registry = new AgentRegistry({ dbPath: ":memory:" });

  const fetchImpl = scriptedFetch(args.haikuResponses);

  // Wrap the real runResearch so it always uses our scripted fetch + a
  // bounded timeBudget. This is the "mocked Haiku" layer — the rest of
  // the research loop runs for real.
  const wrappedRunResearch = (q: string, opts: ResearchOptions = {}) =>
    runResearch(q, {
      ...opts,
      apiKey: "test-key",
      fetchImpl,
      timeBudgetMs: 5000,
    });

  // Fire a scripted `plan_emitted` carrying a researcher-role Plan as
  // soon as the Designer receives the planning prompt. Mirrors the
  // pattern used in tests/designer-recall.test.ts.
  controller.onPlanningPrompt = (message: string) => {
    const m = message.match(/Task ID:\s+([0-9a-f-]+)/i);
    if (!m) return;
    const taskId = m[1];
    setImmediate(() => {
      bus.emit({
        kind: "plan_emitted",
        task_id: taskId,
        payload: {
          task_id: taskId,
          goal:
            "Evaluate whether to migrate the registry from pg to sqlite",
          complexity: "multi-agent",
          agents: [
            {
              role: "researcher",
              color: "cyan",
              task:
                "should we migrate from pg to sqlite for the agent registry?",
              success_criteria: "research brief emitted with a winner",
              budget: { max_tokens: 12_000, max_minutes: 5 },
              depends_on: [],
            },
          ],
          coordination: {
            checkpoints: ["on_step_complete"],
            reporting_to: "system-designer",
          },
        },
        ts: new Date(),
      });
    });
  };

  const deps: OrchestratorDeps = {
    bus,
    registry,
    briefStore: args.briefStore,
    runResearch: wrappedRunResearch,
    capturePaneOutput: async () => "",
    waitForReady: async () => {},
    openTerminal: async () => {},
    doneTimeoutMs: 500,
    designerTimeoutMs: 5000,
  };

  const orch = new Orchestrator(
    controller as unknown as CortexController,
    tmux as unknown as TmuxManager,
    deps,
  );

  return { orch, controller, bus, registry };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Phase 2.5 Definition of Done", () => {
  test("researcher plan → H→P→R→B → Brief persisted + events emitted", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const briefStore = new BriefStore({ vectorStore: vs, embedder: emb });

    const phaseEvents: AgentEvent[] = [];
    const briefEvents: AgentEvent[] = [];

    const { orch, controller, bus } = buildHarness({
      haikuResponses: [
        { body: haikuContent(THREE_HYPOTHESES) },
        { body: haikuContent(SCORES_SQLITE_WINS) },
        { body: haikuContent(BRIEF_DRAFT) },
      ],
      briefStore,
    });

    bus.subscribe({ kind: "plan_emitted" }, (e) => phaseEvents.push(e));
    bus.subscribe({ kind: "research_brief_emitted" }, (e) =>
      briefEvents.push(e),
    );

    await orch.execute(
      "should we migrate from pg to sqlite for the registry?",
    );

    // ── 1. Orchestrator detoured: only the Designer got a spawn, NOT the
    //       researcher slot.
    assert.equal(
      controller.spawnCalls.length,
      1,
      "only the Designer should have been spawned — researcher detours in-process",
    );
    assert.equal(controller.spawnCalls[0].role, "system-designer");

    // ── 2. Brief persisted via BriefStore: the FakeVectorStore saw a
    //       storeMemory call tagged `research_brief`, and the Embedder
    //       saw its summary.
    assert.equal(vs.rows.size, 1, "exactly one Brief persisted");
    const row = [...vs.rows.values()][0];
    assert.equal(row.taskType, "research_brief");
    assert.ok(
      row.tags.includes("research_brief"),
      "tags must include research_brief marker",
    );
    assert.equal(row.outcome, "success");
    assert.ok(
      emb.calls.length >= 1,
      "embedder.embed() called at least once during persist",
    );
    assert.match(
      emb.calls[emb.calls.length - 1],
      /sqlite|registry/i,
      "embed summary carries the Brief's payload",
    );

    // Brief JSON round-trips.
    const parsed = JSON.parse(row.content);
    assert.equal(
      parsed.winning,
      "sqlite would reduce ops burden substantially with little perf loss",
    );
    assert.ok(parsed.confidence > 0.5, "confidence crossed the 0.5 bar");
    assert.equal(parsed.hypotheses.length, 3, "three hypotheses enumerated");

    // ── 3. Event-bus proof of work: plan_emitted phase transitions from
    //       the research loop, plus the final research_brief_emitted.
    const loopPhases = phaseEvents
      .map((e) =>
        typeof e.payload === "object" && e.payload
          ? (e.payload as { phase?: string }).phase
          : undefined,
      )
      .filter((p): p is string => typeof p === "string");

    // The loop collapses HYPOTHESIZE + DESIGN_PROBES into one Haiku call
    // and emits only the four phases that have a bus-visible boundary.
    for (const required of [
      "HYPOTHESIZE",
      "EXECUTE_PROBES",
      "UPDATE_BELIEFS",
      "BRIEF",
    ]) {
      assert.ok(
        loopPhases.includes(required),
        `expected plan_emitted{phase=${required}} on bus, got phases: ${loopPhases.join(", ")}`,
      );
    }

    assert.equal(
      briefEvents.length,
      1,
      "exactly one research_brief_emitted event",
    );
    const briefEvent = briefEvents[0]!;
    assert.ok(briefEvent.payload, "research_brief_emitted carries a payload");
    const briefPayload = briefEvent.payload as {
      winning?: string;
      confidence?: number;
      question?: string;
    };
    assert.equal(
      briefPayload.winning,
      "sqlite would reduce ops burden substantially with little perf loss",
    );
    assert.ok(
      (briefPayload.confidence ?? 0) > 0.5,
      "payload.confidence crosses 0.5",
    );
  });

  test("second Designer run recalls the prior Brief into its system prompt", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const briefStore = new BriefStore({ vectorStore: vs, embedder: emb });

    // ── First run: produce + persist a Brief via the real loop.
    const firstRun = buildHarness({
      haikuResponses: [
        { body: haikuContent(THREE_HYPOTHESES) },
        { body: haikuContent(SCORES_SQLITE_WINS) },
        { body: haikuContent(BRIEF_DRAFT) },
      ],
      briefStore,
    });
    await firstRun.orch.execute(
      "should we migrate from pg to sqlite for the registry?",
    );
    assert.equal(
      vs.rows.size,
      1,
      "first run must persist a Brief for the second run to recall",
    );

    // Force the FakeVectorStore to report high similarity on the stored
    // row — FakeEmbedder returns a zero vector for everything, so cosine
    // similarity would collapse to 0; the test stub uses an override map.
    const storedId = [...vs.rows.keys()][0];
    vs.similarityMap.set(storedId, 0.92);

    // ── Second run: a similar question. The Designer's planning prompt
    //    must carry an injected "## Relevant prior research" section
    //    surfaced from the BriefStore.
    const second = buildHarness({
      haikuResponses: [
        { body: haikuContent(THREE_HYPOTHESES) },
        { body: haikuContent(SCORES_SQLITE_WINS) },
        { body: haikuContent(BRIEF_DRAFT) },
      ],
      briefStore,
    });

    await second.orch.execute(
      "should we switch from pg to sqlite for the registry?",
    );

    // The planning prompt is the first message the Designer receives.
    const planningSend = second.controller.sendCalls.find(
      (s) => s.slot === 0,
    );
    assert.ok(planningSend, "Designer received a planning prompt");
    assert.match(
      planningSend!.message,
      /## Relevant prior research/,
      "Designer's prompt must carry the recalled-brief section",
    );
    assert.match(
      planningSend!.message,
      /pg to sqlite/i,
      "recalled question surfaces in the prompt",
    );
    assert.match(
      planningSend!.message,
      /Migrate the agent registry to sqlite/i,
      "recalled recommendation surfaces in the prompt",
    );
  });
});
