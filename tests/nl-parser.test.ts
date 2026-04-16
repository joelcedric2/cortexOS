/**
 * Phase 1.5 — Agent B
 * Tests for NL → cron parser (heuristic + LLM + redaction).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseNl } from "../src/scheduler/nl-parser.js";

const TZ = "America/New_York";

// Make sure the ambient API key (if present) doesn't push us onto the LLM
// path in heuristic tests. Pass empty apiKey explicitly to force heuristic.
const H = { apiKey: "" };

describe("parseNl — heuristic path (no API key)", () => {
  test("every Friday at 5pm → 0 17 * * 5", async () => {
    const r = await parseNl("every Friday at 5pm", H);
    assert.equal(r.cron_expr, "0 17 * * 5");
    assert.equal(r.timezone, TZ);
    assert.ok(r.confidence >= 0.8);
  });

  test("every Monday at 9am → 0 9 * * 1", async () => {
    const r = await parseNl("every Monday at 9am", H);
    assert.equal(r.cron_expr, "0 9 * * 1");
  });

  test("every Sunday at 10:30am → 30 10 * * 0", async () => {
    const r = await parseNl("every Sunday at 10:30am", H);
    assert.equal(r.cron_expr, "30 10 * * 0");
  });

  test("every weekday at 9 → 0 9 * * 1-5", async () => {
    const r = await parseNl("every weekday at 9", H);
    assert.equal(r.cron_expr, "0 9 * * 1-5");
  });

  test("weekday mornings at 9 → 0 9 * * 1-5", async () => {
    const r = await parseNl("weekday mornings at 9", H);
    assert.equal(r.cron_expr, "0 9 * * 1-5");
  });

  test("every weekend at 10am → 0 10 * * 0,6", async () => {
    const r = await parseNl("every weekend at 10am", H);
    assert.equal(r.cron_expr, "0 10 * * 0,6");
  });

  test("every 15 minutes → */15 * * * *", async () => {
    const r = await parseNl("every 15 minutes", H);
    assert.equal(r.cron_expr, "*/15 * * * *");
  });

  test("every 2 hours → 0 */2 * * *", async () => {
    const r = await parseNl("every 2 hours", H);
    assert.equal(r.cron_expr, "0 */2 * * *");
  });

  test("daily at 8am → 0 8 * * *", async () => {
    const r = await parseNl("daily at 8am", H);
    assert.equal(r.cron_expr, "0 8 * * *");
  });

  test("every day at 18:00 → 0 18 * * *", async () => {
    const r = await parseNl("every day at 18:00", H);
    assert.equal(r.cron_expr, "0 18 * * *");
  });

  test("at midnight → 0 0 * * *", async () => {
    const r = await parseNl("at midnight", H);
    assert.equal(r.cron_expr, "0 0 * * *");
  });

  test("at noon → 0 12 * * *", async () => {
    const r = await parseNl("at noon", H);
    assert.equal(r.cron_expr, "0 12 * * *");
  });

  test("hourly → 0 * * * *", async () => {
    const r = await parseNl("hourly", H);
    assert.equal(r.cron_expr, "0 * * * *");
  });

  test("nightly → 0 2 * * *", async () => {
    const r = await parseNl("nightly", H);
    assert.equal(r.cron_expr, "0 2 * * *");
  });

  test("every morning → 0 8 * * *", async () => {
    const r = await parseNl("every morning", H);
    assert.equal(r.cron_expr, "0 8 * * *");
  });

  test("every evening → 0 18 * * *", async () => {
    const r = await parseNl("every evening", H);
    assert.equal(r.cron_expr, "0 18 * * *");
  });

  test("unknown phrasing → conservative hourly with low confidence", async () => {
    const r = await parseNl("bleep blorp the gronks", H);
    assert.equal(r.cron_expr, "0 * * * *");
    assert.equal(r.confidence, 0.2);
    assert.match(r.rationale, /unrecognized-pattern/);
  });

  test("extractedTask pulls trailing description", async () => {
    const r = await parseNl("every Friday at 5pm: summarize the week", H);
    assert.equal(r.cron_expr, "0 17 * * 5");
    assert.equal(r.extractedTask, "summarize the week");
  });

  test("timezone override respected", async () => {
    const r = await parseNl("hourly", { ...H, timezone: "UTC" });
    assert.equal(r.timezone, "UTC");
  });
});

describe("parseNl — LLM path (mocked fetch)", () => {
  test("valid LLM response is passed through", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                cron_expr: "0 17 * * 5",
                timezone: "America/New_York",
                confidence: 0.95,
                rationale: "friday at 5pm",
                extractedTask: "send weekly report",
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const r = await parseNl("every friday at 5pm send weekly report", {
      apiKey: "sk-test",
      fetchImpl: fakeFetch,
    });
    assert.equal(r.cron_expr, "0 17 * * 5");
    assert.equal(r.confidence, 0.95);
    assert.equal(r.extractedTask, "send weekly report");
    assert.equal(r.rationale, "friday at 5pm");
  });

  test("LLM 500 error falls back to heuristic with redacted rationale", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("upstream exploded with secret=abc123", {
        status: 500,
        statusText: "Internal Server Error",
      });

    const r = await parseNl("every Friday at 5pm", {
      apiKey: "sk-test",
      fetchImpl: fakeFetch,
    });
    // Fell back to heuristic
    assert.equal(r.cron_expr, "0 17 * * 5");
    // Rationale is prefixed with redacted reason, no raw body bleed
    assert.match(r.rationale, /^\[llm-fallback: (server-error|client-error)\]/);
    assert.doesNotMatch(r.rationale, /secret/);
    assert.doesNotMatch(r.rationale, /abc123/);
    assert.doesNotMatch(r.rationale, /exploded/);
  });

  test("LLM malformed JSON falls back with parse-error tag", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "not json at all" }],
        }),
        { status: 200 },
      );

    const r = await parseNl("hourly", {
      apiKey: "sk-test",
      fetchImpl: fakeFetch,
    });
    assert.equal(r.cron_expr, "0 * * * *");
    assert.match(r.rationale, /llm-fallback/);
    // No raw error string leakage
    assert.doesNotMatch(r.rationale, /not json at all/);
  });

  test("LLM timeout falls back cleanly", async () => {
    const fakeFetch: typeof fetch = async () => {
      // Throw an abort-like error
      throw new Error("operation was aborted by timeout");
    };

    const r = await parseNl("hourly", {
      apiKey: "sk-test",
      fetchImpl: fakeFetch,
      timeoutMs: 50,
    });
    assert.equal(r.cron_expr, "0 * * * *");
    assert.match(r.rationale, /\[llm-fallback: timeout\]/);
  });
});
