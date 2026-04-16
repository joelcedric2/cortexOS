/**
 * Phase 8 + 8.5 — full-lifecycle DoD smoke test.
 *
 * End-to-end proof that A1 (retention-core) + A2 (encode-hash-adaptive) +
 * A3 (kill-audit) compose into ONE coherent perception pipeline on top of
 * the phase8-11 base. Every dependency is mocked — no real Swift helper,
 * no real PNG libraries, no real Apple Vision OCR — so the test is fully
 * hermetic and runnable in CI.
 *
 * Scenarios (each a discrete `test()`):
 *   1. capture path      — one fresh frame goes end-to-end: private-app
 *                          allowlist honoured, phash computed, db row
 *                          written with label/embedding placeholders, audit
 *                          line appended.
 *   2. dedup path        — two identical frames back-to-back; the second
 *                          is skipped (Hamming = 0).
 *   3. budget path       — db.bytesInWindow() over 400 MB → next capture
 *                          returns {ok:false, reason:'budget-exceeded'},
 *                          emits a bus error event, surfaces a Pending
 *                          Surface observation.
 *   4. retention path    — insert an 8-day-old row, run runRetention →
 *                          webp_path nulled, bytes_reclaimed matches,
 *                          second run is a no-op.
 *   5. kill-switch path  — PerceptionKillSwitch.trigger("hotkey") →
 *                          capturer.forceOff() called, ornaments cleared,
 *                          audit 'perception_killed source=hotkey'.
 *   6. voice-kill path   — extractIntent("stop") → kind === 'kill'; route
 *                          through VoiceOrchestrator → kill-switch fires,
 *                          TTS stopped.
 *
 * This is Phase 8's "prove it composes" test. Unit coverage for each
 * branch lives in their own test files; this file is a union smoke.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPTURE_DEFAULTS,
  ScreenCapturer,
  type CaptureScheduler,
  type PendingSurface,
} from "../src/perception/screen-capture.js";
import {
  ScreenMemoriesDB,
  type ScreenMemoryInput,
} from "../src/perception/screen-memories-db.js";
import { runRetention } from "../src/perception/retention.js";
import type {
  NativeCaptureResult,
  NativeOcrResult,
  VisionBridge,
} from "../src/perception/native-bridge.js";
import type { PhashDecoder } from "../src/perception/phash.js";
import { PerceptionKillSwitch } from "../src/perception/kill-switch.js";
import { AuditLog } from "../src/proactivity/audit.js";
import {
  createEventBus,
  type AgentEvent,
  type EventBus,
} from "../src/ipc/event-bus.js";
import { extractIntent } from "../src/voice/intent-extractor.js";
import { VoiceOrchestrator } from "../src/voice/voice-orchestrator.js";
import { AudioStateMachine } from "../src/voice/audio-state.js";
import { WakeWordDetector } from "../src/voice/wake-word.js";
import { SpeechToText } from "../src/voice/stt.js";
import { TextToSpeech } from "../src/voice/tts.js";
import type { PaneOrnamentManager } from "../src/window-manager/pane-ornaments.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Shared fixtures — minimal fakes reused across scenarios
// ═══════════════════════════════════════════════════════════════════════════

/** Manual scheduler; start/stop no-ops so captureNow drives the loop. */
function manualScheduler(): CaptureScheduler {
  return { start() {}, stop() {} };
}

function frameStub(
  overrides: Partial<NativeCaptureResult> = {},
): NativeCaptureResult {
  return {
    width: 1920,
    height: 1080,
    active_app: overrides.active_app ?? "Ghostty",
    active_bundle: overrides.active_bundle ?? "com.mitchellh.ghostty",
    window_title: overrides.window_title ?? "~/cortexOS",
    png_path: overrides.png_path ?? "",
    ts: overrides.ts ?? Date.now(),
  };
}

/** Bridge that scripts a sequence of captures; writes a stub PNG on disk. */
function scriptedBridge(captures: NativeCaptureResult[]): VisionBridge & {
  pngPathsWritten: string[];
} {
  const pngPathsWritten: string[] = [];
  let cursor = 0;
  return {
    pngPathsWritten,
    async isAvailable() {
      return true;
    },
    async capture(opts) {
      const next = captures[cursor % captures.length]!;
      cursor += 1;
      if (opts?.outPath) {
        await writeFile(opts.outPath, `PNG-STUB-${cursor}`);
        pngPathsWritten.push(opts.outPath);
      }
      return { ...next, ts: next.ts || Date.now() };
    },
    async ocr(): Promise<NativeOcrResult> {
      return { blocks: [], text: "", duration_ms: 0 };
    },
  };
}

