import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NchindaTools } from "../src/mcp/nchinda-tools.js";
import type {
  VectorStore,
  MemorySearchResult,
  MemoryRecord,
} from "../src/memory/vector-store.js";
import type { Embedder } from "../src/memory/embedder.js";

type StoreCall = Omit<MemoryRecord, "id" | "createdAt">;

class FakeVectorStore
  implements Pick<VectorStore, "storeMemory" | "searchMemories">
{
  public storeCalls: StoreCall[] = [];
  public searchCalls: Array<{
    embedding: number[];
    topK: number;
    filters?: {
      agentRole?: string;
      taskType?: string;
      outcome?: "success" | "fail";
    };
  }> = [];
  public hits: MemorySearchResult[] = [];
  public nextId = "mem-1";

  async storeMemory(record: StoreCall): Promise<string> {
    this.storeCalls.push(record);
    return this.nextId;
  }

  async searchMemories(
    embedding: number[],
    topK: number,
    filters?: {
      agentRole?: string;
      taskType?: string;
      outcome?: "success" | "fail";
    },
  ): Promise<MemorySearchResult[]> {
    this.searchCalls.push({ embedding, topK, filters });
    return this.hits;
  }
}

class FakeEmbedder implements Pick<Embedder, "embed"> {
  public calls: string[] = [];
  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    const v = new Array(384).fill(0);
    for (let i = 0; i < Math.min(text.length, 384); i++) {
      v[i] = (text.charCodeAt(i) % 17) / 17;
    }
    return v;
  }
}

