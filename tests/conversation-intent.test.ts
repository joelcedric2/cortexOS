import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyConv,
  classifyConvRule,
  extractActionCandidate,
  type ConvIntent,
  type ConvIntentKind,
} from "../src/intent/conversation-intent.js";

// ─── Rule-based table ───────────────────────────────────────────────────────

interface Row {
  input: string;
  kind: ConvIntentKind;
}

const TABLE: Row[] = [
  // stated-intent
  { input: "I should order Thai for Maya", kind: "stated-intent" },
  { input: "i need to email my mom tonight", kind: "stated-intent" },
  { input: "I have to schedule that dentist thing", kind: "stated-intent" },
  { input: "I want to post this on Twitter", kind: "stated-intent" },
  { input: "I'm going to book the flight tomorrow", kind: "stated-intent" },
  { input: "I'll send Maya a text later", kind: "stated-intent" },
  { input: "Maybe I should reply to that email", kind: "stated-intent" },
  { input: "i gotta finish that draft", kind: "stated-intent" },

  // direct-command
  { input: "Nchinda, order Thai for Maya", kind: "direct-command" },
  { input: "nchinda email my mom tonight", kind: "direct-command" },
  { input: "Nchinda: schedule a dentist visit", kind: "direct-command" },

  // question
  { input: "what's the weather today?", kind: "question" },
  { input: "how do I fix this bug", kind: "question" }, // wh-start, no ?
  { input: "is the oven off?", kind: "question" },
  { input: "can you help with this?", kind: "question" },

  // reminder
  { input: "remind me to take out the trash", kind: "reminder" },
  { input: "Remind me to call the landlord tomorrow", kind: "reminder" },

  // idle-chat
  { input: "this is boring", kind: "idle-chat" },
  { input: "ugh, Monday again", kind: "idle-chat" },
  { input: "lol", kind: "idle-chat" },
  { input: "okay cool", kind: "idle-chat" },

  // edge — empty / whitespace
  { input: "", kind: "idle-chat" },
  { input: "   \t\n  ", kind: "idle-chat" },
];

describe("classifyConvRule — classification table", () => {
  for (const row of TABLE) {
    it(`maps ${JSON.stringify(row.input)} → ${row.kind}`, () => {
      const r = classifyConvRule(row.input);
      assert.equal(r.kind, row.kind, `kind mismatch for ${row.input}`);
      assert.equal(r.source, "rule");
      assert.ok(r.confidence >= 0 && r.confidence <= 1);
      assert.ok(typeof r.ts === "string" && r.ts.length > 0);
    });
  }
});

describe("classifyConvRule — action candidate extraction", () => {
  it("extracts verb + object for 'I should order Thai for Maya'", () => {
    const r = classifyConvRule("I should order Thai for Maya");
    assert.equal(r.kind, "stated-intent");
    assert.ok(r.action_candidate);
    assert.equal(r.action_candidate?.verb, "order");
    assert.ok(r.action_candidate?.object.toLowerCase().includes("thai"));
    assert.deepEqual(r.action_candidate?.recipients, ["Maya"]);
    assert.equal(r.action_candidate?.suggested_tool, "social_send");
  });

  it("extracts recipients 'X and Y'", () => {
    const r = classifyConvRule("I should email Alice and Bob about the launch");
    assert.equal(r.kind, "stated-intent");
    assert.deepEqual(r.action_candidate?.recipients, ["Alice", "Bob"]);
    assert.equal(r.action_candidate?.suggested_tool, "mail_compose");
  });

  it("extracts time hint 'tomorrow'", () => {
    const r = classifyConvRule("I need to book the flight tomorrow");
    assert.equal(r.action_candidate?.time_hint, "tomorrow");
    assert.equal(r.action_candidate?.suggested_tool, "calendar_create");
  });

  it("extracts time hint 'in 10 min'", () => {
    const r = classifyConvRule("I should call Maya in 10 min");
    assert.equal(r.action_candidate?.verb, "call");
    assert.ok(r.action_candidate?.time_hint?.includes("10"));
  });

  it("direct-command also extracts action candidate", () => {
    const r = classifyConvRule("Nchinda, email Maya the PDF");
    assert.equal(r.kind, "direct-command");
    assert.equal(r.action_candidate?.verb, "email");
    assert.deepEqual(r.action_candidate?.recipients, ["Maya"]);
  });

  it("extractActionCandidate returns undefined for empty input", () => {
    assert.equal(extractActionCandidate(""), undefined);
    assert.equal(extractActionCandidate("   "), undefined);
  });

  it("suggested_tool is absent when verb is unknown", () => {
    const r = classifyConvRule("I should ponder the meaning of life");
    assert.equal(r.action_candidate?.verb, "ponder");
    assert.equal(r.action_candidate?.suggested_tool, undefined);
  });
});

