/**
 * Tests for the Phase 8.5 screen_memories SQLite wrapper.
 *
 * All tests use in-memory SQLite (`:memory:`) so nothing touches the shared
 * ~/.cortexos/registry.db. Time is pinned via explicit Date instances.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  ScreenMemoriesDB,
  type ScreenMemoryInput,
} from "../src/perception/screen-memories-db.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const BASE = new Date(Date.parse("2026-04-15T00:00:00Z"));

function int8Vec(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    // Clamp into signed int8 range then convert to unsigned byte.
    const clamped = Math.max(-128, Math.min(127, Math.trunc(v)));
    buf[i] = clamped < 0 ? clamped + 256 : clamped;
  }
  return buf;
}

function makeInput(overrides: Partial<ScreenMemoryInput> = {}): ScreenMemoryInput {
  const defaults: ScreenMemoryInput = {
    id: "sm-1",
    captured_at: BASE,
    webp_path: "/tmp/sm-1.webp",
    phash: 0x0123456789abcdefn,
    active_app: "Safari",
    window_title: "Hacker News",
    ocr_text_zstd: null,
    label: null,
    embedding: int8Vec([1, 0, 0, 0]),
    task_id: null,
    session_id: null,
    bytes: 1024,
  };
  // Spread preserves explicit `null` / `0` overrides (unlike `??`).
  return { ...defaults, ...overrides };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("ScreenMemoriesDB", () => {
  let db: ScreenMemoriesDB;

  beforeEach(() => {
    db = new ScreenMemoriesDB({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
  });

  test("insert then get round-trips every column", () => {
    const stored = db.insert(
      makeInput({
        ocr_text_zstd: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
        label: "reading-news",
        task_id: "task-7",
        session_id: "sess-alpha",
      }),
    );
    const got = db.get("sm-1");
    assert.ok(got);
    assert.equal(got!.id, "sm-1");
    assert.equal(got!.captured_at, BASE.toISOString());
    assert.equal(got!.webp_path, "/tmp/sm-1.webp");
    assert.equal(got!.phash, 0x0123456789abcdefn);
    assert.equal(got!.active_app, "Safari");
    assert.equal(got!.window_title, "Hacker News");
    assert.ok(got!.ocr_text_zstd);
    assert.equal(got!.ocr_text_zstd!.length, 4);
    assert.equal(got!.label, "reading-news");
    assert.equal(got!.task_id, "task-7");
    assert.equal(got!.session_id, "sess-alpha");
    assert.equal(got!.bytes, 1024);
    // insert() return and get() must match.
    assert.deepEqual(stored, got);
  });

  test("get returns null for missing id", () => {
    assert.equal(db.get("missing"), null);
  });

  test("phash stores full 64 bits (beyond Number.MAX_SAFE_INTEGER)", () => {
    // 0xF000_0000_0000_0001 exceeds Number.MAX_SAFE_INTEGER (2^53-1) and
    // has the MSB set — the canonical "does this survive?" probe.
    const huge = 0xf000000000000001n;
    db.insert(makeInput({ id: "sm-huge", phash: huge }));
    const got = db.get("sm-huge");
    assert.ok(got);
    // Stored as signed int64 — 0xF000_0000_0000_0001 wraps to negative.
    const expectedSigned = huge - (1n << 64n);
    assert.equal(got!.phash, expectedSigned);
  });

  test("listOlderThan returns only pre-cutoff rows with a webp_path", () => {
    // 3 older (with webp), 2 older (already downgraded), 3 newer.
    for (let i = 0; i < 3; i++) {
      db.insert(
        makeInput({
          id: `old-${i}`,
          captured_at: new Date(BASE.getTime() - 10 * DAY + i),
          webp_path: `/tmp/old-${i}.webp`,
          bytes: 100 + i,
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      db.insert(
        makeInput({
          id: `downgraded-${i}`,
          captured_at: new Date(BASE.getTime() - 10 * DAY + i),
          webp_path: null,
          bytes: 0,
        }),
      );
    }
    for (let i = 0; i < 3; i++) {
      db.insert(
        makeInput({
          id: `new-${i}`,
          captured_at: new Date(BASE.getTime() - 1 * DAY + i),
          webp_path: `/tmp/new-${i}.webp`,
        }),
      );
    }
    const cutoff = new Date(BASE.getTime() - 7 * DAY);
    const rows = db.listOlderThan(cutoff);
    assert.equal(rows.length, 3);
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ["old-0", "old-1", "old-2"]);
    for (const r of rows) {
      assert.ok(r.webp_path);
      assert.ok(new Date(r.captured_at).getTime() < cutoff.getTime());
    }
  });

  test("listOlderThan respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      db.insert(
        makeInput({
          id: `x-${i}`,
          captured_at: new Date(BASE.getTime() - (10 + i) * DAY),
          webp_path: `/tmp/x-${i}.webp`,
        }),
      );
    }
    const cutoff = new Date(BASE.getTime() - 7 * DAY);
    const rows = db.listOlderThan(cutoff, 2);
    assert.equal(rows.length, 2);
  });

  test("dropWebP nulls webp_path and zeroes bytes; second call is no-op", () => {
    db.insert(
      makeInput({ id: "sm-d", webp_path: "/tmp/sm-d.webp", bytes: 2048 }),
    );
    db.dropWebP("sm-d", BASE.toISOString());
    const after = db.get("sm-d");
    assert.ok(after);
    assert.equal(after!.webp_path, null);
    assert.equal(after!.bytes, 0);
    // Rerun — must not throw, must not change state.
    db.dropWebP("sm-d", BASE.toISOString());
    const again = db.get("sm-d");
    assert.equal(again!.webp_path, null);
    assert.equal(again!.bytes, 0);
  });

  test("byTask returns rows attached to a task, chronologically", () => {
    db.insert(
      makeInput({
        id: "t-a",
        task_id: "task-42",
        captured_at: new Date(BASE.getTime() + 1),
      }),
    );
    db.insert(
      makeInput({
        id: "t-b",
        task_id: "task-42",
        captured_at: new Date(BASE.getTime()),
      }),
    );
    db.insert(makeInput({ id: "t-c", task_id: "other" }));

    const rows = db.byTask("task-42");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.id), ["t-b", "t-a"]);
  });

  test("byPhash exact match returns only identical phashes", () => {
    db.insert(makeInput({ id: "p1", phash: 0x1111222233334444n }));
    db.insert(makeInput({ id: "p2", phash: 0x1111222233334444n }));
    db.insert(makeInput({ id: "p3", phash: 0xaaaabbbbccccddddn }));

    const hits = db.byPhash(0x1111222233334444n);
    assert.equal(hits.length, 2);
    for (const h of hits) {
      assert.equal(h.hamming, 0);
      assert.equal(h.phash, 0x1111222233334444n);
    }
  });

  test("byPhash with hammingMax returns near neighbors sorted by distance", () => {
    // Base = 0x0..0, neighbors by bits flipped.
    const base = 0n;
    db.insert(makeInput({ id: "h0", phash: base })); // hamming 0
    db.insert(makeInput({ id: "h1", phash: 1n })); // hamming 1
    db.insert(makeInput({ id: "h2", phash: 3n })); // hamming 2
    db.insert(makeInput({ id: "h3", phash: 7n })); // hamming 3
    db.insert(makeInput({ id: "hX", phash: 0xffffn })); // hamming 16

    const hits = db.byPhash(base, 3);
    assert.equal(hits.length, 4);
    assert.deepEqual(
      hits.map((h) => h.id),
      ["h0", "h1", "h2", "h3"],
    );
    assert.deepEqual(
      hits.map((h) => h.hamming),
      [0, 1, 2, 3],
    );
  });

  test("byPhash handles full 64-bit bigints (MSB set)", () => {
    const a = 0x8000000000000000n;
    const b = 0x8000000000000001n; // hamming 1 from a
    db.insert(makeInput({ id: "a", phash: a }));
    db.insert(makeInput({ id: "b", phash: b }));
    const hits = db.byPhash(a, 1);
    assert.equal(hits.length, 2);
    const byId = Object.fromEntries(hits.map((h) => [h.id, h.hamming]));
    assert.equal(byId["a"], 0);
    assert.equal(byId["b"], 1);
  });

  test("bytesInWindow sums bytes across rows captured since the window start", () => {
    db.insert(
      makeInput({
        id: "w-old",
        captured_at: new Date(BASE.getTime() - 10 * DAY),
        bytes: 999, // outside window
      }),
    );
    db.insert(
      makeInput({
        id: "w-a",
        captured_at: new Date(BASE.getTime() - 2 * DAY),
        bytes: 100,
      }),
    );
    db.insert(
      makeInput({
        id: "w-b",
        captured_at: new Date(BASE.getTime() - 1 * DAY),
        bytes: 250,
      }),
    );
    db.insert(
      makeInput({
        id: "w-c",
        captured_at: BASE,
        bytes: 50,
      }),
    );
    const since = new Date(BASE.getTime() - 3 * DAY);
    assert.equal(db.bytesInWindow(since), 400);
  });

  test("bytesInWindow returns 0 for an empty window", () => {
    assert.equal(db.bytesInWindow(BASE), 0);
  });

  test("semanticSearch ranks scripted embeddings by cosine similarity", () => {
    // 3 embeddings on distinct axes — query should prefer the matching axis.
    db.insert(makeInput({ id: "s-x", embedding: int8Vec([100, 0, 0, 0]) }));
    db.insert(makeInput({ id: "s-y", embedding: int8Vec([0, 100, 0, 0]) }));
    db.insert(
      makeInput({
        id: "s-xy",
        embedding: int8Vec([70, 70, 0, 0]),
      }),
    );
    const query = int8Vec([120, 0, 0, 0]);
    const ranked = db.semanticSearch(query, 3);
    assert.equal(ranked.length, 3);
    assert.equal(ranked[0]!.id, "s-x");
    // s-xy (45°) should beat s-y (90°).
    assert.equal(ranked[1]!.id, "s-xy");
    assert.equal(ranked[2]!.id, "s-y");
    // Similarity is monotonic descending.
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1]!.similarity >= ranked[i]!.similarity);
    }
  });

  test("semanticSearch respects k and returns 0 when k=0", () => {
    db.insert(makeInput({ id: "only" }));
    assert.equal(db.semanticSearch(int8Vec([1, 0, 0, 0]), 0).length, 0);
    assert.equal(db.semanticSearch(int8Vec([1, 0, 0, 0]), 5).length, 1);
  });

  test("insert rejects negative bytes", () => {
    assert.throws(
      () => db.insert(makeInput({ id: "bad", bytes: -1 })),
      /bytes must be a non-negative finite number/,
    );
  });

  test("schema creation is idempotent — reopening the same DB file works", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "sm-db-"));
    const path = join(dir, "registry.db");
    try {
      const a = new ScreenMemoriesDB({ dbPath: path });
      a.insert(makeInput({ id: "a-1" }));
      a.close();
      // Second open must NOT re-run CREATE destructively; existing row stays.
      const b = new ScreenMemoriesDB({ dbPath: path });
      const got = b.get("a-1");
      assert.ok(got);
      assert.equal(got!.id, "a-1");
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
