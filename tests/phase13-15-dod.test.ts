/**
 * Phase 13–15 Integration DoD smoke test.
 *
 * Exercises the three phase deliverables end-to-end, verifying that they
 * co-exist cleanly on top of the Phase 8 / 8.5 / 11 perception+embodiment
 * base and do not break the kill path.
 *
 *   P13 — Writing Coach:
 *     DraftWatcher with a mocked ax-watch NativeBridge feeds a scripted draft;
 *     suggestOnce with a mocked Haiku fetch returns a suggestion; CoachSurface
 *     routes to the PendingSurface under mode=anticipatory; repeated identical
 *     drafts inside the 10-min dedup window are suppressed.
 *
 *   P14 — Conversation-intent:
 *     "I should order Thai for Maya" classifies as `stated-intent` with the
 *     expected ActionCandidate; under `autonomous` proactivity mode the
 *     intent-surface router inserts a "Confirm send" observation at urgency
 *     0.55 and NEVER auto-executes the drafter path beyond pre-drafting.
 *
 *   P15 — Rewind:
 *     A fresh in-memory screen_memories DB is seeded with 5 scripted rows at
 *     varying timestamps; parseTimePhrase("40 minutes ago") returns a valid
 *     window; rewindSearch surfaces the matching row, given a scripted
 *     embedder pointing at the target row's vector.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── P13 imports ──────────────────────────────────────────────────────────
import {
  DraftWatcher,
  type DraftSample,
  type NativeBridge,
  type NativeBridgeHandle,
} from "../src/coach/draft-watcher.js";
import {
  suggestOnce,
  type CoachSuggestion,
} from "../src/coach/suggestion-engine.js";
import { CoachSurface } from "../src/coach/coach-surface.js";
import { ProactivityModeManager } from "../src/proactivity/modes.js";
import type { SensorSample } from "../src/sensors/sensor.js";

// ── P14 imports ──────────────────────────────────────────────────────────
import {
  classifyConvRule,
  extractActionCandidate,
  type ConvIntent,
} from "../src/intent/conversation-intent.js";
import {
  surfaceIntent,
  INTENT_SENSOR_NAME,
  type ObservationWriter,
} from "../src/intent/intent-surface.js";

// ── P15 imports ──────────────────────────────────────────────────────────
import {
  ScreenMemoriesDB,
  type ScreenMemoryInput,
} from "../src/perception/screen-memories-db.js";
import {
  rewindSearch,
  type RewindEmbedder,
} from "../src/rewind/rewind-query.js";
import { parseTimePhrase } from "../src/rewind/time-parse.js";
import { extractIntent } from "../src/voice/intent-extractor.js";

// ─────────────────────────────────────────────────────────────────────────
// P13 — Writing Coach end-to-end
// ─────────────────────────────────────────────────────────────────────────

class ScriptedBridge implements NativeBridge {
  public handle: ScriptedHandle | null = null;
  spawn(_bundleId: string): NativeBridgeHandle {
    this.handle = new ScriptedHandle();
    return this.handle;
  }
}

class ScriptedHandle implements NativeBridgeHandle {
  private lineFn: ((line: string) => void) | null = null;
  private exitFn: ((code: number | null) => void) | null = null;
  kill(): void {
    /* no-op */
  }
  onLine(fn: (line: string) => void): void {
    this.lineFn = fn;
  }
  onExit(fn: (code: number | null) => void): void {
    this.exitFn = fn;
  }
  emit(sample: DraftSample): void {
    this.lineFn?.(JSON.stringify(sample));
  }
  /** Force exit for completeness; not exercised by the DoD happy path. */
  close(code: number | null = 0): void {
    this.exitFn?.(code);
  }
}

class MemStore {
  public items: SensorSample[] = [];
  private seq = 1;
  insert(s: SensorSample): number {
    this.items.push(s);
    return this.seq++;
  }
}