/** Decoder that returns a fixed 8×8 gray map so phash is deterministic. */
function fixedDecoder(seed = 1): PhashDecoder {
  return {
    async decodeGray8x8() {
      const b = new Uint8Array(64);
      for (let i = 0; i < 64; i++) b[i] = (i * 17 + seed * 53) % 256;
      return b;
    },
  };
}

/** Decoder yielding distinct maps on each call so phash dedup does NOT kick in. */
function perCallUniqueDecoder(): PhashDecoder {
  let n = 0;
  return {
    async decodeGray8x8() {
      n += 1;
      const b = new Uint8Array(64);
      for (let i = 0; i < 64; i++) b[i] = (i * 31 + n * 97) % 256;
      return b;
    },
  };
}

function collectingSurface(): PendingSurface & { items: unknown[] } {
  const items: unknown[] = [];
  return {
    items,
    async add(obs) {
      items.push(obs);
    },
  };
}

function capturingBus(): {
  bus: EventBus;
  events: AgentEvent[];
} {
  const events: AgentEvent[] = [];
  const bus = createEventBus();
  bus.subscribe({}, (e) => events.push(e));
  return { bus, events };
}

function readAuditLines(path: string): Array<{ action: string; detail: string }> {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { action: string; detail: string });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Scenario 1 — capture path (happy path)
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 8 full-lifecycle DoD — capture path", () => {
  let storageDir: string;
  let tmpDir: string;
  let auditPath: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "p8dod-capture-"));
    tmpDir = mkdtempSync(join(tmpdir(), "p8dod-audit-"));
    auditPath = join(tmpDir, "audit.ndjson");
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("one frame: private-app allowlist respected, phash computed, db row written, audit appended", async () => {
    const bridge = scriptedBridge([frameStub()]);
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    const audit = new AuditLog(auditPath);
    const { bus } = capturingBus();

    const cap = new ScreenCapturer({
      storageDir,
      bridge,
      scheduler: manualScheduler(),
      db,
      bus,
      audit,
      phashDecoder: fixedDecoder(1),
      privateAppAllowlist: ["com.agilebits.onepassword7"],
    });

    const outcome = await cap.captureNow();

    assert.equal(outcome.ok, true, "capture must succeed for allowlisted app");
    if (!outcome.ok) throw new Error("unreachable");
    const frame = outcome.frame;

    // (a) private-app allowlist — Ghostty is NOT on it, so we get a frame.
    assert.equal(frame.active_app, "Ghostty");
    // (b) phash computed
    assert.equal(typeof frame.phash, "bigint");
    // (c) webp/png path is present on disk (A2 encode stays as PNG in this
    //     test path since the test bridge writes raw PNG-STUB bytes)
    const s = await stat(frame.png_path);
    assert.ok(s.isFile());
    // (d) row inserted into screen_memories with embedding placeholder + label
    const stored = db.get(frame.id);
    assert.ok(stored !== null, "row must be inserted");
    assert.equal(stored!.active_app, "Ghostty");
    // embedding placeholder + label — the capture path writes empty Buffer
    // for embedding and null for label; the consolidation worker fills them
    // later. We assert the COLUMNS exist with the expected placeholder shape.
    assert.ok(Buffer.isBuffer(stored!.embedding));
    // label column is present (null at capture time is fine — label is a
    // post-capture consolidation fill).
    assert.ok("label" in stored!);
    // (e) audit line appended
    const lines = readAuditLines(auditPath);
    const capLines = lines.filter((l) => l.action === "capture");
    assert.ok(capLines.length >= 1, `expected >=1 capture audit line; got ${lines.length}`);
    assert.ok(capLines[0]!.detail.includes("app=Ghostty"));

    db.close();
  });

  test("private-app bundle → capture skipped (PrivateAppSkippedError), no db insert", async () => {
    const bridge = scriptedBridge([
      frameStub({
        active_app: "1Password",
        active_bundle: "com.agilebits.onepassword7",
      }),
    ]);
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    const audit = new AuditLog(auditPath);

    const cap = new ScreenCapturer({
      storageDir,
      bridge,
      scheduler: manualScheduler(),
      db,
      audit,
      phashDecoder: fixedDecoder(),
      privateAppAllowlist: ["com.agilebits.onepassword7"],
    });

    await assert.rejects(
      () => cap.captureNow(),
      (err: unknown) => err instanceof Error && /private-app/.test(err.message),
    );
    // No row should have been inserted — bytesInWindow stays at zero.
    assert.equal(db.bytesInWindow(new Date(0)), 0);

    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Scenario 2 — dedup path
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 8 full-lifecycle DoD — dedup path", () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "p8dod-dedup-"));
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  test("two identical frames back-to-back: second skipped (Hamming 0)", async () => {
    const bridge = scriptedBridge([frameStub(), frameStub()]);
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });

    // fixedDecoder(1) returns the SAME bytes every call → phash identical.
    const cap = new ScreenCapturer({
      storageDir,
      bridge,
      scheduler: manualScheduler(),
      db,
      phashDecoder: fixedDecoder(1),
    });

    const first = await cap.captureNow();
    assert.equal(first.ok, true, "first capture must succeed");

    const second = await cap.captureNow();
    assert.equal(second.ok, false, "second identical frame must be skipped");
    if (second.ok) throw new Error("unreachable");
    assert.equal(second.reason, "duplicate");
    assert.equal(typeof second.phash, "bigint");

    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Scenario 3 — budget path
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 8 full-lifecycle DoD — budget path", () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "p8dod-budget-"));
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  test("bytesInWindow over budget: next capture fails with budget-exceeded + bus error + surface obs", async () => {
    const bridge = scriptedBridge([frameStub()]);

    // Fake store that reports 500 MB in the 24h window (> default 400 MB).
    const OVER_BUDGET = 500 * 1_000_000;
    const fake = {
      bytesInWindow: () => OVER_BUDGET,
      insert: (row: ScreenMemoryInput) => ({
        id: row.id,
        captured_at: row.captured_at.toISOString(),
        webp_path: row.webp_path,
        phash: typeof row.phash === "bigint" ? row.phash : BigInt(row.phash),
        active_app: row.active_app,
        window_title: row.window_title,
        ocr_text_zstd: row.ocr_text_zstd,
        label: row.label,
        embedding: row.embedding,
        task_id: row.task_id,
        session_id: row.session_id,
        bytes: row.bytes ?? 0,
      }),
    };
    const { bus, events } = capturingBus();
    const surface = collectingSurface();

    const cap = new ScreenCapturer({
      storageDir,
      bridge,
      scheduler: manualScheduler(),
      db: fake,
      bus,
      pendingSurface: surface,
      phashDecoder: fixedDecoder(),
    });

    const outcome = await cap.captureNow();
    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error("unreachable");
    assert.equal(outcome.reason, "budget-exceeded");
    assert.equal(outcome.bytesInWindow, OVER_BUDGET);
    assert.equal(outcome.budget, CAPTURE_DEFAULTS.CAPTURE_BUDGET_DAILY_BYTES);

    // Bus event emitted.
    const errEvents = events.filter(
      (e) =>
        e.kind === "error" &&
        typeof e.payload === "object" &&
        e.payload !== null &&
        (e.payload as Record<string, unknown>).where === "capture.budget",
    );
    assert.equal(errEvents.length, 1, "one capture.budget error event");

    // Pending surface observation pushed.
    assert.equal(surface.items.length, 1, "one pending-surface observation");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Scenario 4 — retention path
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 8 full-lifecycle DoD — retention path", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "p8dod-retention-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("8-day-old row: webp_path nulled, bytes reclaimed, embedding/label/ocr preserved; second run is no-op", async () => {
    const db = new ScreenMemoriesDB({ dbPath: ":memory:" });
    const now = new Date("2026-04-15T12:00:00Z");
    const EIGHT_DAYS_AGO = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

    const webpPath = join(tmpDir, "old-frame.webp");
    await writeFile(webpPath, "WEBP-STUB-contents");

    const embedding = Buffer.from(new Array(16).fill(7)); // distinctive
    const ocrZstd = Buffer.from("zstd-compressed-ocr");
    const input: ScreenMemoryInput = {
      id: "old-1",
      captured_at: EIGHT_DAYS_AGO,
      webp_path: webpPath,
      phash: 42n,
      active_app: "VSCode",
      window_title: "main.ts",
      ocr_text_zstd: ocrZstd,
      label: "Editing main.ts",
      embedding,
      task_id: "task-abc",
      session_id: "sess-1",
      bytes: 12_345,
    };
    db.insert(input);

    // Sanity — webp file exists + db sees it.
    assert.ok((await stat(webpPath)).isFile());
    assert.equal(db.get("old-1")!.webp_path, webpPath);

    const report = await runRetention({ db }, { now: () => now });

    assert.equal(report.scanned, 1);
    assert.equal(report.downgraded, 1);
    assert.equal(report.bytesReclaimed, 12_345);
    assert.equal(report.errors.length, 0);

    // webp file is gone, webp_path is null, but embedding + label + ocr survive.
    await assert.rejects(() => stat(webpPath));
    const downgraded = db.get("old-1")!;
    assert.equal(downgraded.webp_path, null);
    assert.deepEqual(downgraded.embedding, embedding);
    assert.equal(downgraded.label, "Editing main.ts");
    assert.deepEqual(downgraded.ocr_text_zstd, ocrZstd);

    // Second run: nothing to do. listOlderThan filters webp_path IS NOT NULL,
    // so scanned=0.
    const again = await runRetention({ db }, { now: () => now });
    assert.equal(again.scanned, 0);
    assert.equal(again.downgraded, 0);
    assert.equal(again.bytesReclaimed, 0);

    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Scenario 5 — kill-switch path
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 8 full-lifecycle DoD — kill-switch path", () => {
  let storageDir: string;
  let tmpDir: string;
  let auditPath: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "p8dod-kill-"));
    tmpDir = mkdtempSync(join(tmpdir(), "p8dod-kill-audit-"));
    auditPath = join(tmpDir, "audit.ndjson");
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("hotkey source: capturer.forceOff called, ornaments cleared, audit 'perception_killed source=hotkey'", async () => {
    const bridge = scriptedBridge([frameStub(), frameStub()]);
    const cap = new ScreenCapturer({
      storageDir,
      bridge,
      scheduler: manualScheduler(),
      phashDecoder: fixedDecoder(),
    });
    await cap.start();
    assert.equal(cap.isRunning(), true);

    let clearAllCalls = 0;
    const panes = {
      async clearAll() {
        clearAllCalls += 1;
      },
    } as unknown as PaneOrnamentManager;

    const audit = new AuditLog(auditPath);
    const ks = new PerceptionKillSwitch({
      capturer: cap,
      paneOrnaments: panes,
      audit,
    });

    await ks.trigger("hotkey");

    assert.equal(ks.hasFired(), true);
    assert.equal(cap.isRunning(), false, "forceOff must stop the loop");
    assert.equal(clearAllCalls, 1, "ornaments must be cleared");

    const lines = readAuditLines(auditPath);
    const killLine = lines.find((l) => l.action === "perception_killed");
    assert.ok(killLine, "perception_killed audit line must exist");
    assert.equal(killLine!.detail, "source=hotkey");

    // Second trigger is a no-op — switch latches.
    await ks.trigger("hotkey");
    const linesAfter = readAuditLines(auditPath);
    assert.equal(
      linesAfter.filter((l) => l.action === "perception_killed").length,
      1,
      "second trigger must not duplicate the audit line",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Scenario 6 — voice-kill path
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 8 full-lifecycle DoD — voice-kill path", () => {
  let storageDir: string;
  let tmpDir: string;
  let auditPath: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "p8dod-vkill-"));
    tmpDir = mkdtempSync(join(tmpdir(), "p8dod-vkill-audit-"));
    auditPath = join(tmpDir, "audit.ndjson");
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("extractIntent('stop') → kind='kill' routed through VoiceOrchestrator → kill fires, TTS stopped", async () => {
    // Intent extractor lineage.
    const direct = extractIntent("stop");
    assert.equal(direct.kind, "kill");
    assert.equal(direct.confidence, 1);

    // End-to-end routing through VoiceOrchestrator.
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = new TextToSpeech({});
    const { bus } = capturingBus();
    const audit = new AuditLog(auditPath);

    const bridge = scriptedBridge([frameStub()]);
    const cap = new ScreenCapturer({
      storageDir,
      bridge,
      scheduler: manualScheduler(),
      phashDecoder: perCallUniqueDecoder(),
    });
    await cap.start();

    let clearAllCalls = 0;
    const panes = {
      async clearAll() {
        clearAllCalls += 1;
      },
    } as unknown as PaneOrnamentManager;

    const ks = new PerceptionKillSwitch({
      capturer: cap,
      paneOrnaments: panes,
      bus,
      audit,
    });

    let ttsStopped = 0;
    const ttsStopOriginal = tts.stop.bind(tts);
    tts.stop = () => {
      ttsStopped += 1;
      ttsStopOriginal();
    };

    let onTaskCalled = 0;
    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async () => {
        onTaskCalled += 1;
        return "unused";
      },
      killSwitch: ks,
      audit,
    });

    // Prime STT to emit "stop".
    stt._resolveWith("stop");
    sm.transition("listening");
    // @ts-expect-error private — deliberate test seam (matches existing tests)
    await orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );

    assert.equal(onTaskCalled, 0, "onTask must NOT run for kill intent");
    assert.equal(ttsStopped, 1, "TTS must be told to stop");
    assert.equal(ks.hasFired(), true, "kill-switch must fire");
    assert.equal(cap.isRunning(), false, "capturer must be stopped");
    assert.equal(clearAllCalls, 1, "ornaments must be cleared");

    const lines = readAuditLines(auditPath);
    assert.ok(lines.some((l) => l.action === "voice_intent"));
    assert.ok(lines.some((l) => l.action === "perception_killed"));
    const killLine = lines.find((l) => l.action === "perception_killed");
    assert.equal(killLine!.detail, "source=voice");
  });
});
