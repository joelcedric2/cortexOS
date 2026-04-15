import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BriefStore } from "../src/research/brief-store.js";
import type {
  MemoryRecord,
  MemorySearchResult,
} from "../src/memory/vector-store.js";
import type { Brief } from "../src/research/_research-stub.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
    filters?: {
      agentRole?: string;
      taskType?: string;
      outcome?: "success" | "fail";
    },
  ): Promise<MemorySearchResult[]> {
    const matches: MemorySearchResult[] = [];
    for (const row of this.rows.values()) {
      if (filters?.taskType && row.taskType !== filters.taskType) continue;
      if (filters?.agentRole && row.agentRole !== filters.agentRole) continue;
      if (filters?.outcome && row.outcome !== filters.outcome) continue;
      const similarity = this.similarityMap.get(row.id) ?? 0;
      matches.push({ ...row, similarity });
    }
    matches.sort((a, b) => b.similarity - a.similarity);
    return matches.slice(0, topK);
  }
}

class FakeEmbedder {
  calls: string[] = [];
  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    return new Array(384).fill(0);
  }
}

const SAMPLE_BRIEF: Brief = {
  question: "Should we use JWT or session cookies for auth?",
  hypotheses: [
    {
      id: "h1",
      claim: "JWT scales better across services",
      evidence_for: ["stateless"],
      evidence_against: ["rotation pain"],
      confidence: 0.8,
    },
  ],
  winning: "JWT with refresh tokens",
  evidence: ["OWASP guidance", "industry benchmarks"],
  open_questions: ["rotation strategy"],
  recommended_action: "Adopt JWT with 15m access + 7d refresh",
  confidence: 0.82,
  cost_tokens: 4200,
  cost_seconds: 12,
};

describe("BriefStore.persist", () => {
  test("round-trips a Brief through the vector store with correct tags", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const store = new BriefStore({ vectorStore: vs, embedder: emb });

    const id = await store.persist(SAMPLE_BRIEF, {
      task_id: "task-123",
      session_id: "sess-abc",
      agent_role: "researcher",
    });

    assert.ok(id.startsWith("mem-"));
    const row = vs.rows.get(id);
    assert.ok(row);
    assert.equal(row!.taskType, "research_brief");
    assert.equal(row!.agentRole, "researcher");
    assert.equal(row!.outcome, "success");
    assert.deepEqual(row!.tags, ["research_brief", "task-123", "sess-abc"]);

    const parsed = JSON.parse(row!.content) as Brief;
    assert.equal(parsed.question, SAMPLE_BRIEF.question);
    assert.equal(parsed.recommended_action, SAMPLE_BRIEF.recommended_action);
  });

  test("defaults agent_role to 'researcher' and omits session tag when absent", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const store = new BriefStore({ vectorStore: vs, embedder: emb });

    const id = await store.persist(SAMPLE_BRIEF, { task_id: "task-xyz" });
    const row = vs.rows.get(id)!;
    assert.equal(row.agentRole, "researcher");
    assert.deepEqual(row.tags, ["research_brief", "task-xyz"]);
  });

  test("embeds a summary that includes question + winning + action + evidence", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const store = new BriefStore({ vectorStore: vs, embedder: emb });

    await store.persist(SAMPLE_BRIEF, { task_id: "t1" });
    assert.equal(emb.calls.length, 1);
    const summary = emb.calls[0];
    assert.match(summary, /JWT or session cookies/);
    assert.match(summary, /JWT with refresh tokens/);
    assert.match(summary, /Adopt JWT/);
    assert.match(summary, /OWASP guidance/);
  });
});

describe("BriefStore.recall", () => {
  test("filters by minConfidence and hydrates JSON back into Briefs", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const store = new BriefStore({ vectorStore: vs, embedder: emb });

    const highId = await store.persist(SAMPLE_BRIEF, { task_id: "t-high" });
    const lowId = await store.persist(
      { ...SAMPLE_BRIEF, question: "unrelated topic" },
      { task_id: "t-low" },
    );

    vs.similarityMap.set(highId, 0.9);
    vs.similarityMap.set(lowId, 0.2);

    const results = await store.recall("JWT vs session cookies?", 5, 0.5);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, highId);
    assert.equal(results[0].brief.winning, "JWT with refresh tokens");
    assert.ok(results[0].similarity >= 0.5);
  });

  test("skips corrupted JSON rows instead of throwing", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();

    const goodId = await vs.storeMemory({
      agentRole: "researcher",
      taskType: "research_brief",
      content: JSON.stringify(SAMPLE_BRIEF),
      embedding: new Array(384).fill(0),
      outcome: "success",
      tags: ["research_brief", "t1"],
    });
    const badId = await vs.storeMemory({
      agentRole: "researcher",
      taskType: "research_brief",
      content: "{not valid json",
      embedding: new Array(384).fill(0),
      outcome: "success",
      tags: ["research_brief", "t2"],
    });
    vs.similarityMap.set(goodId, 0.9);
    vs.similarityMap.set(badId, 0.8);

    const store = new BriefStore({ vectorStore: vs, embedder: emb });
    const results = await store.recall("anything", 5, 0.5);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, goodId);
  });

  test("filters by taskType='research_brief' so non-brief rows are ignored", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();

    const briefId = await vs.storeMemory({
      agentRole: "researcher",
      taskType: "research_brief",
      content: JSON.stringify(SAMPLE_BRIEF),
      embedding: new Array(384).fill(0),
      outcome: "success",
      tags: ["research_brief"],
    });
    const otherId = await vs.storeMemory({
      agentRole: "researcher",
      taskType: "general",
      content: JSON.stringify(SAMPLE_BRIEF),
      embedding: new Array(384).fill(0),
      outcome: "success",
      tags: ["general"],
    });
    vs.similarityMap.set(briefId, 0.95);
    vs.similarityMap.set(otherId, 0.99);

    const store = new BriefStore({ vectorStore: vs, embedder: emb });
    const results = await store.recall("anything", 5, 0.5);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, briefId);
  });

  test("returns empty array when nothing passes the threshold", async () => {
    const vs = new FakeVectorStore();
    const emb = new FakeEmbedder();
    const store = new BriefStore({ vectorStore: vs, embedder: emb });

    const id = await store.persist(SAMPLE_BRIEF, { task_id: "t1" });
    vs.similarityMap.set(id, 0.1);
    const results = await store.recall("anything", 5, 0.5);
    assert.equal(results.length, 0);
  });
});
