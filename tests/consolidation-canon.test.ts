import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { promoteCanonPatterns } from "../src/consolidation/canon.js";
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
  storeCalls: Array<Omit<MemoryRecord, "id" | "createdAt">> = [];
  private nextId = 1000;

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
    filters?: { outcome?: "success" | "fail" },
  ): Promise<MemorySearchResult[]> {
    let rows = Array.from(this.rows.values());
    if (filters?.outcome) rows = rows.filter((r) => r.outcome === filters.outcome);
    const scored = rows.map((r) => ({
      ...r,
      similarity: cosine(embedding, r.embedding),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  async storeMemory(
    record: Omit<MemoryRecord, "id" | "createdAt">,
  ): Promise<string> {
    this.storeCalls.push(record);
    const id = `mem-${this.nextId++}`;
    this.rows.set(id, { ...record, id, createdAt: new Date() });
    return id;
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

function seed(
  id: string,
  vec: number[],
  overrides: Partial<SeedRow> = {},
): SeedRow {
  return {
    id,
    agentRole: "coder",
    taskType: "general",
    content: `content-${id}`,
    embedding: vec,
    outcome: "success",
    tags: [],
    createdAt: new Date(Date.parse("2026-04-10")),
    ...overrides,
  };
}

const FIXED_NOW = () => new Date(Date.parse("2026-04-15T00:00:00Z"));

describe("promoteCanonPatterns", () => {
  test("empty store returns zeros", async () => {
    const vs = new FakeVectorStore([]);
    const report = await promoteCanonPatterns(
      { vectorStore: vs },
      { now: FIXED_NOW },
    );
    assert.equal(report.candidates, 0);
    assert.equal(report.promoted, 0);
    assert.equal(report.skipped, 0);
    assert.deepEqual(report.details, []);
  });

  test("fewer than minHits — no promotion", async () => {
    const vs = new FakeVectorStore([
      seed("m1", embed(1, 0.001, 0)),
      seed("m2", embed(1, 0.002, 0)),
      seed("m3", embed(1, 0.003, 0)),
    ]);
    const report = await promoteCanonPatterns(
      { vectorStore: vs },
      { minHits: 5, dryRun: false, now: FIXED_NOW },
    );
    assert.equal(report.candidates, 0);
    assert.equal(report.promoted, 0);
    assert.equal(vs.storeCalls.length, 0);
  });

  test("5 repeated success memories promoted to canon (DoD)", async () => {
    const rows: SeedRow[] = [];
    for (let i = 1; i <= 5; i++) {
      rows.push(seed(`m${i}`, embed(1, i * 0.0001, 0)));
    }
    const vs = new FakeVectorStore(rows);
    const report = await promoteCanonPatterns(
      { vectorStore: vs },
      { minHits: 5, dryRun: false, now: FIXED_NOW },
    );
    assert.equal(report.candidates, 1);
    assert.equal(report.promoted, 1);
    assert.equal(vs.storeCalls.length, 1);
    const call = vs.storeCalls[0]!;
    assert.ok(call.tags.includes("canon"));
    assert.ok(call.tags.includes("weight:canon"));
    assert.equal(call.outcome, "success");
  });

  test("dryRun=true counts candidates but does not insert", async () => {
    const rows: SeedRow[] = [];
    for (let i = 1; i <= 6; i++) {
      rows.push(seed(`m${i}`, embed(1, i * 0.0001, 0)));
    }
    const vs = new FakeVectorStore(rows);
    const report = await promoteCanonPatterns(
      { vectorStore: vs },
      { minHits: 5, dryRun: true, now: FIXED_NOW },
    );
    assert.equal(report.candidates, 1);
    assert.equal(report.promoted, 1);
    assert.equal(vs.storeCalls.length, 0);
    assert.equal(report.details[0].reason, "dry_run_would_promote");
  });

  test("skips clusters that already have a canon member", async () => {
    const rows: SeedRow[] = [];
    for (let i = 1; i <= 5; i++) {
      rows.push(
        seed(`m${i}`, embed(1, i * 0.0001, 0), i === 3 ? { tags: ["canon"] } : {}),
      );
    }
    const vs = new FakeVectorStore(rows);
    const report = await promoteCanonPatterns(
      { vectorStore: vs },
      { minHits: 5, dryRun: false, now: FIXED_NOW },
    );
    assert.equal(report.candidates, 1);
    assert.equal(report.promoted, 0);
    assert.equal(report.skipped, 1);
    assert.equal(vs.storeCalls.length, 0);
    assert.equal(report.details[0].reason, "already_has_canon");
  });

  test("idempotent: second run after promotion does not re-promote same cluster", async () => {
    const rows: SeedRow[] = [];
    for (let i = 1; i <= 5; i++) {
      rows.push(seed(`m${i}`, embed(1, i * 0.0001, 0)));
    }
    const vs = new FakeVectorStore(rows);
    await promoteCanonPatterns(
      { vectorStore: vs },
      { minHits: 5, dryRun: false, now: FIXED_NOW },
    );
    const second = await promoteCanonPatterns(
      { vectorStore: vs },
      { minHits: 5, dryRun: false, now: FIXED_NOW },
    );
    assert.equal(second.promoted, 0);
    assert.equal(second.skipped, 1);
  });

  test("ignores memories older than windowDays", async () => {
    const old = seed("old1", embed(1, 0.001, 0), {
      createdAt: new Date(Date.parse("2026-01-01")),
    });
    const recent: SeedRow[] = [];
    for (let i = 1; i <= 5; i++) {
      recent.push(seed(`r${i}`, embed(1, i * 0.0001, 0)));
    }
    const vs = new FakeVectorStore([old, ...recent]);
    const report = await promoteCanonPatterns(
      { vectorStore: vs },
      { minHits: 5, windowDays: 30, dryRun: false, now: FIXED_NOW },
    );
    // 6 would cluster; but 1 is out of window so only 5 remain — still >= minHits.
    assert.equal(report.candidates, 1);
    assert.equal(report.promoted, 1);
  });

  test("ignores fail-outcome memories", async () => {
    const rows: SeedRow[] = [];
    for (let i = 1; i <= 5; i++) {
      rows.push(seed(`f${i}`, embed(1, i * 0.0001, 0), { outcome: "fail" }));
    }
    const vs = new FakeVectorStore(rows);
    const report = await promoteCanonPatterns(
      { vectorStore: vs },
      { minHits: 5, dryRun: false, now: FIXED_NOW },
    );
    assert.equal(report.candidates, 0);
    assert.equal(report.promoted, 0);
  });

  test("rejects minHits < 2", async () => {
    const vs = new FakeVectorStore([]);
    await assert.rejects(
      () =>
        promoteCanonPatterns(
          { vectorStore: vs },
          { minHits: 1, now: FIXED_NOW },
        ),
      /minHits/,
    );
  });

  test("rejects similarityThreshold out of range", async () => {
    const vs = new FakeVectorStore([]);
    await assert.rejects(
      () =>
        promoteCanonPatterns(
          { vectorStore: vs },
          { similarityThreshold: 1.2, now: FIXED_NOW },
        ),
      /similarityThreshold/,
    );
  });
});
