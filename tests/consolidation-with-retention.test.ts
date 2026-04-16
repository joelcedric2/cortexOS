/**
 * Phase 8.5 — integration test for runConsolidation + retention sweep.
 *
 * Extends the existing consolidation-worker test harness: seeds the same
 * in-memory fakes for vector-memories dedup + canon promotion, and adds
 * a real in-memory ScreenMemoriesDB with stale + fresh rows. Asserts
 * that a single runConsolidation pass:
 *   1. runs dedup (duplicates removed)
 *   2. runs retention (stale webp_paths nulled)
 *   3. emits RETENTION_COMPLETE on the bus
 *   4. surfaces both `dedup` and `retention` on the returned report.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runConsolidation } from "../src/consolidation/worker.js";
import type {
  MemoryRecord,
  MemorySearchResult,
} from "../src/memory/vector-store.js";
import type { AgentEvent, EventBus, EventFilter } from "../src/ipc/event-bus.js";
import {
  ScreenMemoriesDB,
  type ScreenMemoryInput,
} from "../src/perception/screen-memories-db.js";

// ─── Shared fakes (mirrors consolidation-worker.test.ts) ─────────────────────

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

function vecEmbed(x: number, y: number, z: number): number[] {
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

// ─── Screen-memory helpers ───────────────────────────────────────────────────

function int8Vec(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(-128, Math.min(127, Math.trunc(values[i]!)));
    buf[i] = v < 0 ? v + 256 : v;
  }
  return buf;
}

function screenInput(overrides: Partial<ScreenMemoryInput>): ScreenMemoryInput {
  const defaults: ScreenMemoryInput = {
    id: "sm-x",
    captured_at: new Date(),
    webp_path: null,
    phash: 0n,
    active_app: null,
    window_title: null,
    ocr_text_zstd: null,
    label: null,
    embedding: int8Vec([1, 0, 0, 0]),
    task_id: null,
    session_id: null,
    bytes: 0,
  };
  return { ...defaults, ...overrides };
}

async function touch(path: string, contents = "x"): Promise<void> {
  await writeFile(path, contents);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const FIXED_NOW = () => new Date(Date.parse("2026-04-15T00:00:00Z"));
const DAY = 24 * 60 * 60 * 1000;

describe("runConsolidation + retention (phase 8.5)", () => {
  test("runs dedup, canon, and retention — report contains all three", async () => {
    // Vector-memory seeds: 8 near-dups to trigger dedup + canon.
    const memSeeds: SeedRow[] = [];
    for (let i = 1; i <= 8; i++) {
      memSeeds.push(seed(`m${i}`, vecEmbed(1, i * 0.0001, 0)));
    }
    const vs = new FakeVectorStore(memSeeds);
    const bus = new CapturingBus();

    // Screen-memory seeds: 4 stale (10d old) + 3 fresh.
    const sm = new ScreenMemoriesDB({ dbPath: ":memory:" });
    const auditDir = await mkdtemp(join(tmpdir(), "cwr-audit-"));
    const webpDir = await mkdtemp(join(tmpdir(), "cwr-webp-"));
    try {
      const stalePaths: string[] = [];
      for (let i = 0; i < 4; i++) {
        const p = join(webpDir, `stale-${i}.webp`);
        await touch(p);
        stalePaths.push(p);
        sm.insert(
          screenInput({
            id: `stale-${i}`,
            captured_at: new Date(FIXED_NOW().getTime() - 10 * DAY),
            webp_path: p,
            bytes: 500 + i,
          }),
        );
      }
      const freshPaths: string[] = [];
      for (let i = 0; i < 3; i++) {
        const p = join(webpDir, `fresh-${i}.webp`);
        await touch(p);
        freshPaths.push(p);
        sm.insert(
          screenInput({
            id: `fresh-${i}`,
            captured_at: new Date(FIXED_NOW().getTime() - i * DAY),
            webp_path: p,
            bytes: 700 + i,
          }),
        );
      }

      const report = await runConsolidation(
        {
          vectorStore: vs as unknown as import("../src/memory/vector-store.js").VectorStore,
          embedder: new FakeEmbedder() as unknown as import("../src/memory/embedder.js").Embedder,
          bus,
          auditDir,
          now: FIXED_NOW,
          screenMemoriesDB: sm,
        },
        { canonOpts: { minHits: 5, now: FIXED_NOW } },
      );

      // ── Dedup fired ────────────────────────────────────────────────────
      assert.ok(report.dedup.duplicatesRemoved > 0, "dedup should collapse near-dupes");

      // ── Retention fired ────────────────────────────────────────────────
      assert.ok(report.retention, "retention report should be present");
      assert.equal(report.retention!.scanned, 4);
      assert.equal(report.retention!.downgraded, 4);
      assert.equal(
        report.retention!.bytesReclaimed,
        500 + 501 + 502 + 503,
      );
      assert.deepEqual(report.retention!.errors, []);

      // Stale rows downgraded, fresh rows untouched.
      for (let i = 0; i < 4; i++) {
        assert.equal(sm.get(`stale-${i}`)!.webp_path, null);
        assert.equal(await pathExists(stalePaths[i]!), false);
      }
      for (let i = 0; i < 3; i++) {
        assert.equal(sm.get(`fresh-${i}`)!.webp_path, freshPaths[i]);
        assert.equal(await pathExists(freshPaths[i]!), true);
      }

      // ── Bus emission ───────────────────────────────────────────────────
      const phases = bus.events
        .filter((e) => e.kind === "plan_emitted")
        .map((e) => (e.payload as { phase: string }).phase);
      assert.deepEqual(
        phases,
        [
          "CONSOLIDATION_STARTED",
          "RETENTION_COMPLETE",
          "CONSOLIDATION_COMPLETE",
        ],
        "bus should emit STARTED → RETENTION_COMPLETE → COMPLETE in order",
      );
      // RETENTION_COMPLETE payload carries the retention report.
      const retentionEvt = bus.events.find(
        (e) =>
          e.kind === "plan_emitted" &&
          (e.payload as { phase: string }).phase === "RETENTION_COMPLETE",
      );
      assert.ok(retentionEvt);
      const retentionPayload = retentionEvt!.payload as {
        phase: string;
        report: { downgraded: number };
      };
      assert.equal(retentionPayload.report.downgraded, 4);

      // ── Audit persistence includes the retention branch ────────────────
      const files = await readdir(auditDir);
      assert.equal(files.length, 1);
    } finally {
      sm.close();
      await rm(auditDir, { recursive: true, force: true });
      await rm(webpDir, { recursive: true, force: true });
    }
  });

  test("omitting screenMemoriesDB preserves legacy behavior (no retention)", async () => {
    const vs = new FakeVectorStore([]);
    const bus = new CapturingBus();
    const auditDir = await mkdtemp(join(tmpdir(), "cwr-legacy-"));
    try {
      const report = await runConsolidation(
        {
          vectorStore: vs as unknown as import("../src/memory/vector-store.js").VectorStore,
          embedder: new FakeEmbedder() as unknown as import("../src/memory/embedder.js").Embedder,
          bus,
          auditDir,
          now: FIXED_NOW,
        },
        { canonOpts: { now: FIXED_NOW } },
      );
      assert.equal(report.retention, undefined);
      const phases = bus.events
        .filter((e) => e.kind === "plan_emitted")
        .map((e) => (e.payload as { phase: string }).phase);
      assert.deepEqual(phases, [
        "CONSOLIDATION_STARTED",
        "CONSOLIDATION_COMPLETE",
      ]);
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  test("retentionOpts override flows through to the sweep", async () => {
    const vs = new FakeVectorStore([]);
    const sm = new ScreenMemoriesDB({ dbPath: ":memory:" });
    const auditDir = await mkdtemp(join(tmpdir(), "cwr-opts-"));
    const webpDir = await mkdtemp(join(tmpdir(), "cwr-opts-webp-"));
    try {
      const p = join(webpDir, "4day.webp");
      await touch(p);
      sm.insert(
        screenInput({
          id: "4day",
          captured_at: new Date(FIXED_NOW().getTime() - 4 * DAY),
          webp_path: p,
          bytes: 10,
        }),
      );
      // Default (7) would skip a 4-day row. retentionDays: 3 should catch it.
      const report = await runConsolidation(
        {
          vectorStore: vs as unknown as import("../src/memory/vector-store.js").VectorStore,
          embedder: new FakeEmbedder() as unknown as import("../src/memory/embedder.js").Embedder,
          auditDir,
          now: FIXED_NOW,
          screenMemoriesDB: sm,
        },
        { retentionOpts: { retentionDays: 3 }, canonOpts: { now: FIXED_NOW } },
      );
      assert.equal(report.retention!.downgraded, 1);
      assert.equal(await pathExists(p), false);
    } finally {
      sm.close();
      await rm(auditDir, { recursive: true, force: true });
      await rm(webpDir, { recursive: true, force: true });
    }
  });
});
