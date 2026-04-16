import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildConsolidationRunHandler,
  runConsolidation,
} from "../src/consolidation/worker.js";
import type {
  MemoryRecord,
  MemorySearchResult,
} from "../src/memory/vector-store.js";
import type { AgentEvent, EventBus, EventFilter } from "../src/ipc/event-bus.js";
import type { CronJob } from "../src/scheduler/cron-jobs-db.js";

interface SeedRow extends Omit<MemoryRecord, "id" | "createdAt"> {
  id: string;
  createdAt: Date;
}

class FakeVectorStore {
  readonly rows = new Map<string, MemoryRecord>();
  storeCalls: Array<Omit<MemoryRecord, "id" | "createdAt">> = [];
  deleteCalls: string[] = [];
  private nextId = 9000;

  constructor(seeds: SeedRow[] = []) {
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
    if (opts.outcome) rows = rows.filter((r) => r.outcome === opts.outcome);
    if (opts.tag) rows = rows.filter((r) => r.tags.includes(opts.tag!));
    if (opts.createdAfter) {
      const cutoff = opts.createdAfter.getTime();
      rows = rows.filter((r) => r.createdAt.getTime() > cutoff);
    }
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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

  async deleteMemory(id: string): Promise<void> {
    this.deleteCalls.push(id);
    this.rows.delete(id);
  }

  // Other VectorStore methods the worker doesn\'t need; implemented as stubs.
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
}

class FakeEmbedder {
  async embed(): Promise<number[]> {
    return new Array(384).fill(0);
  }
}

class CapturingBus implements EventBus {
  readonly events: AgentEvent[] = [];
  emit(event: AgentEvent): void {
    this.events.push(event);
  }
  subscribe(_f: EventFilter, _h: (e: AgentEvent) => void): () => void {
    return () => {};
  }
  async once(_f: EventFilter, _t?: number): Promise<AgentEvent> {
    throw new Error("not supported in tests");
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
    createdAt: new Date(Date.parse("2026-04-10")),
    ...overrides,
  };
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "consolidation-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const FIXED_NOW = () => new Date(Date.parse("2026-04-15T00:00:00Z"));

describe("runConsolidation", () => {
  test("emits started + complete on bus and runs dedup before canon", async () => {
    const seeds: SeedRow[] = [];
    // 3 near-duplicates + 5 more identical content to hit canon threshold
    for (let i = 1; i <= 8; i++) {
      seeds.push(seed(`m${i}`, embed(1, i * 0.0001, 0)));
    }
    const vs = new FakeVectorStore(seeds);
    const bus = new CapturingBus();

    await withTmpDir(async (auditDir) => {
      const report = await runConsolidation(
        {
          vectorStore: vs as unknown as import("../src/memory/vector-store.js").VectorStore,
          embedder: new FakeEmbedder() as unknown as import("../src/memory/embedder.js").Embedder,
          bus,
          auditDir,
          now: FIXED_NOW,
        },
        { canonOpts: { minHits: 5, now: FIXED_NOW } },
      );

      assert.ok(report.dedup.duplicatesRemoved > 0, "dedup should collapse near-dupes");
      assert.equal(report.ts, FIXED_NOW().toISOString());
      assert.ok(report.duration_ms >= 0);

      const phases = bus.events
        .filter((e) => e.kind === "plan_emitted")
        .map((e) => (e.payload as { phase: string }).phase);
      assert.deepEqual(
        phases,
        ["CONSOLIDATION_STARTED", "CONSOLIDATION_COMPLETE"],
        "should emit started then complete, in that order",
      );

      const files = await readdir(auditDir);
      assert.equal(files.length, 1);
      const body = await readFile(join(auditDir, files[0]!), "utf8");
      const persisted = JSON.parse(body) as typeof report;
      assert.equal(persisted.ts, report.ts);
      assert.equal(persisted.dedup.scanned, report.dedup.scanned);
    });
  });

  test("idempotent across two back-to-back runs", async () => {
    const seeds: SeedRow[] = [];
    for (let i = 1; i <= 8; i++) {
      seeds.push(seed(`m${i}`, embed(1, i * 0.0001, 0)));
    }
    const vs = new FakeVectorStore(seeds);

    await withTmpDir(async (auditDir) => {
      await runConsolidation(
        {
          vectorStore: vs as unknown as import("../src/memory/vector-store.js").VectorStore,
          embedder: new FakeEmbedder() as unknown as import("../src/memory/embedder.js").Embedder,
          auditDir,
          now: FIXED_NOW,
        },
        { canonOpts: { minHits: 5, now: FIXED_NOW } },
      );
      const second = await runConsolidation(
        {
          vectorStore: vs as unknown as import("../src/memory/vector-store.js").VectorStore,
          embedder: new FakeEmbedder() as unknown as import("../src/memory/embedder.js").Embedder,
          auditDir,
          now: FIXED_NOW,
        },
        { canonOpts: { minHits: 5, now: FIXED_NOW } },
      );

      assert.equal(second.dedup.duplicatesRemoved, 0);
      assert.equal(second.canon.promoted, 0);
    });
  });

  test("skipPersist suppresses audit file", async () => {
    const vs = new FakeVectorStore([]);
    await withTmpDir(async (auditDir) => {
      await runConsolidation(
        {
          vectorStore: vs as unknown as import("../src/memory/vector-store.js").VectorStore,
          embedder: new FakeEmbedder() as unknown as import("../src/memory/embedder.js").Embedder,
          auditDir,
          now: FIXED_NOW,
        },
        { skipPersist: true },
      );
      const files = await readdir(auditDir);
      assert.deepEqual(files, []);
    });
  });

  test("buildConsolidationRunHandler returns a (job)=>Promise<void> bound to runConsolidation", async () => {
    const vs = new FakeVectorStore([]);
    const bus = new CapturingBus();

    await withTmpDir(async (auditDir) => {
      const handler = buildConsolidationRunHandler(
        {
          vectorStore: vs as unknown as import("../src/memory/vector-store.js").VectorStore,
          embedder: new FakeEmbedder() as unknown as import("../src/memory/embedder.js").Embedder,
          bus,
          auditDir,
          now: FIXED_NOW,
        },
        { canonOpts: { now: FIXED_NOW } },
      );

      const fakeJob: CronJob = {
        id: "default_memory_consolidation",
        name: "memory_consolidation",
        cron_expr: "0 4 * * *",
        task: "Dedupe memories, promote canon patterns",
        role_hint: "memory-specialist",
        depth: "multi-agent",
        enabled: true,
        timezone: "America/New_York",
        last_run: null,
        next_run: null,
        created_by: "onboarding",
        created_at: "2026-04-15T00:00:00Z",
      };

      const result = await handler(fakeJob);
      assert.equal(result, undefined);
      const phases = bus.events.map(
        (e) => (e.payload as { phase: string }).phase,
      );
      assert.deepEqual(phases, ["CONSOLIDATION_STARTED", "CONSOLIDATION_COMPLETE"]);
    });
  });
});
