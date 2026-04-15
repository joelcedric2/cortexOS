import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  webSearch,
  TavilyAdapter,
  DuckDuckGoHtmlAdapter,
  __resetDdgWarnedForTests,
  type SearchResult,
  type WebSearchAdapter,
} from "../src/tools/web-search.js";

// --------------------------- Fixtures -------------------------------------

function makeJsonFetch(
  body: unknown,
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
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function makeHtmlFetch(html: string): typeof fetch {
  return (async () =>
    new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
}

// --------------------------- Tests ----------------------------------------

describe("webSearch — adapter selection", () => {
  beforeEach(() => {
    __resetDdgWarnedForTests();
    delete process.env.TAVILY_API_KEY;
  });

  test("uses explicit adapter when provided", async () => {
    const stub: WebSearchAdapter = {
      name: "stub",
      async search() {
        return [{ title: "T", url: "https://x", snippet: "S" }];
      },
    };
    const out = await webSearch("anything", { adapter: stub });
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "T");
  });

  test("falls back to DuckDuckGo when no API key", async () => {
    const html =
      '<a class="result__a" href="https://a.example/">A Title</a>' +
      '<a class="result__snippet">A snippet here.</a>' +
      '<a class="result__a" href="https://b.example/">B Title</a>' +
      '<a class="result__snippet">B snippet.</a>';
    const out = await webSearch("claude code", {
      fetchImpl: makeHtmlFetch(html),
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].title, "A Title");
    assert.equal(out[0].url, "https://a.example/");
    assert.equal(out[1].url, "https://b.example/");
  });

  test("uses Tavily when apiKey in opts", async () => {
    const fetchImpl = makeJsonFetch({
      results: [
        {
          title: "Claude Code docs",
          url: "https://docs.claude.com",
          content: "Claude Code CLI",
          score: 0.9,
        },
      ],
    });
    const out = await webSearch("claude code", {
      apiKey: "test-key",
      fetchImpl,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "Claude Code docs");
    assert.equal(out[0].relevance, 0.9);
  });
});

describe("TavilyAdapter", () => {
  test("scripted fetch returns valid results with relevance", async () => {
    const fetchImpl = makeJsonFetch({
      results: [
        {
          title: "A",
          url: "https://a",
          snippet: "alpha",
          score: 0.8,
        },
        {
          title: "B",
          url: "https://b",
          content: "beta",
          score: 0.5,
        },
      ],
    });
    const adapter = new TavilyAdapter({ apiKey: "k", fetchImpl });
    const results = await adapter.search("hi");
    assert.equal(results.length, 2);
    assert.equal(results[0].snippet, "alpha");
    assert.equal(results[1].snippet, "beta");
    assert.equal(results[0].relevance, 0.8);
  });

  test("aborts on slow fetch via timeoutMs", async () => {
    const fetchImpl = makeJsonFetch({ results: [] }, { delayMs: 500 });
    const adapter = new TavilyAdapter({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 50,
    });
    await assert.rejects(() => adapter.search("hi"));
  });

  test("zod rejects malformed API response — webSearch returns []", async () => {
    const fetchImpl = makeJsonFetch({ oops: "bad shape" });
    const out = await webSearch("hi", { apiKey: "k", fetchImpl });
    assert.deepEqual(out, []);
  });

  test("snippet truncation to 500 chars enforced", async () => {
    const long = "x".repeat(1200);
    const fetchImpl = makeJsonFetch({
      results: [
        { title: "t", url: "https://u", content: long, score: 0.1 },
      ],
    });
    const out = await webSearch("hi", { apiKey: "k", fetchImpl });
    assert.equal(out.length, 1);
    assert.equal(out[0].snippet.length, 500);
  });
});

describe("DuckDuckGoHtmlAdapter", () => {
  beforeEach(() => __resetDdgWarnedForTests());

  test("extracts title/url/snippet triples from HTML", async () => {
    const html =
      '<div><a class="result__a" href="https://x.example/?q=1">Example One</a>' +
      '<a class="result__snippet">snippet one</a></div>' +
      '<div><a class="result__a" href="https://y.example/">Example Two</a>' +
      '<a class="result__snippet">snippet two &amp; more</a></div>';
    const adapter = new DuckDuckGoHtmlAdapter({ fetchImpl: makeHtmlFetch(html) });
    const results = await adapter.search("q", 5);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, "Example One");
    assert.equal(results[0].url, "https://x.example/?q=1");
    assert.equal(results[1].snippet, "snippet two & more");
  });

  test("unwraps DDG redirect `uddg` parameter to real URL", async () => {
    const target = "https://real.example/page";
    const wrapped = "/l/?uddg=" + encodeURIComponent(target);
    const html =
      '<a class="result__a" href="' + wrapped + '">Redirected</a>' +
      '<a class="result__snippet">s</a>';
    const adapter = new DuckDuckGoHtmlAdapter({ fetchImpl: makeHtmlFetch(html) });
    const results = await adapter.search("q");
    assert.equal(results.length, 1);
    assert.equal(results[0].url, target);
  });

  test("strips HTML tags inside extracted fields — no script injection", async () => {
    const html =
      '<a class="result__a" href="https://z.example/">Good<script>alert(1)</script>Title</a>' +
      '<a class="result__snippet">snip<script>steal()</script>pet</a>';
    const adapter = new DuckDuckGoHtmlAdapter({ fetchImpl: makeHtmlFetch(html) });
    const results = await adapter.search("q");
    assert.equal(results.length, 1);
    assert.doesNotMatch(results[0].title, /<script>/);
    assert.doesNotMatch(results[0].snippet, /<script>/);
    assert.match(results[0].title, /Good/);
    assert.match(results[0].title, /Title/);
  });

  test("max 10 results even when HTML has more", async () => {
    let html = "";
    for (let i = 0; i < 25; i++) {
      html +=
        `<a class="result__a" href="https://u${i}.example/">T${i}</a>` +
        `<a class="result__snippet">s${i}</a>`;
    }
    const adapter = new DuckDuckGoHtmlAdapter({ fetchImpl: makeHtmlFetch(html) });
    const results = await adapter.search("q", 20);
    // Our hard cap is 10.
    assert.equal(results.length, 10);
  });
});

describe("webSearch — error swallowing", () => {
  test("network failure returns [] not throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const out = await webSearch("hi", { apiKey: "k", fetchImpl });
    assert.deepEqual(out, []);
  });

  test("empty query returns [] immediately", async () => {
    const out = await webSearch("   ");
    assert.deepEqual(out, []);
  });

  test("HTTP 500 from Tavily returns []", async () => {
    const fetchImpl = makeJsonFetch({}, { status: 500 });
    const out: SearchResult[] = await webSearch("hi", {
      apiKey: "k",
      fetchImpl,
    });
    assert.deepEqual(out, []);
  });
});
