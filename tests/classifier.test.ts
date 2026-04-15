import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  HeuristicClassifier,
  createHeuristicClassifier,
} from "../src/classifier/heuristic-classifier.js";

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
