import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VoiceMemory } from "../src/voice/voice-memory.js";
import type { VoiceMemoryDeps } from "../src/voice/voice-memory.js";
import type { VectorStore, MemorySearchResult } from "../src/memory/vector-store.js";
import type { Embedder } from "../src/memory/embedder.js";
import type { EventBus, AgentEvent } from "../src/ipc/event-bus.js";
import { getVoiceContextSection } from "../src/voice/voice-memory-hook.js";

/* ------------------------------------------------------------------ */
/*  Mock factories                                                     */
/* ------------------------------------------------------------------ */

function createMockEmbedder(): Embedder {
  return {
    embed: async (text: string) => {
      // Deterministic fake embedding: hash of first 3 chars → 384-dim
      const seed = text.charCodeAt(0) + (text.charCodeAt(1) ?? 0);
      return Array.from({ length: 384 }, (_, i) => (seed + i) / 1000);
    },
    embedBatch: async (texts: string[]) =>
      Promise.all(texts.map((t) => createMockEmbedder().embed(t))),
    initialize: async () => {},
  } as unknown as Embedder;
}

function createMockVectorStore() {
  const stored: Array<{
    id: string;
    agentRole: string;
    taskType: string;
    content: string;
    embedding: number[];
    outcome: "success" | "fail";
    tags: string[];
  }> = [];
  let idCounter = 0;

  const store: VectorStore = {
    storeMemory: async (record) => {
      const id = `mem-${++idCounter}`;
      stored.push({ id, ...record });
      return id;
    },
    searchMemories: async (_embedding, topK, filters) => {
      let results = [...stored];
      if (filters?.agentRole) {
        results = results.filter((r) => r.agentRole === filters.agentRole);
      }
      return results.slice(0, topK).map((r, i) => ({
        ...r,
        createdAt: new Date(Date.now() - i * 60_000), // each 1 min apart
        similarity: 0.9 - i * 0.1,
      })) as MemorySearchResult[];
    },
    updateMemory: async (id, patch) => {
      const record = stored.find((r) => r.id === id);
      if (!record) return;
      if (patch.outcome) record.outcome = patch.outcome;
      if (patch.addTags) record.tags = [...record.tags, ...patch.addTags];
    },
  } as unknown as VectorStore;

  return { store, stored };
}

function createMockBus() {
  const events: AgentEvent[] = [];
  const bus: EventBus = {
    emit: (event: AgentEvent) => {
      events.push(event);
    },
    subscribe: () => () => {},
    once: async () => ({ kind: "done" as const, ts: new Date() }),
  } as unknown as EventBus;
  return { bus, events };
}

