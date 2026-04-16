import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dedupMemories } from "../src/consolidation/dedup.js";
import type {
  MemoryRecord,
  MemorySearchResult,
} from "../src/memory/vector-store.js";

interface SeedRow extends Omit<MemoryRecord, "id" | "createdAt"> {
  id: string;
  createdAt: Date;
}

class FakeVectorStore {
  readonly rows = new Map<string, MemoryRecord>();
  deleteCalls: string[] = [];

  constructor(seeds: SeedRow[]) {
    for (const s of seeds) this.rows.set(s.id, { ...s });
  }

  async listMemories(opts: {
    limit: number;
    offset?: number;
    agentRole?: string;
    taskType?: string;
    outcome?: "success" | "fail";
    tag?: string;
    createdAfter?: Date;
  }): Promise<MemoryRecord[]> {
    let rows = Array.from(this.rows.values());
    if (opts.agentRole) rows = rows.filter((r) => r.agentRole === opts.agentRole);
    if (opts.taskType) rows = rows.filter((r) => r.taskType === opts.taskType);
    if (opts.outcome) rows = rows.filter((r) => r.outcome === opts.outcome);
    if (opts.tag) rows = rows.filter((r) => r.tags.includes(opts.tag!));
    if (opts.createdAfter) {
      const cutoff = opts.createdAfter.getTime();
      rows = rows.filter((r) => r.createdAt.getTime() > cutoff);
    }
    rows.sort((a, b) => {
      const t = a.createdAt.getTime() - b.createdAt.getTime();
      return t !== 0 ? t : a.id.localeCompare(b.id);
    });
    const off = opts.offset ?? 0;
    return rows.slice(off, off + opts.limit);
  }

  async searchMemories(
    embedding: number[],
    topK: number,
  ): Promise<MemorySearchResult[]> {
    const rows = Array.from(this.rows.values()).map((r) => ({
      ...r,
      similarity: cosine(embedding, r.embedding),
    }));
    rows.sort((a, b) => b.similarity - a.similarity);
    return rows.slice(0, topK);
  }

