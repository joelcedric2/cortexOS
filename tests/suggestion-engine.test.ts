/**
 * Tests for the Phase 13 single-shot suggestion engine.
 *
 * All Haiku calls are mocked — no network. We exercise:
 *  - happy path (valid suggestion)
 *  - literal null ("fine as-is")
 *  - schema-invalid responses → null
 *  - HTTP non-ok → null
 *  - fetch rejection (timeout / network) → null
 *  - empty draft or missing API key → null
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { suggestOnce } from "../src/coach/suggestion-engine.js";
import type { DraftSample } from "../src/coach/draft-watcher.js";

function sample(overrides: Partial<DraftSample> = {}): DraftSample {
  return {
    app: "com.apple.mail",
    role: "AXTextArea",
    label: "Body",
    value: "Hi Mark, sorry to bother you but",
    ts: "2026-04-15T10:00:00.000Z",
    ...overrides,
  };
}

function fakeHaiku(text: string, { status = 200 }: { status?: number } = {}): typeof fetch {
  return (async () => {
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text }],
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("suggestOnce", () => {
  it("returns a suggestion when Haiku emits a well-formed object", async () => {
    const haiku = fakeHaiku(
      JSON.stringify({
        suggestion: "Drop the 'sorry to bother' — it undermines the ask.",
        severity: "note",
        reason: "apology-overuse",
      }),
    );
    const out = await suggestOnce(sample(), { haikuFetch: haiku, apiKey: "sk-test" });
    assert.ok(out);
    assert.equal(out?.severity, "note");
    assert.equal(out?.reason, "apology-overuse");
    assert.equal(out?.draft_value, "Hi Mark, sorry to bother you but");
  });

  it("returns null when Haiku replies with literal null", async () => {
    const haiku = fakeHaiku("null");
    const out = await suggestOnce(sample(), { haikuFetch: haiku, apiKey: "sk-test" });
    assert.equal(out, null);
  });

  it("returns null on zod schema mismatch", async () => {
    const haiku = fakeHaiku(
      JSON.stringify({ suggestion: "x", severity: "critical", reason: "nope" }),
    );
    const out = await suggestOnce(sample(), { haikuFetch: haiku, apiKey: "sk-test" });
    assert.equal(out, null);
  });

  it("returns null on HTTP 500", async () => {
    const haiku = fakeHaiku("ignored", { status: 500 });
    const out = await suggestOnce(sample(), { haikuFetch: haiku, apiKey: "sk-test" });
    assert.equal(out, null);
  });

  it("returns null when the fetch itself rejects", async () => {
    const haiku: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const out = await suggestOnce(sample(), { haikuFetch: haiku, apiKey: "sk-test" });
    assert.equal(out, null);
  });

  it("returns null when the timeout aborts (simulated)", async () => {
    const haiku: typeof fetch = ((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const out = await suggestOnce(sample(), {
      haikuFetch: haiku,
      apiKey: "sk-test",
      timeoutMs: 5,
    });
    assert.equal(out, null);
  });

  it("short-circuits when the draft value is empty", async () => {
    let called = false;
    const haiku: typeof fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const out = await suggestOnce(sample({ value: "   " }), {
      haikuFetch: haiku,
      apiKey: "sk-test",
    });
    assert.equal(out, null);
    assert.equal(called, false);
  });

  it("returns null when no API key is available", async () => {
    let called = false;
    const haiku: typeof fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const prev = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const out = await suggestOnce(sample(), { haikuFetch: haiku });
      assert.equal(out, null);
      assert.equal(called, false);
    } finally {
      if (prev !== undefined) process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });
});
