import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBrief,
  classifySentimentHeuristic,
  isPrivateApp,
  PRIVATE_APPS,
  type VisionSentiment,
} from "../src/perception/vision-brief.js";
import type { ScreenFrame, OcrResult } from "../src/perception/_c1-stub.js";

function makeFrame(overrides: Partial<ScreenFrame> = {}): ScreenFrame {
  return {
    id: "frame-1",
    ts: new Date("2026-04-15T12:00:00Z"),
    png_path: "/tmp/fake.png",
    active_app: "Safari",
    window_title: "Example — safari.com",
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

function ocrReturning(text: string, blocks: OcrResult["blocks"] = []) {
  return async (_p: string): Promise<OcrResult> => ({ text, blocks });
}

describe("vision-brief — local-only mode", () => {
  test("composes summary from active_app + window_title + heuristic", async () => {
    const frame = makeFrame({
      active_app: "Safari",
      window_title: "Claude — claude.ai",
      ocr_text: "Just reading some chat logs here.",
    });
    const brief = await buildBrief(frame);
    assert.equal(brief.active_app, "Safari");
    assert.equal(brief.window_title, "Claude — claude.ai");
    assert.ok(brief.summary.startsWith("Safari: Claude — claude.ai —"));
    assert.equal(brief.source_frame_id, "frame-1");
    assert.equal(brief.ts, "2026-04-15T12:00:00.000Z");
  });

  test("uses frame.ocr_text when present and skips ocr fn", async () => {
    let ocrCalled = false;
    const ocr = async (_p: string): Promise<OcrResult> => {
      ocrCalled = true;
      return { text: "should-not-be-used", blocks: [] };
    };
    const frame = makeFrame({ ocr_text: "inline-ocr-text" });
    const brief = await buildBrief(frame, { ocr });
    assert.equal(ocrCalled, false);
    assert.equal(brief.visible_text, "inline-ocr-text");
  });

  test("falls back to ocr() when frame.ocr_text is empty", async () => {
    const frame = makeFrame({ ocr_text: undefined });
    const brief = await buildBrief(frame, { ocr: ocrReturning("ocr-text") });
    assert.equal(brief.visible_text, "ocr-text");
  });

  test("truncates visible_text at 4000 chars", async () => {
    const giant = "x".repeat(5_000);
    const frame = makeFrame({ ocr_text: giant });
    const brief = await buildBrief(frame);
    assert.equal(brief.visible_text.length, 4_000);
  });

  test("ocr error does not crash — yields empty visible_text", async () => {
    const frame = makeFrame({ ocr_text: undefined });
    const brief = await buildBrief(frame, {
      ocr: async () => {
        throw new Error("vision helper crashed");
      },
    });
    assert.equal(brief.visible_text, "");
    assert.ok(brief.summary.length > 0);
  });

  test("private-app frames never emit an LLM call even in llm mode", async () => {
    let fetchCalled = false;
    const spy: typeof fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    const frame = makeFrame({
      active_app: "1Password",
      window_title: "All Items",
      ocr_text: "secret things",
    });
    const brief = await buildBrief(
      frame,
      {},
      { mode: "llm", apiKey: "x", fetchImpl: spy },
    );
    assert.equal(fetchCalled, false);
    assert.equal(brief.active_app, "1Password");
  });

  test("null active_app yields no-window-title line and idle sentiment", async () => {
    const frame = makeFrame({
      active_app: null,
      window_title: null,
      ocr_text: "",
    });
    const brief = await buildBrief(frame);
    assert.equal(brief.sentiment, "idle");
    assert.equal(brief.active_app, null);
    assert.equal(brief.window_title, null);
  });
});

describe("vision-brief — sentiment classification table", () => {
  const cases: Array<{
    label: string;
    app: string;
    title: string;
    text: string;
    expected: VisionSentiment;
  }> = [
    {
      label: "editor with content → composing",
      app: "VS Code",
      title: "vision-brief.ts — cortexOS",
      text: "export async function buildBrief(...) { return summary; }",
      expected: "composing",
    },
    {
      label: "Mail compose window → composing",
      app: "Mail",
      title: "New Message Draft — Re: Comp",
      text: "To: mark@example.com\nSubject: Compensation follow-up",
      expected: "composing",
    },
    {
      label: "browser on youtube → consuming",
      app: "Safari",
      title: "Intro to Zig — youtube.com",
      text: "Now playing. Up next: lecture 2",
      expected: "consuming",
    },
    {
      label: "blank everything → idle",
      app: "",
      title: "",
      text: "",
      expected: "idle",
    },
    {
      label: "browser reading long article → consuming",
      app: "Safari",
      title: "How the EU regulates AI — Stratechery",
      text: "a".repeat(400),
      expected: "consuming",
    },
    {
      label: "terminal open, working → focused",
      app: "Terminal",
      title: "joelc@mac: ~/Documents/Github/cortexOS",
      text: "npm test",
      expected: "focused",
    },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const frame = makeFrame({
        active_app: c.app,
        window_title: c.title,
        ocr_text: c.text,
      });
      const s = classifySentimentHeuristic(frame, c.text);
      assert.equal(s, c.expected);
    });
  }
});

