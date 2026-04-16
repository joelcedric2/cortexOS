/**
 * Phase 15 — nchinda_rewind MCP tool tests.
 *
 * Exercises the MCP handler (not the JSON-RPC transport) end-to-end:
 * seeds an in-memory ScreenMemoriesDB, stubs the query embedder, calls
 * `nchindaRewind()` with MCP-shaped args, and asserts the result is the
 * `RewindResult[]` array. Also asserts schema registration.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ScreenMemoriesDB,
  type ScreenMemoryInput,
} from "../src/perception/screen-memories-db.js";
import { nchindaRewind } from "../src/mcp/nchinda-rewind.js";
import {
  NCHINDA_REWIND_SCHEMA,
  NCHINDA_TOOL_SCHEMAS,
} from "../src/mcp/tool-schema.js";
import type { RewindEmbedder } from "../src/rewind/rewind-query.js";

function int8Vec(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(-128, Math.min(127, Math.trunc(values[i]!)));
    buf[i] = v < 0 ? v + 256 : v;
  }
  return buf;
}

function makeRow(
  id: string,
  overrides: Partial<ScreenMemoryInput> = {},
): ScreenMemoryInput {
  return {
    id,
    captured_at: new Date("2026-04-15T10:00:00Z"),
    webp_path: `/tmp/${id}.webp`,
    phash: 0n,
    active_app: "Safari",
    window_title: "(none)",
    ocr_text_zstd: null,
    label: id,
    embedding: int8Vec([100, 0, 0, 0]),
    task_id: null,
    session_id: null,
    bytes: 1024,
    ...overrides,
  };
}

class StubEmbedder implements RewindEmbedder {
  constructor(private readonly vec: Buffer) {}
  async embed(): Promise<Buffer> {
    return this.vec;
  }
}

describe("nchindaRewind — MCP handler", () => {
  test("happy path: round-trips a rewind search", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      db.insert(makeRow("top", { embedding: int8Vec([100, 0, 0, 0]) }));
      db.insert(makeRow("mid", { embedding: int8Vec([50, 50, 0, 0]) }));
      db.insert(makeRow("bot", { embedding: int8Vec([0, 100, 0, 0]) }));
      const embedder = new StubEmbedder(int8Vec([100, 0, 0, 0]));

      const results = await nchindaRewind(
        { text: "the article", limit: 2 },
        { db, embedder },
      );

      assert.equal(results.length, 2);
      assert.equal(results[0]!.id, "top");
      assert.ok(results[0]!.similarity >= results[1]!.similarity);
      assert.equal(results[0]!.webp_path, "/tmp/top.webp");
    } finally {
      db.close();
    }
  });

  test("accepts ISO-string timeRange from MCP payload", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      db.insert(
        makeRow("inside", {
          captured_at: new Date("2026-04-15T10:00:00Z"),
        }),
      );
      db.insert(
        makeRow("outside", {
          captured_at: new Date("2026-04-14T10:00:00Z"),
        }),
      );
      const embedder = new StubEmbedder(int8Vec([100, 0, 0, 0]));

      const results = await nchindaRewind(
        {
          text: "q",
          timeRange: {
            from: "2026-04-15T00:00:00Z",
            to: "2026-04-15T23:59:59Z",
          },
        },
        { db, embedder },
      );

      assert.equal(results.length, 1);
      assert.equal(results[0]!.id, "inside");
    } finally {
      db.close();
    }
  });

  test("rejects invalid input via zod (no text)", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      const embedder = new StubEmbedder(int8Vec([1, 0, 0, 0]));
      await assert.rejects(
        () => nchindaRewind({}, { db, embedder }),
        /text/i,
      );
    } finally {
      db.close();
    }
  });

  test("rejects bogus timeRange dates", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    try {
      const embedder = new StubEmbedder(int8Vec([1, 0, 0, 0]));
      await assert.rejects(
        () =>
          nchindaRewind(
            {
              text: "q",
              timeRange: { from: "not-a-date", to: "also-bad" },
            },
            { db, embedder },
          ),
        /invalid date/i,
      );
    } finally {
      db.close();
    }
  });
});

describe("nchinda_rewind — schema registration", () => {
  test("NCHINDA_REWIND_SCHEMA is part of NCHINDA_TOOL_SCHEMAS", () => {
    const names = NCHINDA_TOOL_SCHEMAS.map((s) => s.name);
    assert.ok(names.includes("nchinda_rewind"));
  });

  test("schema describes text/limit/timeRange/app with text required", () => {
    assert.equal(NCHINDA_REWIND_SCHEMA.name, "nchinda_rewind");
    assert.deepEqual(NCHINDA_REWIND_SCHEMA.inputSchema.required, ["text"]);
    assert.equal(NCHINDA_REWIND_SCHEMA.inputSchema.additionalProperties, false);
    const props = NCHINDA_REWIND_SCHEMA.inputSchema.properties as Record<
      string,
      { type?: string }
    >;
    assert.equal(props.text!.type, "string");
    assert.equal(props.limit!.type, "integer");
    assert.equal(props.app!.type, "string");
    assert.equal(props.timeRange!.type, "object");
  });
});
