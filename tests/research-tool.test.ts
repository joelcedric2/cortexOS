/**
 * Round-trip test for the nchinda_research MCP handler.
 *
 * Wires the ResearchTool with an in-memory event bus + a scripted Haiku
 * fetch, calls `.research(...)`, and verifies the Brief + the emitted
 * research_brief_emitted event.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ResearchTool } from "../src/mcp/research-tool.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import type { AgentEvent } from "../src/ipc/event-bus.js";

function haikuContent(json: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
  };
}

function scriptedFetch(responses: Array<{ body: unknown }>): typeof fetch {
  let idx = 0;
  return async () => {
    const resp = responses[idx] ?? responses[responses.length - 1]!;
    idx++;
    return new Response(JSON.stringify(resp.body), { status: 200 });
  };
}

describe("ResearchTool.research (MCP round-trip)", () => {
  test("happy path: question → Brief with winning + confidence", async () => {
    const bus = createEventBus();
    const briefEvents: AgentEvent[] = [];
    bus.subscribe({ kind: "research_brief_emitted" }, (e) =>
      briefEvents.push(e),
    );

    const fetchImpl = scriptedFetch([
      {
        body: haikuContent({
          hypotheses: [
            { h: "cache poisoned", prior: 0.4, probe: "clear and retry" },
            { h: "rate-limited", prior: 0.6, probe: "sleep 60 and retry" },
          ],
        }),
      },
      {
        body: haikuContent({
          scores: [
            { id: "h1", likelihood: 0.2, verdict: "falsified" },
            { id: "h2", likelihood: 0.9, verdict: "confirmed" },
          ],
        }),
      },
      {
        body: haikuContent({
          winning: "rate-limited",
          evidence: ["retry-after header = 60"],
          open_questions: [],
          recommended_action: "back off 60s and retry",
        }),
      },
    ]);

    const tool = new ResearchTool({
      runtime: { apiKey: "test", fetchImpl, bus },
    });

    const brief = await tool.research({
      question: "why is the API returning 429?",
    });

    assert.equal(brief.question, "why is the API returning 429?");
    assert.equal(brief.winning, "rate-limited");
    assert.ok(brief.confidence > 0.5);
    assert.equal(brief.recommended_action, "back off 60s and retry");

    // Bus saw the brief
    assert.equal(briefEvents.length, 1);
    const payload = briefEvents[0]!.payload as {
      winning: string;
      confidence: number;
    };
    assert.equal(payload.winning, "rate-limited");
  });

  test("depth=deep propagates to the loop (5 hypothesis cap)", async () => {
    const fetchImpl = scriptedFetch([
      {
        body: haikuContent({
          hypotheses: [
            { h: "A", prior: 0.2, probe: "pa" },
            { h: "B", prior: 0.2, probe: "pb" },
            { h: "C", prior: 0.2, probe: "pc" },
            { h: "D", prior: 0.2, probe: "pd" },
            { h: "E", prior: 0.2, probe: "pe" },
          ],
        }),
      },
      {
        body: haikuContent({
          scores: [
            { id: "h1", likelihood: 0.5, verdict: "inconclusive" },
            { id: "h2", likelihood: 0.5, verdict: "inconclusive" },
            { id: "h3", likelihood: 0.5, verdict: "inconclusive" },
            { id: "h4", likelihood: 0.5, verdict: "inconclusive" },
            { id: "h5", likelihood: 0.5, verdict: "inconclusive" },
          ],
        }),
      },
      {
        body: haikuContent({
          evidence: [],
          open_questions: [],
          recommended_action: "gather more data",
        }),
      },
    ]);

    const tool = new ResearchTool({
      runtime: { apiKey: "test", fetchImpl },
    });

    const brief = await tool.research({ question: "q", depth: "deep" });
    assert.equal(brief.hypotheses.length, 5);
  });

  test("timeBudgetMs override propagates", async () => {
    const slow = async (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        const onAbort = () => reject(new Error("aborted"));
        if (sig) {
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
      });
    };
    const tool = new ResearchTool({
      runtime: { apiKey: "test", fetchImpl: slow as typeof fetch },
    });

    const t0 = Date.now();
    const brief = await tool.research({
      question: "q",
      timeBudgetMs: 1_000,
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3_000, `aborted quickly, took ${elapsed}ms`);
    assert.equal(brief.recommended_action, "research-failed");
  });

  test("zod rejects empty question", async () => {
    const tool = new ResearchTool({ runtime: { apiKey: "test" } });
    await assert.rejects(
      () => tool.research({ question: "" }),
      /question/i,
    );
  });

  test("zod rejects depth outside enum", async () => {
    const tool = new ResearchTool({ runtime: { apiKey: "test" } });
    await assert.rejects(() =>
      tool.research({ question: "q", depth: "extreme" as unknown as "deep" }),
    );
  });
});
