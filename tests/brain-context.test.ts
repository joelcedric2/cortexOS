import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBrainClaudeMd } from "../src/voice/brain-context.js";
import type { VectorStore, MemorySearchResult } from "../src/memory/vector-store.js";
import type { Embedder } from "../src/memory/embedder.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const FAKE_SOUL = `# Nchinda

You are **Nchinda** — a personal AI agent belonging to Cedric Joel Yantio II.`;

function makeFakeEmbedder(): Embedder {
  return {
    embed: async (_text: string) => new Array(384).fill(0.1),
    embedBatch: async (texts: string[]) => texts.map(() => new Array(384).fill(0.1)),
    initialize: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeFakeVectorStore(memories: MemorySearchResult[]): VectorStore {
  return {
    searchMemories: async () => memories,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

let tmpDir: string;
let soulPath: string;

describe("buildBrainClaudeMd", () => {
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brain-ctx-"));
    soulPath = join(tmpDir, "SOUL.md");
    await writeFile(soulPath, FAKE_SOUL, "utf-8");
  });

  it("includes SOUL.md content verbatim", async () => {
    const md = await buildBrainClaudeMd({ soulPath });
    assert.ok(md.includes("You are **Nchinda**"), "SOUL.md personality missing");
    assert.ok(
      md.includes("Cedric Joel Yantio II"),
      "SOUL.md user reference missing",
    );
  });

  it("includes voice mode rules", async () => {
    const md = await buildBrainClaudeMd({ soulPath });
    assert.ok(md.includes("## Voice Mode"), "Voice Mode header missing");
    assert.ok(
      md.includes("spoken aloud via text-to-speech"),
      "TTS instruction missing",
    );
    assert.ok(
      md.includes("NO markdown formatting"),
      "No-markdown rule missing",
    );
  });

  it("includes tool usage rules with date and NEVER guess", async () => {
    const md = await buildBrainClaudeMd({ soulPath });
    assert.ok(
      md.includes("run `date`"),
      "Missing 'run `date`' in tool usage rules",
    );
    assert.ok(
      md.includes("NEVER guess"),
      "Missing 'NEVER guess' in tool usage rules",
    );
    assert.ok(
      md.includes("USE TOOLS BEFORE GUESSING"),
      "Missing tool usage header",
    );
  });

  it("lists at least 5 tools from NCHINDA_TOOL_SCHEMAS", async () => {
    const md = await buildBrainClaudeMd({ soulPath });
    assert.ok(
      md.includes("## Available cortexOS Tools"),
      "Tool list header missing",
    );
    // Count tool entries (lines starting with "- ")
    const toolSection = md.split("## Available cortexOS Tools")[1]!;
    const toolLines = toolSection
      .split("\n")
      .filter((l) => l.startsWith("- "));
    assert.ok(
      toolLines.length >= 5,
      `Expected >= 5 tools, got ${toolLines.length}`,
    );
    // Verify a few known tools
    assert.ok(md.includes("nchinda_recall"), "nchinda_recall missing");
    assert.ok(md.includes("nchinda_remember"), "nchinda_remember missing");
    assert.ok(md.includes("nchinda_research"), "nchinda_research missing");
  });

  it("skips memory section gracefully when vectorStore is null", async () => {
    const md = await buildBrainClaudeMd({ soulPath });
    assert.ok(
      md.includes("Memory section skipped"),
      "Should skip memory when no vectorStore",
    );
    // Must NOT throw
  });

  it("includes memory section when vectorStore is provided", async () => {
    const memories: MemorySearchResult[] = [
      {
        id: "1",
        agentRole: "nchinda-voice",
        taskType: "voice_interaction",
        content: "User asked about deployment patterns",
        embedding: [],
        outcome: "success",
        tags: ["voice"],
        createdAt: new Date(),
        similarity: 0.92,
      },
      {
        id: "2",
        agentRole: "nchinda-voice",
        taskType: "voice_interaction",
        content: "Reviewed PR #42",
        embedding: [],
        outcome: "fail",
        tags: ["voice"],
        createdAt: new Date(),
        similarity: 0.85,
      },
    ];

    const md = await buildBrainClaudeMd({
      soulPath,
      vectorStore: makeFakeVectorStore(memories),
      embedder: makeFakeEmbedder(),
    });

    assert.ok(
      md.includes("## Recent Context from Memory"),
      "Memory header missing",
    );
    assert.ok(
      md.includes("[success] User asked about deployment patterns"),
      "Memory content missing",
    );
    assert.ok(md.includes("[fail] Reviewed PR #42"), "Failure memory missing");
  });

  it("returns valid CLAUDE.md when SOUL.md does not exist", async () => {
    const md = await buildBrainClaudeMd({
      soulPath: "/nonexistent/path/SOUL.md",
    });
    // Should still have all other sections
    assert.ok(md.includes("## Voice Mode"), "Voice Mode missing without SOUL");
    assert.ok(
      md.includes("## Tool Usage"),
      "Tool Usage missing without SOUL",
    );
    assert.ok(
      md.includes("## Available cortexOS Tools"),
      "Tool list missing without SOUL",
    );
    assert.ok(
      md.includes("## About the User"),
      "User profile missing without SOUL",
    );
    assert.ok(
      md.includes("SOUL.md not found"),
      "Should note SOUL.md was missing",
    );
  });

  it("uses custom userName when provided", async () => {
    const md = await buildBrainClaudeMd({
      soulPath,
      userName: "Joel",
    });
    assert.ok(
      md.includes('address as "Joel"'),
      "Custom userName not applied",
    );
  });

  it("includes user profile section", async () => {
    const md = await buildBrainClaudeMd({ soulPath });
    assert.ok(md.includes("## About the User"), "User profile header missing");
    assert.ok(
      md.includes("Prefers action over discussion"),
      "User preference missing",
    );
    assert.ok(
      md.includes("full autonomy"),
      "Autonomy instruction missing",
    );
  });

  it("handles vectorStore that throws", async () => {
    const brokenStore = {
      searchMemories: async () => {
        throw new Error("connection refused");
      },
    } as unknown as VectorStore;

    const md = await buildBrainClaudeMd({
      soulPath,
      vectorStore: brokenStore,
      embedder: makeFakeEmbedder(),
    });

    // Should not throw, should gracefully skip
    assert.ok(
      md.includes("Memory recall failed"),
      "Should note memory failure",
    );
    assert.ok(md.includes("## Voice Mode"), "Other sections should still exist");
  });

  // Cleanup
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
});
