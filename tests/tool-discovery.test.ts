import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { toolDiscovery } from "../src/tools/tool-discovery.js";

// --------------------------- Fixtures -------------------------------------

function makeHaikuFetch(
  haikuText: string,
  opts: { status?: number; delayMs?: number } = {},
): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    if (opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    }
    const body = {
      content: [{ type: "text", text: haikuText }],
    };
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const CATALOG = [
  { name: "shell", description: "Run a command-line binary." },
  { name: "docs_fetch", description: "Fetch and extract a URL." },
  { name: "web_search", description: "Search the web." },
  { name: "nchinda_recall", description: "Semantic memory search." },
  { name: "nchinda_remember", description: "Write to long-term memory." },
];

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

// --------------------------- Tests ----------------------------------------

describe("toolDiscovery", () => {
  test("returns [] when no API key configured", async () => {
    const out = await toolDiscovery("find a file by pattern");
    assert.deepEqual(out, []);
  });

  test("returns [] for empty need", async () => {
    const out = await toolDiscovery("   ", { apiKey: "k" });
    assert.deepEqual(out, []);
  });

  test("trims to top 3 sorted by confidence", async () => {
    const haikuText = JSON.stringify({
      suggestions: [
        { name: "shell", confidence: 0.95, rationale: "file pattern search" },
        { name: "docs_fetch", confidence: 0.3, rationale: "weak fit" },
        { name: "web_search", confidence: 0.6, rationale: "if remote" },
        { name: "nchinda_recall", confidence: 0.8, rationale: "past patterns" },
        { name: "nchinda_remember", confidence: 0.1, rationale: "no" },
      ],
    });
    const out = await toolDiscovery("find a file by pattern", {
      apiKey: "k",
      fetchImpl: makeHaikuFetch(haikuText),
      catalog: CATALOG,
    });
    assert.equal(out.length, 3);
    assert.equal(out[0].name, "shell");
    assert.equal(out[1].name, "nchinda_recall");
    assert.equal(out[2].name, "web_search");
    assert.ok(out[0].confidence > 0.5);
  });

  test("returns [] on Haiku HTTP error", async () => {
    const out = await toolDiscovery("anything", {
      apiKey: "k",
      fetchImpl: makeHaikuFetch("", { status: 500 }),
      catalog: CATALOG,
    });
    assert.deepEqual(out, []);
  });

  test("returns [] on malformed Haiku JSON (zod rejection)", async () => {
    const haikuText = JSON.stringify({
      suggestions: [
        { name: "shell", confidence: "high", rationale: "!" }, // confidence is wrong type
      ],
    });
    const out = await toolDiscovery("anything", {
      apiKey: "k",
      fetchImpl: makeHaikuFetch(haikuText),
      catalog: CATALOG,
    });
    assert.deepEqual(out, []);
  });

  test("returns [] when Haiku response has no JSON block", async () => {
    const out = await toolDiscovery("anything", {
      apiKey: "k",
      fetchImpl: makeHaikuFetch("I cannot help with that."),
      catalog: CATALOG,
    });
    assert.deepEqual(out, []);
  });

  test("drops suggestions pointing at tools not in catalog", async () => {
    const haikuText = JSON.stringify({
      suggestions: [
        { name: "shell", confidence: 0.9, rationale: "ok" },
        { name: "hallucinated_tool", confidence: 0.99, rationale: "fake" },
      ],
    });
    const out = await toolDiscovery("find file", {
      apiKey: "k",
      fetchImpl: makeHaikuFetch(haikuText),
      catalog: CATALOG,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "shell");
  });

  test("respects custom catalog injection", async () => {
    const customCatalog = [
      { name: "my_custom_tool", description: "Does a custom thing." },
    ];
    const haikuText = JSON.stringify({
      suggestions: [
        { name: "my_custom_tool", confidence: 0.8, rationale: "fits" },
      ],
    });
    const out = await toolDiscovery("custom thing", {
      apiKey: "k",
      fetchImpl: makeHaikuFetch(haikuText),
      catalog: customCatalog,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "my_custom_tool");
    assert.equal(out[0].confidence, 0.8);
  });

  test("aborts on slow Haiku response via timeoutMs", async () => {
    const out = await toolDiscovery("anything", {
      apiKey: "k",
      fetchImpl: makeHaikuFetch("{}", { delayMs: 500 }),
      timeoutMs: 30,
      catalog: CATALOG,
    });
    assert.deepEqual(out, []);
  });

  test("DoD: 'find a file by pattern' suggests shell with confidence > 0.5", async () => {
    const haikuText = JSON.stringify({
      suggestions: [
        { name: "shell", confidence: 0.85, rationale: "ls/grep/rg for patterns" },
      ],
    });
    const out = await toolDiscovery("find a file by pattern", {
      apiKey: "k",
      fetchImpl: makeHaikuFetch(haikuText),
      catalog: CATALOG,
    });
    const shell = out.find((s) => s.name === "shell");
    assert.ok(shell, "expected shell suggestion");
    assert.ok(shell.confidence > 0.5, "confidence should be > 0.5");
  });
});