  async deleteMemory(id: string): Promise<void> {
    this.deleteCalls.push(id);
    this.rows.delete(id);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function embed(x: number, y: number, z: number): number[] {
  const v = new Array(384).fill(0);
  v[0] = x;
  v[1] = y;
  v[2] = z;
  return v;
}

function seed(id: string, vec: number[], overrides: Partial<SeedRow> = {}): SeedRow {
  return {
    id,
    agentRole: "coder",
    taskType: "general",
    content: `content-${id}`,
    embedding: vec,
    outcome: "success",
    tags: [],
    createdAt: new Date(Date.parse("2026-04-01") + parseId(id) * 60_000),
    ...overrides,
  };
}

function parseId(id: string): number {
  const m = /(\d+)/.exec(id);
  return m ? Number(m[1]) : 0;
}

describe("dedupMemories", () => {
  test("empty store returns zeros", async () => {
    const vs = new FakeVectorStore([]);
    const report = await dedupMemories({ vectorStore: vs });
    assert.equal(report.scanned, 0);
    assert.equal(report.clusters, 0);
    assert.equal(report.duplicatesRemoved, 0);
    assert.equal(report.bytesFreed, 0);
    assert.deepEqual(report.samples, []);
    assert.deepEqual(vs.deleteCalls, []);
  });

  test("no near-duplicates — zero clusters, zero removals", async () => {
    const vs = new FakeVectorStore([
      seed("m1", embed(1, 0, 0)),
      seed("m2", embed(0, 1, 0)),
      seed("m3", embed(0, 0, 1)),
    ]);
    const report = await dedupMemories({ vectorStore: vs }, { dryRun: false });
    assert.equal(report.scanned, 3);
    assert.equal(report.clusters, 0);
    assert.equal(report.duplicatesRemoved, 0);
    assert.deepEqual(vs.deleteCalls, []);
  });

  test("collapses a 3-member near-duplicate cluster and keeps newest", async () => {
    const vs = new FakeVectorStore([
      seed("m1", embed(1, 0.01, 0)),
      seed("m2", embed(1, 0.02, 0)),
      seed("m3", embed(1, 0.03, 0)),
    ]);
    const report = await dedupMemories(
      { vectorStore: vs },
      { keepStrategy: "newest", dryRun: false },
    );
    assert.equal(report.scanned, 3);
    assert.equal(report.clusters, 1);
    assert.equal(report.duplicatesRemoved, 2);
    assert.ok(report.bytesFreed > 0);
    assert.ok(vs.rows.has("m3"));
    assert.ok(!vs.rows.has("m1"));
    assert.ok(!vs.rows.has("m2"));
    assert.equal(report.samples.length, 1);
    assert.equal(report.samples[0].kept, "m3");
    assert.deepEqual(report.samples[0].removed.sort(), ["m1", "m2"]);
    assert.ok(report.samples[0].similarity >= 0.92);
  });

  test("keepStrategy=oldest keeps the earliest member", async () => {
    const vs = new FakeVectorStore([
      seed("m1", embed(1, 0.01, 0)),
      seed("m2", embed(1, 0.02, 0)),
      seed("m3", embed(1, 0.03, 0)),
    ]);
    await dedupMemories(
      { vectorStore: vs },
      { keepStrategy: "oldest", dryRun: false },
    );
    assert.ok(vs.rows.has("m1"));
    assert.ok(!vs.rows.has("m2"));
    assert.ok(!vs.rows.has("m3"));
  });

  test("keepStrategy=highest_similarity prefers canon-tagged members", async () => {
    const vs = new FakeVectorStore([
      seed("m1", embed(1, 0.01, 0)),
      seed("m2", embed(1, 0.02, 0), { tags: ["canon"] }),
      seed("m3", embed(1, 0.03, 0)),
    ]);
    await dedupMemories(
      { vectorStore: vs },
      { keepStrategy: "highest_similarity", dryRun: false },
    );
    assert.ok(vs.rows.has("m2"), "canon-tagged row must survive");
    assert.equal(vs.rows.size, 1);
  });

  test("dryRun=true reports duplicates without deleting", async () => {
    const vs = new FakeVectorStore([
      seed("m1", embed(1, 0.01, 0)),
      seed("m2", embed(1, 0.02, 0)),
    ]);
    const report = await dedupMemories(
      { vectorStore: vs },
      { dryRun: true },
    );
    assert.equal(report.duplicatesRemoved, 1);
    assert.equal(vs.deleteCalls.length, 0);
    assert.equal(vs.rows.size, 2);
  });

  test("idempotent: second run after actual dedup is a no-op", async () => {
    const vs = new FakeVectorStore([
      seed("m1", embed(1, 0.01, 0)),
      seed("m2", embed(1, 0.02, 0)),
      seed("m3", embed(1, 0.03, 0)),
    ]);
    await dedupMemories({ vectorStore: vs }, { dryRun: false });
    const second = await dedupMemories({ vectorStore: vs }, { dryRun: false });
    assert.equal(second.duplicatesRemoved, 0);
    assert.equal(second.clusters, 0);
  });

  test("100 duplicate memories collapse to 1 (DoD)", async () => {
    const rows: SeedRow[] = [];
    for (let i = 1; i <= 100; i++) {
      rows.push(seed(`m${String(i).padStart(3, "0")}`, embed(1, i * 0.0001, 0)));
    }
    const vs = new FakeVectorStore(rows);
    const report = await dedupMemories({ vectorStore: vs }, { dryRun: false });
    assert.equal(report.scanned, 100);
    assert.equal(report.clusters, 1);
    assert.equal(report.duplicatesRemoved, 99);
    assert.equal(vs.rows.size, 1);
  });

  test("respects namespace filter via tag", async () => {
    const vs = new FakeVectorStore([
      seed("m1", embed(1, 0.01, 0), { tags: ["alpha"] }),
      seed("m2", embed(1, 0.02, 0), { tags: ["alpha"] }),
      seed("m3", embed(1, 0.03, 0), { tags: ["beta"] }),
    ]);
    const report = await dedupMemories(
      { vectorStore: vs },
      { namespace: "alpha", dryRun: false },
    );
    assert.equal(report.scanned, 2);
    assert.equal(report.duplicatesRemoved, 1);
    assert.ok(vs.rows.has("m3"));
  });

  test("rejects invalid similarityThreshold", async () => {
    const vs = new FakeVectorStore([]);
    await assert.rejects(
      () => dedupMemories({ vectorStore: vs }, { similarityThreshold: 0 }),
      /similarityThreshold/,
    );
    await assert.rejects(
      () => dedupMemories({ vectorStore: vs }, { similarityThreshold: 1.1 }),
      /similarityThreshold/,
    );
  });
});
