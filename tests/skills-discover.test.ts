import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { skillDiscover, extractKeywords } from "../src/skills/discover.js";

// ─── Mock GitHub response ───────────────────────────────────────────────────

function makeGhResponse(items: Array<{
  name: string;
  full_name: string;
  stars: number;
  license_spdx: string | null;
  pushed_at?: string;
  description?: string;
}>) {
  return {
    items: items.map((r) => ({
      name: r.name,
      full_name: r.full_name,
      html_url: `https://github.com/${r.full_name}`,
      description: r.description ?? null,
      stargazers_count: r.stars,
      license: r.license_spdx ? { spdx_id: r.license_spdx } : null,
      pushed_at: r.pushed_at ?? "2025-06-01T00:00:00Z",
    })),
  };
}

describe("skillDiscover", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns candidates sorted by relevance_score descending", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify(makeGhResponse([
        { name: "low-stars", full_name: "a/low-stars", stars: 200, license_spdx: "MIT" },
        { name: "high-stars", full_name: "b/high-stars", stars: 5000, license_spdx: "MIT" },
        { name: "mid-stars", full_name: "c/mid-stars", stars: 1000, license_spdx: "Apache-2.0" },
      ])), { status: 200 }),
    ) as typeof globalThis.fetch;

    const results = await skillDiscover("tiktok scraper tool", { token: "fake" });
    assert.ok(results.length === 3);
    assert.ok(results[0].relevance_score >= results[1].relevance_score);
    assert.ok(results[1].relevance_score >= results[2].relevance_score);
    assert.equal(results[0].name, "high-stars");
  });

  test("filters out non-accepted licenses (GPL)", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify(makeGhResponse([
        { name: "gpl-repo", full_name: "a/gpl-repo", stars: 9000, license_spdx: "GPL-3.0" },
        { name: "mit-repo", full_name: "b/mit-repo", stars: 500, license_spdx: "MIT" },
      ])), { status: 200 }),
    ) as typeof globalThis.fetch;

    const results = await skillDiscover("scraper", { token: "fake" });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, "mit-repo");
  });

  test("filters out repos with null license", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify(makeGhResponse([
        { name: "no-license", full_name: "a/no-license", stars: 3000, license_spdx: null },
        { name: "isc-repo", full_name: "b/isc-repo", stars: 200, license_spdx: "ISC" },
      ])), { status: 200 }),
    ) as typeof globalThis.fetch;

    const results = await skillDiscover("parser tool", { token: "fake" });
    assert.equal(results.length, 1);
    assert.equal(results[0].license, "ISC");
  });

  test("returns [] on HTTP error", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    ) as typeof globalThis.fetch;

    const results = await skillDiscover("something", { token: "fake" });
    assert.deepEqual(results, []);
  });

  test("returns [] on network error", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;

    const results = await skillDiscover("something", { token: "fake" });
    assert.deepEqual(results, []);
  });

  test("returns [] for empty need string", async () => {
    const results = await skillDiscover("", { token: "fake" });
    assert.deepEqual(results, []);
  });

  test("returns [] for stopwords-only need", async () => {
    const results = await skillDiscover("the a an is", { token: "fake" });
    assert.deepEqual(results, []);
  });

  test("returns [] on invalid JSON response", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response("not json{{{", { status: 200 }),
    ) as typeof globalThis.fetch;

    const results = await skillDiscover("scraper", { token: "fake" });
    assert.deepEqual(results, []);
  });

  test("accepts BSD and MPL licenses", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify(makeGhResponse([
        { name: "bsd-repo", full_name: "a/bsd-repo", stars: 300, license_spdx: "BSD-3-Clause" },
        { name: "mpl-repo", full_name: "b/mpl-repo", stars: 400, license_spdx: "MPL-2.0" },
      ])), { status: 200 }),
    ) as typeof globalThis.fetch;

    const results = await skillDiscover("utility lib", { token: "fake" });
    assert.equal(results.length, 2);
  });
});

describe("extractKeywords", () => {
  test("removes stopwords and limits to 5", () => {
    const kw = extractKeywords("I need a tool for scraping TikTok profiles and data");
    assert.ok(kw.length <= 5);
    assert.ok(!kw.includes("i"));
    assert.ok(!kw.includes("a"));
    assert.ok(!kw.includes("for"));
    assert.ok(!kw.includes("and"));
    assert.ok(kw.includes("scraping"));
    assert.ok(kw.includes("tiktok"));
  });

  test("lowercases keywords", () => {
    const kw = extractKeywords("Figma React Converter");
    for (const k of kw) {
      assert.equal(k, k.toLowerCase());
    }
  });

  test("returns empty for empty string", () => {
    assert.deepEqual(extractKeywords(""), []);
  });

  test("strips non-alpha chars", () => {
    const kw = extractKeywords("hello!!! world??? test...");
    assert.ok(kw.includes("hello"));
    assert.ok(kw.includes("world"));
  });
});
