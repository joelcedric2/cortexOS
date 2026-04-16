import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  HeuristicClassifier,
  createHeuristicClassifier,
} from "../src/classifier/heuristic-classifier.js";
import { LlmClassifier } from "../src/classifier/sonnet-classifier.js";
import { createClassifier } from "../src/classifier/index.js";

describe("HeuristicClassifier — signal table", () => {
  const h = new HeuristicClassifier();

  const table: Array<[string, "single-shot" | "multi-agent", string]> = [
    ["check the battery level", "single-shot", "check"],
    ["look up this error message", "single-shot", "look up"],
    ["what is MCP?", "single-shot", "what is"],
    ["summarize today's inbox", "single-shot", "summarize"],
    ["quick calc for me", "single-shot", "quick"],
    ["give me a one-liner awk script", "single-shot", "one-liner"],
    ["read docs/NCHINDA_PLAN.md", "single-shot", "read"],
    ["list running agents", "single-shot", "list"],
    ["search memory for login failures", "single-shot", "search"],
    [
      "plan out the migration from pg to sqlite",
      "multi-agent",
      "plan keyword",
    ],
    [
      "architect a new inter-agent protocol",
      "multi-agent",
      "architect keyword",
    ],
    ["design the onboarding flow", "multi-agent", "design the phrase"],
    ["ship feature && update docs", "multi-agent", "&& compound"],
    ["refactor the codebase to use zod v4", "multi-agent", "refactor phrase"],
  ];

  for (const [input, expected, label] of table) {
    test(`${label}: "${input}" → ${expected}`, async () => {
      const r = await h.classify(input);
      assert.equal(r.complexity, expected, r.rationale);
      assert.ok(r.confidence >= 0 && r.confidence <= 1);
      assert.ok(r.rationale.length > 0);
    });
  }

  test("long task (>100 words) forces multi-agent", async () => {
    const long = "alpha ".repeat(120).trim();
    const r = await h.classify(long);
    assert.equal(r.complexity, "multi-agent");
    assert.ok(r.confidence >= 0.7);
  });

  test("empty task defaults to multi-agent with low confidence", async () => {
    const r = await h.classify("   ");
    assert.equal(r.complexity, "multi-agent");
    assert.ok(r.confidence < 0.5);
  });

  test("ambiguous task defaults to multi-agent @0.5", async () => {
    const r = await h.classify("do the thing we talked about");
    assert.equal(r.complexity, "multi-agent");
    assert.equal(r.confidence, 0.5);
  });

  test("suggested_role populated for research-like single-shot", async () => {
    const r = await h.classify("summarize today's inbox");
    assert.equal(r.complexity, "single-shot");
    assert.equal(r.suggested_role, "researcher");
  });

  test("createHeuristicClassifier returns usable instance", async () => {
    const c = createHeuristicClassifier();
    const r = await c.classify("check status");
    assert.ok(r.complexity);
  });
});

describe("LlmClassifier — mocked fetch", () => {
  const makeOkFetch = (payload: unknown): typeof fetch =>
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

  test("parses well-formed JSON into a ClassificationResult", async () => {
    const c = new LlmClassifier({
      apiKey: "test-key",
      fetchImpl: makeOkFetch({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              complexity: "single-shot",
              confidence: 0.9,
              rationale: "simple lookup",
              suggested_role: "researcher",
            }),
          },
        ],
      }),
      timeoutMs: 2000,
    });
    const r = await c.classify("what is the capital of France?");
    assert.equal(r.complexity, "single-shot");
    assert.equal(r.confidence, 0.9);
    assert.equal(r.suggested_role, "researcher");
  });

  test("extracts JSON even when wrapped in prose", async () => {
    const c = new LlmClassifier({
      apiKey: "test-key",
      fetchImpl: makeOkFetch({
        content: [
          {
            type: "text",
            text:
              "Sure! Here's the JSON:\n" +
              JSON.stringify({
                complexity: "multi-agent",
                confidence: 0.7,
                rationale: "plan keyword",
              }),
          },
        ],
      }),
      timeoutMs: 2000,
    });
    const r = await c.classify("plan migration");
    assert.equal(r.complexity, "multi-agent");
  });

  test("falls back to heuristic on 500", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response("boom", { status: 500 });
    const c = new LlmClassifier({
      apiKey: "test-key",
      fetchImpl: mockFetch,
      timeoutMs: 2000,
    });
    const r = await c.classify("summarize the inbox");
    assert.equal(r.complexity, "single-shot");
    assert.match(r.rationale, /llm-fallback/);
  });

  test("force_heuristic bypasses the API entirely", async () => {
    let called = false;
    const mockFetch: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const c = new LlmClassifier({
      apiKey: "test-key",
      fetchImpl: mockFetch,
      timeoutMs: 2000,
    });
    await c.classify("summarize", undefined, { force_heuristic: true });
    assert.equal(called, false);
  });

  test("no API key → falls through to heuristic without calling fetch", async () => {
    let called = false;
    const mockFetch: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const c = new LlmClassifier({
      apiKey: undefined,
      fetchImpl: mockFetch,
      timeoutMs: 2000,
    });
    const r = await c.classify("summarize");
    assert.equal(called, false);
    assert.equal(r.complexity, "single-shot");
  });

  test("malformed text body triggers heuristic fallback", async () => {
    const c = new LlmClassifier({
      apiKey: "test-key",
      fetchImpl: makeOkFetch({
        content: [{ type: "text", text: "not json at all" }],
      }),
      timeoutMs: 2000,
    });
    const r = await c.classify("summarize the inbox");
    assert.equal(r.complexity, "single-shot");
    assert.match(r.rationale, /llm-fallback/);
  });

  test("schema rejection (bad confidence type) falls back", async () => {
    const c = new LlmClassifier({
      apiKey: "test-key",
      fetchImpl: makeOkFetch({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              complexity: "single-shot",
              confidence: "high", // wrong type
              rationale: "hmm",
            }),
          },
        ],
      }),
      timeoutMs: 2000,
    });
    const r = await c.classify("check status");
    assert.match(r.rationale, /llm-fallback/);
  });

  test("very long task (>100 words) still classifiable via LLM stub", async () => {
    const c = new LlmClassifier({
      apiKey: "test-key",
      fetchImpl: makeOkFetch({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              complexity: "multi-agent",
              confidence: 0.95,
              rationale: "epic scope",
            }),
          },
        ],
      }),
      timeoutMs: 2000,
    });
    const long = "word ".repeat(200).trim();
    const r = await c.classify(long);
    assert.equal(r.complexity, "multi-agent");
  });
});

describe("createClassifier factory", () => {
  test("mode=heuristic always returns the heuristic", async () => {
    const c = createClassifier({ mode: "heuristic" });
    const r = await c.classify("plan a migration");
    assert.equal(r.complexity, "multi-agent");
  });

  test("mode=auto with no API key → heuristic behavior", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const c = createClassifier({ mode: "auto" });
      const r = await c.classify("what is the time?");
      assert.equal(r.complexity, "single-shot");
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
