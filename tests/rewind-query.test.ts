/**
 * Phase 15 — rewind-query unit tests.
 *
 * In-memory ScreenMemoriesDB seeded with scripted rows. Embeddings are
 * short int8 vectors so cosine similarity is fully deterministic; the
 * query-text embedder is a stub that returns a pre-computed vector
 * pointing at whichever row the test wants to surface.
 *
 * Covers:
 *   - top-k ordering + over-fetch truncation
 *   - `timeRange` filter (includes boundary, excludes outside)
 *   - `app` filter (case-insensitive match)
 *   - OCR zstd decompression + keyword-centered excerpt
 *   - graceful fallback when decompression blows up (no silent throw)
 *   - rejects empty query text
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import {
  ScreenMemoriesDB,
  type ScreenMemoryInput,
} from "../src/perception/screen-memories-db.js";
import {
  rewindSearch,
  carveExcerpt,
  type RewindEmbedder,
} from "../src/rewind/rewind-query.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function int8Vec(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(-128, Math.min(127, Math.trunc(values[i]!)));
    buf[i] = v < 0 ? v + 256 : v;
  }
  return buf;
}

const T0 = new Date("2026-04-15T10:00:00Z");
const OFFSET_MIN = (m: number) => new Date(T0.getTime() + m * 60_000);

function makeRow(
  id: string,
  overrides: Partial<ScreenMemoryInput>,
): ScreenMemoryInput {
  return {
    id,
    captured_at: T0,
    webp_path: `/tmp/${id}.webp`,
    phash: 0n,
    active_app: "Safari",
    window_title: "(untitled)",
    ocr_text_zstd: null,
    label: id,
    embedding: int8Vec([100, 0, 0, 0]),
    task_id: null,
    session_id: null,
    bytes: 1024,
    ...overrides,
  };
}

class ScriptedEmbedder implements RewindEmbedder {
  constructor(private readonly vec: Buffer) {}
  async embed(_text: string): Promise<Buffer> {
    return this.vec;
  }
}

// ─── Suite ─────────────────────────────────────────────────────────────────

describe("rewindSearch — ranking + over-fetch", () => {
  test("returns top-k sorted by cosine similarity DESC", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      db.insert(makeRow("x-axis", { embedding: int8Vec([100, 0, 0, 0]) }));
      db.insert(makeRow("y-axis", { embedding: int8Vec([0, 100, 0, 0]) }));
      db.insert(makeRow("xy-mix", { embedding: int8Vec([70, 70, 0, 0]) }));

      const emb = new ScriptedEmbedder(int8Vec([100, 0, 0, 0]));
      const out = await rewindSearch(
        { text: "anything" },
        { db, embedder: emb },
      );
      assert.equal(out[0]!.id, "x-axis");
      // xy-mix cos-sim > y-axis cos-sim for [100,0,0,0] query
      assert.equal(out[1]!.id, "xy-mix");
      assert.equal(out[2]!.id, "y-axis");
    } finally {
      db.close();
    }
  });

  test("respects limit clamp + truncates to requested size", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      for (let i = 0; i < 10; i++) {
        db.insert(
          makeRow(`r-${i}`, {
            embedding: int8Vec([100 - i * 5, 0, 0, 0]),
          }),
        );
      }
      const emb = new ScriptedEmbedder(int8Vec([100, 0, 0, 0]));
      const out = await rewindSearch(
        { text: "x", limit: 3 },
        { db, embedder: emb },
      );
      assert.equal(out.length, 3);
      assert.equal(out[0]!.id, "r-0");
    } finally {
      db.close();
    }
  });
});

describe("rewindSearch — filters", () => {
  test("timeRange filters out rows outside the window", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      db.insert(makeRow("old", { captured_at: OFFSET_MIN(-60) }));
      db.insert(makeRow("now", { captured_at: T0 }));
      db.insert(makeRow("future", { captured_at: OFFSET_MIN(+60) }));
      const emb = new ScriptedEmbedder(int8Vec([100, 0, 0, 0]));
      const out = await rewindSearch(
        {
          text: "q",
          timeRange: { from: OFFSET_MIN(-10), to: OFFSET_MIN(+10) },
        },
        { db, embedder: emb },
      );
      assert.equal(out.length, 1);
      assert.equal(out[0]!.id, "now");
    } finally {
      db.close();
    }
  });

  test("app filter is case-insensitive", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      db.insert(makeRow("safari-1", { active_app: "Safari" }));
      db.insert(makeRow("chrome-1", { active_app: "Google Chrome" }));
      const emb = new ScriptedEmbedder(int8Vec([100, 0, 0, 0]));
      const out = await rewindSearch(
        { text: "q", app: "safari" },
        { db, embedder: emb },
      );
      assert.equal(out.length, 1);
      assert.equal(out[0]!.id, "safari-1");
    } finally {
      db.close();
    }
  });

  test("empty-result filters still return an array", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      db.insert(makeRow("only", { active_app: "Safari" }));
      const emb = new ScriptedEmbedder(int8Vec([100, 0, 0, 0]));
      const out = await rewindSearch(
        { text: "q", app: "Finder" },
        { db, embedder: emb },
      );
      assert.deepEqual(out, []);
    } finally {
      db.close();
    }
  });
});

describe("rewindSearch — OCR excerpt", () => {
  test("decompresses zstd OCR blob and centers excerpt on keyword", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      const longText =
        "Before marker text ".repeat(40) +
        "TARGET_KEYWORD the article about transformers " +
        "After marker text ".repeat(40);
      const zstd = zstdCompressSync(Buffer.from(longText, "utf8"));
      db.insert(
        makeRow("article", {
          ocr_text_zstd: zstd,
          embedding: int8Vec([100, 0, 0, 0]),
        }),
      );
      const emb = new ScriptedEmbedder(int8Vec([100, 0, 0, 0]));
      const out = await rewindSearch(
        { text: "target_keyword transformers article" },
        { db, embedder: emb },
      );
      assert.equal(out.length, 1);
      assert.ok(out[0]!.ocr_excerpt);
      assert.ok(
        out[0]!.ocr_excerpt!.toLowerCase().includes("target_keyword"),
        `excerpt must contain the keyword, got: ${out[0]!.ocr_excerpt}`,
      );
      assert.ok(
        out[0]!.ocr_excerpt!.length <= 302,
        "excerpt is bounded to 300 chars + optional ellipses",
      );
    } finally {
      db.close();
    }
  });

  test("corrupt zstd blob is surfaced via onDecompressError + row still returned", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      db.insert(
        makeRow("corrupt", {
          ocr_text_zstd: Buffer.from([0x00, 0x01, 0x02, 0x03]),
        }),
      );
      const emb = new ScriptedEmbedder(int8Vec([100, 0, 0, 0]));
      const warnings: string[] = [];
      const out = await rewindSearch(
        { text: "q" },
        {
          db,
          embedder: emb,
          onDecompressError: (_err, id) => warnings.push(id),
        },
      );
      assert.equal(out.length, 1);
      assert.equal(out[0]!.ocr_excerpt, undefined);
      assert.deepEqual(warnings, ["corrupt"]);
    } finally {
      db.close();
    }
  });

  test("rows without OCR blob simply omit the excerpt", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      db.insert(makeRow("no-ocr", { ocr_text_zstd: null }));
      const emb = new ScriptedEmbedder(int8Vec([100, 0, 0, 0]));
      const out = await rewindSearch(
        { text: "q" },
        { db, embedder: emb },
      );
      assert.equal(out[0]!.ocr_excerpt, undefined);
    } finally {
      db.close();
    }
  });
});

describe("rewindSearch — input validation", () => {
  test("empty text throws", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      const emb = new ScriptedEmbedder(int8Vec([100, 0, 0, 0]));
      await assert.rejects(
        () => rewindSearch({ text: "  " }, { db, embedder: emb }),
        /non-empty/,
      );
    } finally {
      db.close();
    }
  });
});

describe("carveExcerpt — helper", () => {
  test("returns short text unchanged", () => {
    const out = carveExcerpt("short blob", ["blob"]);
    assert.equal(out, "short blob");
  });

  test("falls back to head when no keyword matches", () => {
    const longText = "a ".repeat(400);
    const out = carveExcerpt(longText, ["missing"]);
    assert.ok(out.length <= 302);
    assert.ok(out.startsWith("a"));
  });

  test("collapses whitespace", () => {
    const out = carveExcerpt("hello\n\nworld\t\tmore", ["world"]);
    assert.equal(out, "hello world more");
  });

  test("adds ellipses at non-boundary edges", () => {
    const longText =
      "pre ".repeat(100) + "MID " + "suf ".repeat(100);
    const out = carveExcerpt(longText, ["mid"]);
    assert.ok(out.startsWith("…"));
    assert.ok(out.endsWith("…"));
    assert.ok(out.toLowerCase().includes("mid"));
  });
});
