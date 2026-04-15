/**
 * Research loop tests — mocked Haiku + scripted probe results.
 *
 * These are hermetic: no network, no real ANTHROPIC_API_KEY. A small
 * `scriptedFetch` helper walks through an array of canned responses so
 * each test can express the Haiku conversation as data.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runResearch } from "../src/research/research-loop.js";
import type { AgentEvent, EventBus } from "../src/ipc/event-bus.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import type { ProbeExecutor } from "../src/research/probe-executors.js";

// --------------------------- Fixtures -------------------------------------

interface ScriptedResp {
  body?: unknown;
  delayMs?: number;
  status?: number;
  reject?: Error;
}

function scriptedFetch(
  responses: ScriptedResp[],
  onCall?: (body: unknown, idx: number) => void,
): { fetchImpl: typeof fetch; calls: number } {
  let idx = 0;
  const state = { calls: 0 };
  const fetchImpl: typeof fetch = async (_url, init) => {
    const resp = responses[idx] ?? responses[responses.length - 1]!;
    const bodyIn = init?.body ? JSON.parse(init.body as string) : undefined;
    onCall?.(bodyIn, idx);
    idx++;
    state.calls++;
    if (resp.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, resp.delayMs);
        const sig = init?.signal;
        if (sig) {
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          };
          if (sig.aborted) abort();
          else sig.addEventListener("abort", abort, { once: true });
        }
      });
    }
    if (resp.reject) throw resp.reject;
    const status = resp.status ?? 200;
    return new Response(JSON.stringify(resp.body ?? {}), { status });
  };
  return {
    fetchImpl,
    get calls() {
      return state.calls;
    },
  };
}

function haikuContent(json: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
  };
}

// Canned three-hypothesis script used across several tests.
const THREE_HYPOTHESES = {
  hypotheses: [
    { h: "DNS misconfigured", prior: 0.3, probe: "dig example.com" },
    { h: "TLS cert expired", prior: 0.5, probe: "openssl s_client -showcerts" },
    { h: "firewall blocks 443", prior: 0.2, probe: "curl -v https://example.com" },
  ],
};

const FIVE_HYPOTHESES = {
  hypotheses: [
    { h: "A", prior: 0.2, probe: "pa" },
    { h: "B", prior: 0.2, probe: "pb" },
    { h: "C", prior: 0.2, probe: "pc" },
    { h: "D", prior: 0.2, probe: "pd" },
    { h: "E", prior: 0.2, probe: "pe" },
  ],
};

const SCORES_TLS_WINS = {
  scores: [
    { id: "h1", likelihood: 0.1, verdict: "falsified" as const },
    { id: "h2", likelihood: 0.9, verdict: "confirmed" as const },
    { id: "h3", likelihood: 0.4, verdict: "inconclusive" as const },
  ],
};

const BRIEF_DRAFT = {
  winning: "TLS cert expired",
  evidence: ["openssl output showed NotAfter = 2025-12-01"],
  open_questions: ["which CA issued the original cert?"],
  recommended_action: "rotate the TLS certificate and redeploy",
};

// --------------------------- Tests ----------------------------------------

describe("runResearch — happy path", () => {
  test("three hypotheses in parallel → winning brief with confidence", async () => {
    const bus = createEventBus();
    const phaseEvents: AgentEvent[] = [];
    const briefEvents: AgentEvent[] = [];
    bus.subscribe({ kind: "plan_emitted" }, (e) => phaseEvents.push(e));
    bus.subscribe({ kind: "research_brief_emitted" }, (e) =>
      briefEvents.push(e),
    );

    const { fetchImpl } = scriptedFetch([
      { body: haikuContent(THREE_HYPOTHESES) },
      { body: haikuContent(SCORES_TLS_WINS) },
      { body: haikuContent(BRIEF_DRAFT) },
    ]);

    const brief = await runResearch("Why is example.com unreachable?", {
      apiKey: "test-key",
      fetchImpl,
      bus,
    });

    // Three hypotheses, each probe ran (echo fallback → `echo: <probe>`)
    assert.equal(brief.hypotheses.length, 3);
    for (const h of brief.hypotheses) {
      assert.ok(h.result, "probe result recorded");
    }

    // Winner: TLS cert expired (highest likelihood × prior)
    assert.equal(brief.winning, "TLS cert expired");
    assert.ok(brief.confidence > 0.5, `confidence > 0.5, got ${brief.confidence}`);
    assert.equal(
      brief.recommended_action,
      "rotate the TLS certificate and redeploy",
    );
    assert.deepEqual(brief.evidence, [
      "openssl output showed NotAfter = 2025-12-01",
    ]);

    // Phase events: 4 plan_emitted (H, E, U, B), 1 research_brief_emitted
    const phases = phaseEvents.map((e) => (e.payload as { phase: string }).phase);
    assert.deepEqual(phases, [
      "HYPOTHESIZE",
      "EXECUTE_PROBES",
      "UPDATE_BELIEFS",
      "BRIEF",
    ]);
    assert.equal(briefEvents.length, 1);
    const payload = briefEvents[0]!.payload as {
      winning?: string;
      confidence: number;
    };
    assert.equal(payload.winning, "TLS cert expired");
  });

  test("custom probe executor is used when canRun matches", async () => {
    let ranProbe: string | null = null;
    const spyExec: ProbeExecutor = {
      name: "spy",
      canRun: (p) => p.startsWith("dig"),
      async run(p) {
        ranProbe = p;
        return "dig said: NXDOMAIN";
      },
    };

    const { fetchImpl } = scriptedFetch([
      { body: haikuContent(THREE_HYPOTHESES) },
      { body: haikuContent(SCORES_TLS_WINS) },
      { body: haikuContent(BRIEF_DRAFT) },
    ]);

    const brief = await runResearch("why?", {
      apiKey: "test-key",
      fetchImpl,
      probeExecutors: [spyExec],
    });

    assert.equal(ranProbe, "dig example.com");
    const dns = brief.hypotheses.find((h) => h.h === "DNS misconfigured");
    assert.equal(dns?.result, "dig said: NXDOMAIN");
  });
});

describe("runResearch — depth caps", () => {
  test("depth=normal caps to 3 hypotheses even if Haiku returns 5", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: haikuContent(FIVE_HYPOTHESES) },
      {
        body: haikuContent({
          scores: [
            { id: "h1", likelihood: 0.5, verdict: "inconclusive" },
            { id: "h2", likelihood: 0.5, verdict: "inconclusive" },
            { id: "h3", likelihood: 0.5, verdict: "inconclusive" },
          ],
        }),
      },
      {
        body: haikuContent({
          evidence: [],
          open_questions: [],
          recommended_action: "inconclusive",
        }),
      },
    ]);

    const brief = await runResearch("q", {
      apiKey: "test-key",
      fetchImpl,
      depth: "normal",
    });

    assert.equal(brief.hypotheses.length, 3);
  });

  test("depth=deep allows up to 5 hypotheses", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: haikuContent(FIVE_HYPOTHESES) },
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
          recommended_action: "inconclusive",
        }),
      },
    ]);

    const brief = await runResearch("q", {
      apiKey: "test-key",
      fetchImpl,
      depth: "deep",
    });

    assert.equal(brief.hypotheses.length, 5);
  });
});

describe("runResearch — budget enforcement", () => {
  test("slow Haiku call aborts when timeBudgetMs expires", async () => {
    const { fetchImpl } = scriptedFetch([
      // First call takes forever — outer controller must kill it
      { delayMs: 5_000, body: haikuContent(THREE_HYPOTHESES) },
    ]);

    const t0 = Date.now();
    const brief = await runResearch("q", {
      apiKey: "test-key",
      fetchImpl,
      timeBudgetMs: 50,
    });
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 1_000, `should abort fast, took ${elapsed}ms`);
    assert.equal(brief.recommended_action, "research-failed");
    assert.equal(brief.confidence, 0);
    assert.ok(brief.open_questions.includes("q"));
  });
});

describe("runResearch — malformed Haiku output", () => {
  test("zod mismatch surfaces as research-failed brief, no throw", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        body: haikuContent({
          hypotheses: [{ h: "bad", prior: "not-a-number", probe: "p" }],
        }),
      },
    ]);

    const brief = await runResearch("q", {
      apiKey: "test-key",
      fetchImpl,
    });

    assert.equal(brief.recommended_action, "research-failed");
    assert.equal(brief.confidence, 0);
    assert.equal(brief.hypotheses.length, 1);
    assert.equal(brief.hypotheses[0]!.h, "loop failed before producing a brief");
  });

  test("non-JSON response also yields fail-safe brief", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { content: [{ type: "text", text: "sorry, no JSON" }] } },
    ]);

    const brief = await runResearch("q", {
      apiKey: "test-key",
      fetchImpl,
    });

    assert.equal(brief.recommended_action, "research-failed");
  });
});

describe("runResearch — redaction", () => {
  test("research_brief_emitted reason is a safe label, not raw fetch error", async () => {
    const bus = createEventBus();
    const briefEvents: AgentEvent[] = [];
    bus.subscribe({ kind: "research_brief_emitted" }, (e) =>
      briefEvents.push(e),
    );

    // Haiku returns 500 with secret leak in the error body. We only ever
    // surface a redacted label ("server-error") upstream.
    const { fetchImpl } = scriptedFetch([
      {
        reject: new Error(
          "fetch failed: api-key=sk-ant-super-secret hostname=internal.example",
        ),
      },
    ]);

    const brief = await runResearch("q", {
      apiKey: "test-key",
      fetchImpl,
      bus,
    });

    assert.equal(brief.recommended_action, "research-failed");
    assert.equal(briefEvents.length, 1);
    const payload = briefEvents[0]!.payload as { reason: string };
    assert.ok(
      !String(payload.reason).includes("sk-ant"),
      "reason must not contain api-key",
    );
    assert.ok(
      !String(payload.reason).includes("internal.example"),
      "reason must not contain hostname",
    );
    // It should be one of the known labels (network, fetch → network).
    assert.match(payload.reason, /^(network|unknown|parse-error)$/);
  });
});

describe("runResearch — bus may be omitted", () => {
  test("runs end-to-end without a bus", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: haikuContent(THREE_HYPOTHESES) },
      { body: haikuContent(SCORES_TLS_WINS) },
      { body: haikuContent(BRIEF_DRAFT) },
    ]);

    const brief = await runResearch("q", {
      apiKey: "test-key",
      fetchImpl,
    });
    assert.equal(brief.winning, "TLS cert expired");
  });
});

// Surface the exported function so `nchinda_research` can wrap it.
function _typeGate(): EventBus {
  return createEventBus();
}
void _typeGate;