describe("vision-brief — private-app deny-list", () => {
  test("isPrivateApp is true for seeded entries", () => {
    for (const app of PRIVATE_APPS) {
      assert.equal(isPrivateApp(app), true, `${app} must be private`);
    }
  });

  test("isPrivateApp is false for normal apps", () => {
    assert.equal(isPrivateApp("Safari"), false);
    assert.equal(isPrivateApp("Terminal"), false);
    assert.equal(isPrivateApp(null), false);
    assert.equal(isPrivateApp(undefined), false);
  });
});

describe("vision-brief — llm mode", () => {
  const makeOkFetch = (payload: unknown): typeof fetch =>
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

  test("uses Haiku summary + sentiment when the call succeeds", async () => {
    const fetchImpl = makeOkFetch({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            summary: "Drafting a compensation follow-up email to Mark",
            sentiment: "composing",
          }),
        },
      ],
    });
    const frame = makeFrame({
      active_app: "Mail",
      window_title: "Compensation Follow Up — Draft",
      ocr_text: "Hi Mark,",
    });
    const brief = await buildBrief(
      frame,
      {},
      { mode: "llm", apiKey: "test-key", fetchImpl, timeoutMs: 500 },
    );
    assert.equal(
      brief.summary,
      "Drafting a compensation follow-up email to Mark",
    );
    assert.equal(brief.sentiment, "composing");
  });

  test("falls back to local when the 500 returns", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("kaboom", { status: 500 });
    const frame = makeFrame({ active_app: "Safari" });
    const brief = await buildBrief(
      frame,
      {},
      { mode: "llm", apiKey: "test-key", fetchImpl, timeoutMs: 500 },
    );
    assert.match(brief.summary, /llm-fallback: server-error/);
  });

  test("falls back when the body isn't JSON", async () => {
    const fetchImpl = makeOkFetch({
      content: [{ type: "text", text: "just prose, no JSON here" }],
    });
    const frame = makeFrame();
    const brief = await buildBrief(
      frame,
      {},
      { mode: "llm", apiKey: "test-key", fetchImpl },
    );
    assert.match(brief.summary, /llm-fallback: parse-error/);
  });

  test("falls back when the schema is wrong", async () => {
    const fetchImpl = makeOkFetch({
      content: [
        {
          type: "text",
          text: JSON.stringify({ summary: "ok", sentiment: "not-a-real-mood" }),
        },
      ],
    });
    const frame = makeFrame();
    const brief = await buildBrief(
      frame,
      {},
      { mode: "llm", apiKey: "test-key", fetchImpl },
    );
    assert.match(brief.summary, /llm-fallback: schema-mismatch/);
  });

  test("times out cleanly and falls back", async () => {
    const fetchImpl: typeof fetch = (_u, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () =>
          reject(new Error("aborted by timeout")),
        );
      });
    const frame = makeFrame();
    const brief = await buildBrief(
      frame,
      {},
      { mode: "llm", apiKey: "test-key", fetchImpl, timeoutMs: 25 },
    );
    assert.match(brief.summary, /llm-fallback: timeout/);
  });

  test("missing API key in llm mode silently stays on local-only path", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const frame = makeFrame();
      const brief = await buildBrief(
        frame,
        {},
        { mode: "llm", fetchImpl },
      );
      assert.equal(called, false);
      assert.ok(brief.summary.length > 0);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