describe("Phase 13-15 DoD — P13 Writing Coach", () => {
  test("ax-watch mock → suggestOnce → CoachSurface (anticipatory) → surfaced + deduped", async () => {
    // 1. DraftWatcher with a scripted NativeBridge.
    const bridge = new ScriptedBridge();
    const received: DraftSample[] = [];
    const watcher = new DraftWatcher({
      appsAllowList: ["com.apple.mail"],
      bridge,
      throttleMs: 0,
    });
    watcher.onSample((s) => received.push(s));
    await watcher.start();
    assert.ok(watcher.isRunning(), "watcher should be running with allow-list");

    // 2. Emit a scripted NDJSON sample from the mocked ax-watch.
    const DRAFT = "Hi Mark, sorry to bother you with this again";
    bridge.handle!.emit({
      app: "com.apple.mail",
      role: "AXTextArea",
      label: "Body",
      value: DRAFT,
      ts: "2026-04-15T10:00:00.000Z",
    });
    assert.equal(received.length, 1, "DraftWatcher should deliver 1 sample");
    const sample = received[0]!;
    assert.equal(sample.value, DRAFT);

    watcher.stop();

    // 3. suggestOnce with a mocked Haiku fetch.
    const mockHaiku: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                suggestion: "Drop the apology — be direct.",
                severity: "note",
                reason: "apology-overuse",
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const suggestion = (await suggestOnce(sample, {
      haikuFetch: mockHaiku,
      apiKey: "sk-test",
    })) as CoachSuggestion;
    assert.ok(suggestion, "suggestOnce should return a suggestion");
    assert.equal(suggestion.severity, "note");
    assert.match(suggestion.suggestion, /apology/i);
    assert.equal(suggestion.draft_value, DRAFT);

    // 4. CoachSurface under mode=anticipatory routes to the pending-surface.
    const store = new MemStore();
    const modes = new ProactivityModeManager("anticipatory");
    const surface = new CoachSurface({
      modeManager: modes,
      store,
      // No TTS / voiceIdle → whisper path is disabled; surface path fires.
    });
    const outcome = await surface.route(sample, suggestion);
    assert.equal(outcome, "surfaced", "anticipatory mode should surface");
    assert.equal(store.items.length, 1);
    assert.equal(store.items[0]!.sensorName, "writing-coach");
    assert.equal(store.items[0]!.urgency, 0.4);

    // 5. Dedup — same draft value inside the 10-min window is suppressed.
    const outcome2 = await surface.route(sample, suggestion);
    assert.equal(outcome2, "deduped", "identical draft within window is deduped");
    assert.equal(store.items.length, 1, "no second insert should occur");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P14 — Conversation-intent end-to-end (rule path, no network)
// ─────────────────────────────────────────────────────────────────────────

class ObsCollector implements ObservationWriter {
  public inserts: Array<{
    sensorName: string;
    observation: string;
    urgency: number;
    data?: Record<string, unknown>;
    sampledAt: Date;
  }> = [];
  insert(s: {
    sensorName: string;
    observation: string;
    urgency: number;
    data?: Record<string, unknown>;
    sampledAt: Date;
  }): number {
    this.inserts.push(s);
    return this.inserts.length;
  }
}

describe("Phase 13-15 DoD — P14 Conversation-intent", () => {
  test("'I should order Thai for Maya' → stated-intent with action candidate", () => {
    const transcript = "I should order Thai for Maya";
    const intent: ConvIntent = classifyConvRule(transcript);
    assert.equal(intent.kind, "stated-intent");
    assert.ok(intent.action_candidate, "should extract an action candidate");
    const a = intent.action_candidate!;
    assert.equal(a.verb, "order");
    // Object string should at least include the word "Thai".
    assert.match(a.object, /thai/i);
    assert.deepEqual(a.recipients, ["Maya"]);
  });

  test("extractActionCandidate standalone also surfaces {verb, object, recipients}", () => {
    const a = extractActionCandidate("order Thai for Maya");
    assert.ok(a);
    assert.equal(a!.verb, "order");
    assert.match(a!.object, /thai/i);
    assert.deepEqual(a!.recipients, ["Maya"]);
  });

  test("autonomous mode surfaces 'Confirm send' at urgency 0.55 — never auto-executes", async () => {
    const store = new ObsCollector();
    let drafterCalls = 0;
    const intent: ConvIntent = classifyConvRule("I should order Thai for Maya");

    const outcome = await surfaceIntent(intent, {
      store,
      proactivityMode: () => "autonomous",
      drafter: async () => {
        drafterCalls += 1;
        // A drafter MAY pre-draft, but MUST NEVER send — test proves that we
        // surface the offer at the autonomous urgency tier and wait for the
        // user before any sending path is hit (there is no sending path here).
        return { id: "social:draft-1", tool: "social_send", note: "pre-drafted" };
      },
    });

    assert.equal(outcome.surfaced, true);
    assert.equal(outcome.urgency, 0.55);
    assert.equal(store.inserts.length, 1);
    const row = store.inserts[0]!;
    assert.equal(row.sensorName, INTENT_SENSOR_NAME);
    assert.equal(row.urgency, 0.55);
    assert.match(row.observation, /^Confirm send: /);
    assert.match(row.observation, /order.*thai/i);
    assert.match(row.observation, /Maya/);
    assert.equal(
      (row.data as Record<string, unknown>).confirm_action,
      "tap Y to confirm send",
    );
    assert.equal(drafterCalls, 1, "drafter pre-drafts exactly once");
    // The drafter returned a handle but no send was invoked — the router only
    // surfaces an offer. There is no "send" API on this path by design.
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P15 — Rewind: time-parse + rewindSearch
// ─────────────────────────────────────────────────────────────────────────

function int8Vec(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(-128, Math.min(127, Math.trunc(values[i]!)));
    buf[i] = v < 0 ? v + 256 : v;
  }
  return buf;
}

class ScriptedEmbedder implements RewindEmbedder {
  constructor(private readonly vec: Buffer) {}
  async embed(_text: string): Promise<Buffer> {
    return this.vec;
  }
}

describe("Phase 13-15 DoD — P15 Rewind", () => {
  test("parseTimePhrase('40 minutes ago') returns a valid {from, to} window", () => {
    const anchor = new Date("2026-04-15T14:00:00.000Z");
    const range = parseTimePhrase("40 minutes ago", anchor);
    assert.ok(range, "should parse a valid window");
    assert.ok(range!.from instanceof Date);
    assert.ok(range!.to instanceof Date);
    assert.ok(range!.from.getTime() < range!.to.getTime());
    // Center is 40 minutes before anchor, window covers it.
    const expected = anchor.getTime() - 40 * 60_000;
    assert.ok(
      range!.from.getTime() <= expected && expected <= range!.to.getTime(),
      "parsed window should contain the 40-min-ago instant",
    );
  });

  test("rewindSearch({text,timeRange}) surfaces the matching scripted frame", async () => {
    // Seed 5 frames at varying timestamps.
    const tmp = mkdtempSync(join(tmpdir(), "cortex-p15-dod-"));
    const dbPath = join(tmp, "registry.db");
    const db = new ScreenMemoriesDB({ dbPath });
    try {
      const now = new Date("2026-04-15T14:00:00.000Z");
      const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
      const common: Omit<ScreenMemoryInput, "id" | "captured_at" | "embedding" | "label" | "active_app"> = {
        webp_path: "/tmp/frame.webp",
        phash: 0n,
        window_title: "(untitled)",
        ocr_text_zstd: null,
        task_id: null,
        session_id: null,
        bytes: 512,
      };
      // The "pgvector article" frame is the one we expect to match; its
      // embedding vector aligns with the scripted query embedding.
      db.insert({
        ...common,
        id: "article-pgvector",
        captured_at: minutesAgo(40),
        label: "pgvector: the postgres ANN extension",
        active_app: "Safari",
        embedding: int8Vec([100, 0, 0, 0]),
      });
      db.insert({
        ...common,
        id: "inbox",
        captured_at: minutesAgo(5),
        label: "Inbox — Mail",
        active_app: "Mail",
        embedding: int8Vec([0, 100, 0, 0]),
      });
      db.insert({
        ...common,
        id: "terminal",
        captured_at: minutesAgo(15),
        label: "terminal — git status",
        active_app: "iTerm2",
        embedding: int8Vec([0, 0, 100, 0]),
      });
      db.insert({
        ...common,
        id: "slack",
        captured_at: minutesAgo(90),
        label: "Slack — #engineering",
        active_app: "Slack",
        embedding: int8Vec([0, 0, 0, 100]),
      });
      db.insert({
        ...common,
        id: "notes",
        captured_at: minutesAgo(38),
        label: "Notes — shopping list",
        active_app: "Notes",
        embedding: int8Vec([40, 40, 0, 0]),
      });

      const timeRange = parseTimePhrase("40 minutes ago", now);
      assert.ok(timeRange, "time parse should succeed");

      const embedder = new ScriptedEmbedder(int8Vec([100, 0, 0, 0]));
      const hits = await rewindSearch(
        { text: "article about pgvector", timeRange: timeRange!, limit: 5 },
        { db, embedder },
      );

      assert.ok(hits.length >= 1, "should return at least the pgvector frame");
      assert.equal(
        hits[0]!.id,
        "article-pgvector",
        "top hit must be the pgvector frame",
      );
      assert.match(hits[0]!.label, /pgvector/);
      // Frames outside the 40-min-ago window must not appear.
      for (const h of hits) {
        assert.notEqual(h.id, "inbox");
        assert.notEqual(h.id, "slack");
      }
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("voice extractIntent routes rewind phrasings", () => {
    const r = extractIntent("what was that article I was reading 40 minutes ago");
    assert.equal(r.kind, "rewind");
    assert.equal(r.confidence, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-phase: kill path still wins over every new intent kind
// ─────────────────────────────────────────────────────────────────────────

describe("Phase 13-15 DoD — cross-phase kill-path preservation", () => {
  test("'stop' still classifies as kill (no regression from P13/14/15 additions)", () => {
    assert.equal(extractIntent("stop").kind, "kill");
    assert.equal(extractIntent("Stop.").kind, "kill");
    assert.equal(extractIntent("please stop").kind, "kill");
  });

  test("extractIntent distinguishes kill vs rewind vs task", () => {
    assert.equal(extractIntent("stop").kind, "kill");
    assert.equal(
      extractIntent("show me the article I had open earlier").kind,
      "rewind",
    );
    assert.equal(
      extractIntent("I should order Thai for Maya").kind,
      "task",
      "stated-intent utterances fall through extractIntent to the task bucket — the conv-intent classifier runs in parallel via the orchestrator side-channel",
    );
  });
});
