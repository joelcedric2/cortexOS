/**
 * FallbackStrategy unit tests for rungs 4–7 (Nchinda §2.1 §Phase 3+).
 *
 * Each strategy is exercised with mocked deps so no MCP server / tmux / LLM
 * is required. The factory `defaultLadderStrategies` is also covered to
 * verify rung ordering and graceful degradation when deps are omitted.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AskPeerStrategy,
  RecallMemoryStrategy,
  WebSearchStrategy,
  EscalateStrategy,
  defaultLadderStrategies,
} from "../src/loop/fallback-strategies.js";
import type { FallbackContext } from "../src/loop/types.js";
import type { AgentRecord } from "../src/registry/agent-registry.js";
import type { AskPeerResult, EscalateResult } from "../src/mcp/nchinda-coordination.js";
import type { RecallHit } from "../src/mcp/nchinda-tools.js";
import type { SearchResult } from "../src/tools/web-search.js";

function ctx(partial: Partial<FallbackContext> = {}): FallbackContext {
  return {
    task: "original task",
    taskId: "t1",
    attempt: 1,
    lastError: new Error("something failed"),
    ...partial,
  };
}

function agent(
  role: string,
  status: AgentRecord["status"] = "running",
): AgentRecord {
  return {
    id: `${role.toUpperCase()}0`,
    role,
    color: "blue",
    tmux_session: `${role}-session`,
    worktree: null,
    status,
    task_id: "t1",
    started_at: new Date().toISOString(),
    last_heartbeat: null,
  };
}

// ─── Rung 4 — AskPeerStrategy ─────────────────────────────────────────────

describe("AskPeerStrategy (rung 4)", () => {
  test("canHandle=true when a running system-designer is in the registry", () => {
    const s = new AskPeerStrategy({
      listAgents: () => [agent("backend"), agent("system-designer")],
      askPeer: async () => ({ ok: false, reason: "no-peer" }),
    });
    assert.equal(s.rung, 4);
    assert.equal(s.canHandle(ctx()), true);
  });

  test("canHandle=false when the designer is absent or not running", () => {
    const noDesigner = new AskPeerStrategy({
      listAgents: () => [agent("backend")],
      askPeer: async () => ({ ok: false, reason: "no-peer" }),
    });
    assert.equal(noDesigner.canHandle(ctx()), false);

    const stoppedDesigner = new AskPeerStrategy({
      listAgents: () => [agent("system-designer", "done")],
      askPeer: async () => ({ ok: false, reason: "no-peer" }),
    });
    assert.equal(stoppedDesigner.canHandle(ctx()), false);
  });

  test("apply attaches the designer's answer to the next task on success", async () => {
    const peerResult: AskPeerResult = {
      ok: true,
      answer: "Switch to JWT with short-lived tokens.",
      correlation_id: "corr-1",
    };
    let called = 0;
    const s = new AskPeerStrategy({
      listAgents: () => [agent("system-designer")],
      askPeer: async () => {
        called += 1;
        return peerResult;
      },
    });
    const out = await s.apply(ctx({ lastError: new Error("timeout") }));
    assert.equal(called, 1);
    assert.equal(out.handled, true);
    assert.ok(out.nextTask?.includes("additional guidance from designer"));
    assert.ok(out.nextTask?.includes("Switch to JWT"));
    assert.equal(out.nextPlan, undefined);
  });

  test("apply returns handled=false when askPeer fails", async () => {
    const s = new AskPeerStrategy({
      listAgents: () => [agent("system-designer")],
      askPeer: async () => ({ ok: false, reason: "timeout" }),
    });
    const out = await s.apply(ctx());
    assert.equal(out.handled, false);
    assert.ok(out.note?.includes("timeout"));
  });

  test("custom designerRole is honored", () => {
    const s = new AskPeerStrategy({
      listAgents: () => [agent("architect")],
      askPeer: async () => ({ ok: false, reason: "no-peer" }),
      designerRole: "architect",
    });
    assert.equal(s.canHandle(ctx()), true);
  });
});

// ─── Rung 5 — RecallMemoryStrategy ────────────────────────────────────────

describe("RecallMemoryStrategy (rung 5)", () => {
  test("returns a hint when recall finds a similar success memory", async () => {
    const hit: RecallHit = {
      id: "mem-1",
      content: "Use `fetch` with AbortController to avoid hanging",
      agent_role: "backend",
      task_type: "general",
      outcome: "success",
      tags: ["http", "timeout"],
      similarity: 0.82,
      created_at: new Date().toISOString(),
    };
    const s = new RecallMemoryStrategy({
      recall: async () => [hit],
    });
    assert.equal(s.rung, 5);
    assert.equal(s.canHandle(ctx()), true);
    const out = await s.apply(ctx({ lastError: new Error("ETIMEDOUT fetching") }));
    assert.equal(out.handled, true);
    assert.ok(out.nextTask?.includes("hint from memory"));
    assert.ok(out.nextTask?.includes("Use `fetch`"));
  });

  test("handled=false when recall returns no hits above threshold", async () => {
    const lowSim: RecallHit = {
      id: "mem-2",
      content: "unrelated",
      agent_role: "backend",
      task_type: "general",
      outcome: "success",
      tags: [],
      similarity: 0.1,
      created_at: new Date().toISOString(),
    };
    const s = new RecallMemoryStrategy({
      recall: async () => [lowSim],
      minSimilarity: 0.5,
    });
    const out = await s.apply(ctx());
    assert.equal(out.handled, false);
  });

  test("handled=false when all recall hits are fails", async () => {
    const failHit: RecallHit = {
      id: "mem-3",
      content: "x",
      agent_role: "backend",
      task_type: "general",
      outcome: "fail",
      tags: [],
      similarity: 0.99,
      created_at: new Date().toISOString(),
    };
    const s = new RecallMemoryStrategy({ recall: async () => [failHit] });
    const out = await s.apply(ctx());
    assert.equal(out.handled, false);
  });

  test("handled=false when recall throws", async () => {
    const s = new RecallMemoryStrategy({
      recall: async () => {
        throw new Error("store offline");
      },
    });
    const out = await s.apply(ctx());
    assert.equal(out.handled, false);
    assert.ok(out.note?.includes("store offline"));
  });
});

// ─── Rung 6 — WebSearchStrategy ───────────────────────────────────────────

describe("WebSearchStrategy (rung 6)", () => {
  test("attaches top snippet when the adapter returns results", async () => {
    const result: SearchResult = {
      title: "Fixing ECONNRESET",
      url: "https://example.com/post",
      snippet: "Increase the connection pool size and retry with backoff.",
    };
    const s = new WebSearchStrategy({
      webSearch: async () => [result],
    });
    assert.equal(s.rung, 6);
    assert.equal(s.canHandle(ctx()), true);
    const out = await s.apply(ctx({ lastError: new Error("ECONNRESET upstream") }));
    assert.equal(out.handled, true);
    assert.ok(out.nextTask?.includes("web hint"));
    assert.ok(out.nextTask?.includes("example.com/post"));
    assert.ok(out.nextTask?.includes("connection pool"));
  });

  test("handled=false when the adapter returns zero results", async () => {
    const s = new WebSearchStrategy({
      webSearch: async () => [],
    });
    const out = await s.apply(ctx());
    assert.equal(out.handled, false);
    assert.ok(out.note?.includes("no web results"));
  });

  test("handled=false when webSearch throws", async () => {
    const s = new WebSearchStrategy({
      webSearch: async () => {
        throw new Error("DNS failure");
      },
    });
    const out = await s.apply(ctx());
    assert.equal(out.handled, false);
    assert.ok(out.note?.includes("DNS failure"));
  });

  test("snippet is truncated to maxSnippetChars", async () => {
    const long = "x".repeat(2000);
    const s = new WebSearchStrategy({
      webSearch: async () => [
        { title: "t", url: "u", snippet: long },
      ],
      maxSnippetChars: 50,
    });
    const out = await s.apply(ctx());
    const snippetPart = out.nextTask?.split("u): ")[1] ?? "";
    assert.ok(snippetPart.length <= 50);
  });
});

// ─── Rung 7 — EscalateStrategy ────────────────────────────────────────────

describe("EscalateStrategy (rung 7)", () => {
  test("canHandle always returns true (last resort)", () => {
    const s = new EscalateStrategy({
      escalate: () => ({ escalation_id: "e-1" }),
    });
    assert.equal(s.rung, 7);
    assert.equal(s.canHandle(ctx()), true);
  });

  test("apply calls escalate and flips the escalation flag", async () => {
    const seen: Array<{ id: string; detail: string }> = [];
    const result: EscalateResult = { escalation_id: "e-42" };
    const s = new EscalateStrategy({
      escalate: () => result,
      markEscalated: (id, detail) => seen.push({ id, detail }),
    });
    const out = await s.apply(ctx({ lastError: new Error("schema drift") }));
    assert.equal(out.handled, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, "e-42");
    assert.ok(seen[0].detail.includes("schema drift"));
    assert.ok(out.note?.includes("e-42"));
    // Next task preserved so the loop sees the original intent
    assert.equal(out.nextTask, "original task");
  });

  test("apply swallows escalate errors but still flags handled", async () => {
    const s = new EscalateStrategy({
      escalate: () => {
        throw new Error("escalations DB locked");
      },
    });
    const out = await s.apply(ctx());
    assert.equal(out.handled, true);
    assert.ok(out.note?.includes("threw"));
  });
});

// ─── defaultLadderStrategies factory ──────────────────────────────────────

describe("defaultLadderStrategies factory", () => {
  test("with no deps: returns rungs 1–3 only", () => {
    const s = defaultLadderStrategies();
    assert.deepEqual(
      s.map((x) => [x.rung, x.name]),
      [
        [1, "retry-same"],
        [2, "alternate-tool"],
        [3, "reduce-scope"],
      ],
    );
  });

  test("with all deps: returns rungs 1–7 in ascending order", () => {
    const s = defaultLadderStrategies({
      askPeer: {
        listAgents: () => [],
        askPeer: async () => ({ ok: false, reason: "no-peer" }),
      },
      recallMemory: { recall: async () => [] },
      webSearch: { webSearch: async () => [] },
      escalate: { escalate: () => ({ escalation_id: "e" }) },
    });
    assert.deepEqual(
      s.map((x) => [x.rung, x.name]),
      [
        [1, "retry-same"],
        [2, "alternate-tool"],
        [3, "reduce-scope"],
        [4, "ask-peer"],
        [5, "recall-memory"],
        [6, "web-search"],
        [7, "escalate"],
      ],
    );
  });

  test("only recall wired: rungs 1–3 + rung 5, skipping 4/6/7", () => {
    const s = defaultLadderStrategies({
      recallMemory: { recall: async () => [] },
    });
    const rungs = s.map((x) => x.rung);
    assert.deepEqual(rungs, [1, 2, 3, 5]);
  });
});
