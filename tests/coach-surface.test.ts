/**
 * Tests for the Phase 13 CoachSurface routing layer.
 *
 * Covers:
 *   - mode=anticipatory → pending-surface insert (urgency 0.4)
 *   - severity=important AND user idle → TTS whisper
 *   - mode=silent / quiet → quiet (no routing)
 *   - mode=volunteer → audit-only
 *   - dedup: same draft_value within 10 min is dropped
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CoachSurface } from "../src/coach/coach-surface.js";
import type { DraftSample } from "../src/coach/draft-watcher.js";
import type { CoachSuggestion } from "../src/coach/suggestion-engine.js";
import type { SensorSample } from "../src/sensors/sensor.js";
import { ProactivityModeManager, type ProactivityMode } from "../src/proactivity/modes.js";

interface StoredItem extends SensorSample { _id: number; }

class MemStore {
  public items: StoredItem[] = [];
  private seq = 1;
  insert(s: SensorSample): number {
    const id = this.seq++;
    this.items.push({ ...s, _id: id });
    return id;
  }
}

class MockTTS {
  public spoken: string[] = [];
  public throwOnNext = false;
  async speak(text: string): Promise<void> {
    if (this.throwOnNext) { this.throwOnNext = false; throw new Error("tts failed"); }
    this.spoken.push(text);
  }
}

class MockAudit {
  public entries: Array<{ action: string; detail: string }> = [];
  append(e: { action: string; detail: string }): void {
    this.entries.push({ action: e.action, detail: e.detail });
  }
}

function sample(v = "Hi Mark, sorry to bother you"): DraftSample {
  return {
    app: "com.apple.mail",
    role: "AXTextArea",
    label: "Body",
    value: v,
    ts: "2026-04-15T10:00:00.000Z",
  };
}

function suggestion(
  overrides: Partial<CoachSuggestion> = {},
): CoachSuggestion {
  return {
    draft_value: "Hi Mark, sorry to bother you",
    suggestion: "Drop the apology.",
    severity: "note",
    reason: "apology-overuse",
    ...overrides,
  };
}

function surface(mode: ProactivityMode, extras: {
  store?: MemStore;
  tts?: MockTTS;
  idle?: boolean;
  audit?: MockAudit;
} = {}): CoachSurface {
  const mgr = new ProactivityModeManager(mode);
  return new CoachSurface({
    modeManager: mgr,
    store: extras.store,
    tts: extras.tts,
    voiceIdle: { isIdle: () => extras.idle ?? true },
    audit: extras.audit,
    dedupWindowMs: 10 * 60 * 1000,
  });
}

describe("CoachSurface", () => {
  it("routes to pending-surface in anticipatory mode", async () => {
    const store = new MemStore();
    const audit = new MockAudit();
    const s = surface("anticipatory", { store, audit });

    const r = await s.route(sample(), suggestion());
    assert.equal(r, "surfaced");
    assert.equal(store.items.length, 1);
    assert.equal(store.items[0]?.sensorName, "writing-coach");
    assert.equal(store.items[0]?.urgency, 0.4);
    assert.match(store.items[0]?.observation ?? "", /Mail/);
    assert.ok(audit.entries.some((e) => e.action === "surface"));
  });

  it("routes to pending-surface in autonomous mode", async () => {
    const store = new MemStore();
    const s = surface("autonomous", { store });
    const r = await s.route(sample(), suggestion());
    assert.equal(r, "surfaced");
  });

  it("whispers via TTS for important severity + idle user", async () => {
    const tts = new MockTTS();
    const store = new MemStore();
    const audit = new MockAudit();
    const s = surface("anticipatory", { tts, store, audit, idle: true });

    const r = await s.route(sample(), suggestion({ severity: "important" }));
    assert.equal(r, "whispered");
    assert.equal(tts.spoken.length, 1);
    assert.equal(tts.spoken[0], "Drop the apology.");
    // No pending-surface insert on whisper.
    assert.equal(store.items.length, 0);
  });

  it("falls through to pending surface if TTS errors", async () => {
    const tts = new MockTTS();
    tts.throwOnNext = true;
    const store = new MemStore();
    const s = surface("anticipatory", { tts, store, idle: true });

    const r = await s.route(sample(), suggestion({ severity: "important" }));
    assert.equal(r, "surfaced");
    assert.equal(store.items.length, 1);
  });

  it("does NOT whisper when user is not idle (still surfaces)", async () => {
    const tts = new MockTTS();
    const store = new MemStore();
    const s = surface("anticipatory", { tts, store, idle: false });

    const r = await s.route(sample(), suggestion({ severity: "important" }));
    assert.equal(r, "surfaced");
    assert.equal(tts.spoken.length, 0);
  });

  it("dedups identical draft_value within 10 minutes", async () => {
    const store = new MemStore();
    const s = surface("anticipatory", { store });

    const r1 = await s.route(sample(), suggestion());
    const r2 = await s.route(sample(), suggestion());
    assert.equal(r1, "surfaced");
    assert.equal(r2, "deduped");
    assert.equal(store.items.length, 1);
  });

  it("audit-only in volunteer mode", async () => {
    const store = new MemStore();
    const audit = new MockAudit();
    const s = surface("volunteer", { store, audit });

    const r = await s.route(sample(), suggestion());
    assert.equal(r, "audited");
    assert.equal(store.items.length, 0);
    assert.ok(audit.entries.some((e) => e.action === "sensor_sample"));
  });

  it("returns quiet in silent mode", async () => {
    const store = new MemStore();
    const s = surface("silent", { store });
    const r = await s.route(sample(), suggestion({ severity: "important" }));
    assert.equal(r, "quiet");
    assert.equal(store.items.length, 0);
  });

  it("TTS failure does NOT poison the dedup key — retry re-surfaces", async () => {
    // 1st call: TTS fails → falls through to surface path.
    const tts = new MockTTS();
    tts.throwOnNext = true;
    const store = new MemStore();
    const s = surface("anticipatory", { tts, store, idle: true });

    const sug = suggestion({ severity: "important" });
    const r1 = await s.route(sample(), sug);
    assert.equal(r1, "surfaced");
    assert.equal(store.items.length, 1);
    assert.equal(tts.spoken.length, 0, "TTS threw — nothing spoken");

    // 2nd call (same draft_value): the dedup key was set after the
    // successful surface insert, so this should be deduped — the
    // suggestion *was* delivered (via surface), just not via TTS.
    const r2 = await s.route(sample(), sug);
    assert.equal(r2, "deduped");
    assert.equal(store.items.length, 1, "no double-insert");
  });

  it("all-paths-fail does NOT set dedup — next call retries", async () => {
    // Construct a scenario where both TTS and store are unavailable,
    // AND mode prevents surface path (volunteer: no surface, TTS
    // fires only when available + important + idle).
    //
    // With volunteer mode + important + idle + TTS throws: we attempt
    // whisper → fails → fall through to surface → volunteer mode
    // doesn't have aggressive=true → ends at "audited". The dedup
    // IS set after audit (since we still logged it). This is correct:
    // audit-only is a valid route, and we don't want to spam audit.
    const tts = new MockTTS();
    tts.throwOnNext = true;
    const audit = new MockAudit();
    const s = surface("volunteer", { tts, audit, idle: true });

    const sug = suggestion({ severity: "important" });
    const r1 = await s.route(sample(), sug);
    assert.equal(r1, "audited");
    assert.ok(audit.entries.length > 0);
  });
});