// ─── Haiku path — mocked ─────────────────────────────────────────────────────

describe("classifyConv — Haiku path", () => {
  it("uses Haiku when apiKey + fetch are provided", async () => {
    const haikuFetch = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                kind: "stated-intent",
                confidence: 0.93,
                action_candidate: {
                  verb: "order",
                  object: "pad see ew",
                  recipients: ["Maya"],
                  suggested_tool: "social_send",
                },
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const r = await classifyConv("I should order pad see ew for Maya", {
      apiKey: "sk-test",
      haikuFetch: haikuFetch as unknown as typeof fetch,
    });
    assert.equal(r.source, "haiku");
    assert.equal(r.kind, "stated-intent");
    assert.equal(r.confidence, 0.93);
    assert.equal(r.action_candidate?.verb, "order");
    assert.equal(r.action_candidate?.suggested_tool, "social_send");
  });

  it("falls back to heuristic when Haiku returns non-OK", async () => {
    const haikuFetch = async () => new Response("overloaded", { status: 503 });
    const r = await classifyConv("I should order Thai for Maya", {
      apiKey: "sk-test",
      haikuFetch: haikuFetch as unknown as typeof fetch,
    });
    assert.equal(r.source, "haiku-fallback");
    assert.equal(r.kind, "stated-intent"); // rule agrees
    assert.equal(r.fallback_reason, "server-error");
  });

  it("falls back on invalid JSON", async () => {
    const haikuFetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "totally not json" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const r = await classifyConv("is it raining?", {
      apiKey: "sk-test",
      haikuFetch: haikuFetch as unknown as typeof fetch,
    });
    assert.equal(r.source, "haiku-fallback");
    assert.equal(r.kind, "question");
  });

  it("falls back on schema mismatch", async () => {
    const haikuFetch = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({ kind: "weird-new-kind", confidence: 2 }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const r = await classifyConv("lol", {
      apiKey: "sk-test",
      haikuFetch: haikuFetch as unknown as typeof fetch,
    });
    assert.equal(r.source, "haiku-fallback");
    assert.equal(r.kind, "idle-chat");
  });

  it("respects timeout + reports 'timeout' reason", async () => {
    const haikuFetch = (_: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted by timeout"));
        });
      });
    const r = await classifyConv("I should order Thai", {
      apiKey: "sk-test",
      haikuFetch: haikuFetch as unknown as typeof fetch,
      timeoutMs: 25,
    });
    assert.equal(r.source, "haiku-fallback");
    assert.equal(r.fallback_reason, "timeout");
  });

  it("skips Haiku and uses rule when forceHeuristic=true", async () => {
    let called = 0;
    const haikuFetch = async () => {
      called++;
      return new Response("{}", { status: 200 });
    };
    const r = await classifyConv("I should eat", {
      apiKey: "sk-test",
      haikuFetch: haikuFetch as unknown as typeof fetch,
      forceHeuristic: true,
    });
    assert.equal(called, 0);
    assert.equal(r.source, "rule");
  });

  it("skips Haiku when no apiKey is present", async () => {
    let called = 0;
    const haikuFetch = async () => {
      called++;
      return new Response("{}", { status: 200 });
    };
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await classifyConv("I should eat", {
        haikuFetch: haikuFetch as unknown as typeof fetch,
      });
      assert.equal(called, 0);
      assert.equal(r.source, "rule");
    } finally {
      if (prev) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("redacts network errors to 'network'", async () => {
    const haikuFetch = async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    };
    const r = await classifyConv("I should sleep", {
      apiKey: "sk-test",
      haikuFetch: haikuFetch as unknown as typeof fetch,
    });
    assert.equal(r.source, "haiku-fallback");
    assert.equal(r.fallback_reason, "network");
  });

  it("empty transcript short-circuits without fetching", async () => {
    let called = 0;
    const haikuFetch = async () => {
      called++;
      return new Response("{}", { status: 200 });
    };
    const r: ConvIntent = await classifyConv("   ", {
      apiKey: "sk-test",
      haikuFetch: haikuFetch as unknown as typeof fetch,
    });
    assert.equal(called, 0);
    assert.equal(r.kind, "idle-chat");
  });
});