function createDeps() {
  const embedder = createMockEmbedder();
  const { store: vectorStore, stored } = createMockVectorStore();
  const { bus, events } = createMockBus();
  const deps: VoiceMemoryDeps = { vectorStore, embedder, bus };
  return { deps, stored, events, vectorStore };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("VoiceMemory", () => {
  let vm: VoiceMemory;
  let stored: ReturnType<typeof createDeps>["stored"];
  let events: AgentEvent[];

  beforeEach(() => {
    const ctx = createDeps();
    vm = new VoiceMemory(ctx.deps);
    stored = ctx.stored;
    events = ctx.events;
  });

  describe("storeInteraction()", () => {
    test("calls vectorStore.storeMemory with correct fields", async () => {
      const id = await vm.storeInteraction({
        transcript: "What time is it?",
        reply: "It's 8:30 PM Central.",
        outcome: "success",
        durationMs: 1500,
      });

      assert.equal(id, "mem-1");
      assert.equal(stored.length, 1);
      const rec = stored[0]!;
      assert.equal(rec.agentRole, "nchinda-voice");
      assert.equal(rec.taskType, "voice_interaction");
      assert.equal(rec.content, "Voice Q: What time is it?\nVoice A: It's 8:30 PM Central.");
      assert.equal(rec.outcome, "success");
      assert.deepEqual(rec.tags, ["voice", "default"]);
      assert.equal(rec.embedding.length, 384);
    });

    test("maps 'recovered' outcome to 'success' with tag", async () => {
      await vm.storeInteraction({
        transcript: "Do X",
        reply: "Done with retry",
        outcome: "recovered",
        durationMs: 3000,
      });

      const rec = stored[0]!;
      assert.equal(rec.outcome, "success");
      assert.ok(rec.tags.includes("recovered"));
    });

    test("uses sessionLabel when provided", async () => {
      await vm.storeInteraction({
        transcript: "Test",
        reply: "OK",
        outcome: "success",
        durationMs: 100,
        sessionLabel: "morning-standup",
      });

      assert.ok(stored[0]!.tags.includes("morning-standup"));
      assert.ok(!stored[0]!.tags.includes("default"));
    });

    test("emits bus event with VOICE_MEMORY_STORED phase", async () => {
      await vm.storeInteraction({
        transcript: "A very long transcript that exceeds fifty characters in length for truncation test purposes",
        reply: "Short reply",
        outcome: "success",
        durationMs: 200,
      });

      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.kind, "plan_emitted");
      const payload = ev.payload as { phase: string; transcript: string };
      assert.equal(payload.phase, "VOICE_MEMORY_STORED");
      // Truncated to 50 chars
      assert.ok(payload.transcript.length <= 50);
    });
  });

  describe("recallRecentInteractions()", () => {
    test("formats results as readable markdown", async () => {
      // Store 2 interactions
      await vm.storeInteraction({
        transcript: "What time is it?",
        reply: "It's 8:30 PM Central",
        outcome: "success",
        durationMs: 1000,
      });
      await vm.storeInteraction({
        transcript: "Review my PR",
        reply: "Found 3 issues in the codebase",
        outcome: "success",
        durationMs: 5000,
      });

      const result = await vm.recallRecentInteractions();

      assert.ok(result.startsWith("## Recent Voice Interactions"));
      assert.ok(result.includes("[success]"));
      assert.ok(result.includes("What time is it?"));
      assert.ok(result.includes("Review my PR"));
    });

    test("returns empty string when no memories exist", async () => {
      // Create a fresh VoiceMemory with empty store
      const emptyCtx = createDeps();
      const emptyVm = new VoiceMemory(emptyCtx.deps);

      const result = await emptyVm.recallRecentInteractions();
      assert.equal(result, "");
    });

    test("respects topK parameter", async () => {
      // Store 3 interactions
      for (let i = 0; i < 3; i++) {
        await vm.storeInteraction({
          transcript: `Question ${i}`,
          reply: `Answer ${i}`,
          outcome: "success",
          durationMs: 100,
        });
      }

      const result = await vm.recallRecentInteractions(2);
      // Should have exactly 2 numbered items
      const matches = result.match(/^\d+\./gm);
      assert.equal(matches?.length, 2);
    });
  });

  describe("markFailed()", () => {
    test("updates outcome to fail and adds anti-pattern tag", async () => {
      const id = await vm.storeInteraction({
        transcript: "Do something",
        reply: "Done",
        outcome: "success",
        durationMs: 100,
      });

      await vm.markFailed(id);

      const rec = stored[0]!;
      assert.equal(rec.outcome, "fail");
      assert.ok(rec.tags.includes("anti-pattern:voice"));
    });
  });

  describe("integration: store 3 → recall returns them in order", () => {
    test("stores and recalls multiple interactions", async () => {
      const transcripts = [
        "First question",
        "Second question",
        "Third question",
      ];

      for (let i = 0; i < transcripts.length; i++) {
        await vm.storeInteraction({
          transcript: transcripts[i]!,
          reply: `Answer ${i + 1}`,
          outcome: "success",
          durationMs: 100 * (i + 1),
        });
      }

      assert.equal(stored.length, 3);
      const result = await vm.recallRecentInteractions(10);
      assert.ok(result.includes("First question"));
      assert.ok(result.includes("Second question"));
      assert.ok(result.includes("Third question"));
    });
  });
});

describe("getVoiceContextSection()", () => {
  test("returns empty string when voiceMemory is undefined", async () => {
    const result = await getVoiceContextSection(undefined);
    assert.equal(result, "");
  });

  test("delegates to voiceMemory.recallRecentInteractions()", async () => {
    const ctx = createDeps();
    const vm = new VoiceMemory(ctx.deps);

    // Store an interaction so recall finds something
    await vm.storeInteraction({
      transcript: "Hello",
      reply: "Hi there",
      outcome: "success",
      durationMs: 100,
    });

    const result = await getVoiceContextSection(vm, 3);
    assert.ok(result.includes("## Recent Voice Interactions"));
    assert.ok(result.includes("Hello"));
  });

  test("returns empty string on error", async () => {
    const failing = {
      recallRecentInteractions: async () => {
        throw new Error("DB down");
      },
    } as unknown as VoiceMemory;

    const result = await getVoiceContextSection(failing);
    assert.equal(result, "");
  });
});