describe("NchindaTools.recall", () => {
  let store: FakeVectorStore;
  let embedder: FakeEmbedder;
  let tools: NchindaTools;

  beforeEach(() => {
    store = new FakeVectorStore();
    embedder = new FakeEmbedder();
    tools = new NchindaTools({ vectorStore: store, embedder });
  });

  test("embeds the query and passes topK + filter through", async () => {
    store.hits = [
      {
        id: "a",
        agentRole: "researcher",
        taskType: "lookup",
        content: "past finding",
        embedding: [0, 0, 0],
        outcome: "success",
        tags: ["web"],
        createdAt: new Date("2026-01-01T00:00:00Z"),
        similarity: 0.91,
      },
    ];

    const results = await tools.recall({
      query: "what did we learn about auth?",
      k: 3,
      filter: { agent_role: "researcher", task_type: "lookup" },
    });

    assert.deepEqual(embedder.calls, ["what did we learn about auth?"]);
    assert.equal(store.searchCalls.length, 1);
    assert.equal(store.searchCalls[0].topK, 3);
    assert.deepEqual(store.searchCalls[0].filters, {
      agentRole: "researcher",
      taskType: "lookup",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, "a");
    assert.equal(results[0].agent_role, "researcher");
    assert.equal(results[0].similarity, 0.91);
    assert.equal(results[0].created_at, "2026-01-01T00:00:00.000Z");
  });

  test("defaults k=5 when omitted", async () => {
    await tools.recall({ query: "hello" });
    assert.equal(store.searchCalls[0].topK, 5);
  });

  test("empty filter is passed as empty object", async () => {
    await tools.recall({ query: "hi" });
    assert.deepEqual(store.searchCalls[0].filters, {});
  });

  test("rejects empty query with zod", async () => {
    await assert.rejects(() => tools.recall({ query: "" }), /query/i);
  });

  test("rejects missing query", async () => {
    await assert.rejects(() => tools.recall({}), /query|required/i);
  });

  test("rejects k out of range", async () => {
    await assert.rejects(
      () => tools.recall({ query: "x", k: 999 }),
      /50|max/i,
    );
  });
});

describe("NchindaTools.remember", () => {
  let store: FakeVectorStore;
  let embedder: FakeEmbedder;
  let tools: NchindaTools;

  beforeEach(() => {
    store = new FakeVectorStore();
    embedder = new FakeEmbedder();
    tools = new NchindaTools({
      vectorStore: store,
      embedder,
      resolveAgentRole: () => "coder",
      now: () => new Date("2026-04-14T12:00:00Z"),
    });
  });

  test("embeds content, persists with role + tags, returns id + ts", async () => {
    store.nextId = "mem-42";
    const r = await tools.remember({
      content: "JWT refresh pattern works when paired with short access TTL",
      outcome: "success",
      tags: ["auth", "jwt"],
      task_type: "implementation",
    });
    assert.equal(r.id, "mem-42");
    assert.equal(r.stored_at, "2026-04-14T12:00:00.000Z");

    assert.equal(embedder.calls.length, 1);
    assert.equal(store.storeCalls.length, 1);
    const call = store.storeCalls[0];
    assert.equal(call.agentRole, "coder");
    assert.equal(call.taskType, "implementation");
    assert.equal(call.outcome, "success");
    assert.deepEqual(call.tags, ["auth", "jwt"]);
    assert.equal(call.embedding.length, 384);
  });

  test("outcome=recovered collapses to success + tag", async () => {
    await tools.remember({
      content: "retried with different tool after 500",
      outcome: "recovered",
      tags: ["api"],
    });
    const call = store.storeCalls[0];
    assert.equal(call.outcome, "success");
    assert.ok(call.tags.includes("recovered"));
    assert.ok(call.tags.includes("api"));
  });

  test("outcome=recovered doesn't duplicate existing 'recovered' tag", async () => {
    await tools.remember({
      content: "ok",
      outcome: "recovered",
      tags: ["recovered", "api"],
    });
    const tagCount = store.storeCalls[0].tags.filter(
      (t) => t === "recovered",
    ).length;
    assert.equal(tagCount, 1);
  });

  test("outcome=fail persists as fail", async () => {
    await tools.remember({
      content: "TikTok login expired",
      outcome: "fail",
      tags: ["tiktok"],
    });
    assert.equal(store.storeCalls[0].outcome, "fail");
  });

  test("resolveAgentRole fallback kicks in when agent_role omitted", async () => {
    await tools.remember({
      content: "note",
      outcome: "success",
      tags: [],
    });
    assert.equal(store.storeCalls[0].agentRole, "coder");
  });

  test("explicit agent_role wins over resolveAgentRole", async () => {
    await tools.remember({
      content: "note",
      outcome: "success",
      tags: [],
      agent_role: "tester",
    });
    assert.equal(store.storeCalls[0].agentRole, "tester");
  });

  test("defaults task_type to 'general' when omitted", async () => {
    await tools.remember({
      content: "note",
      outcome: "success",
      tags: [],
    });
    assert.equal(store.storeCalls[0].taskType, "general");
  });

  test("rejects empty content", async () => {
    await assert.rejects(
      () =>
        tools.remember({
          content: "",
          outcome: "success",
          tags: [],
        }),
      /content/i,
    );
  });

  test("rejects unknown outcome value", async () => {
    await assert.rejects(
      () =>
        tools.remember({
          content: "x",
          outcome: "maybe",
          tags: [],
        }),
      /outcome/i,
    );
  });

  test("rejects tags that aren't an array of strings", async () => {
    await assert.rejects(() =>
      tools.remember({
        content: "x",
        outcome: "success",
        tags: "not-an-array",
      }),
    );
  });

  test("missing resolveAgentRole + no agent_role → 'unknown'", async () => {
    const bareTools = new NchindaTools({
      vectorStore: store,
      embedder,
    });
    await bareTools.remember({
      content: "hello",
      outcome: "success",
      tags: [],
    });
    assert.equal(store.storeCalls[0].agentRole, "unknown");
  });
});

describe("NchindaTools round-trip", () => {
  test("store then search finds the same content via fake store", async () => {
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    const tools = new NchindaTools({ vectorStore: store, embedder });

    const r = await tools.remember({
      content: "login fixed by rotating the refresh token",
      outcome: "success",
      tags: ["auth"],
      agent_role: "coder",
      task_type: "debug",
    });
    assert.ok(r.id);

    store.hits = [
      {
        id: r.id,
        agentRole: "coder",
        taskType: "debug",
        content: "login fixed by rotating the refresh token",
        embedding: new Array(384).fill(0),
        outcome: "success",
        tags: ["auth"],
        createdAt: new Date(),
        similarity: 0.99,
      },
    ];

    const hits = await tools.recall({
      query: "how did we fix the login?",
      filter: { agent_role: "coder" },
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, r.id);
  });
});
