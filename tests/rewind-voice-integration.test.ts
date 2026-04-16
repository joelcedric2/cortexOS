/**
 * Phase 15 — voice → rewind integration test.
 *
 * Exercises the full hop-chain:
 *   transcript "what was that article I was reading 40 minutes ago"
 *     → extractIntent() routes to kind='rewind'
 *     → VoiceOrchestrator.processVoiceInteraction() short-circuits the task
 *        pipeline and calls RewindHandler.query()
 *     → top-1 label is spoken via TTS (captured by the mock)
 *     → the full top-5 is surfaced to the Pending Surface mock
 *     → onTask is NEVER called
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AudioStateMachine } from "../src/voice/audio-state.js";
import { WakeWordDetector } from "../src/voice/wake-word.js";
import { SpeechToText } from "../src/voice/stt.js";
import { TextToSpeech } from "../src/voice/tts.js";
import {
  VoiceOrchestrator,
  type RewindHandler,
  type RewindSurface,
} from "../src/voice/voice-orchestrator.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import { AuditLog } from "../src/proactivity/audit.js";
import { extractIntent } from "../src/voice/intent-extractor.js";
import type { RewindResult } from "../src/rewind/rewind-query.js";

describe("extractIntent — rewind routing", () => {
  test("'what was that article I was reading 40 minutes ago' → kind=rewind", () => {
    const r = extractIntent(
      "what was that article I was reading 40 minutes ago",
    );
    assert.equal(r.kind, "rewind");
    assert.equal(r.confidence, 1);
  });

  test("'show me the page I had open' → kind=rewind", () => {
    assert.equal(
      extractIntent("show me the page I had open earlier").kind,
      "rewind",
    );
  });

  test("'find the error message I saw yesterday' → kind=rewind", () => {
    assert.equal(
      extractIntent("find the error message I saw yesterday").kind,
      "rewind",
    );
  });

  test("'remember when I was on that website' → kind=rewind", () => {
    assert.equal(
      extractIntent("remember when I was on that website").kind,
      "rewind",
    );
  });

  test("prefix 'nchinda, what was I reading…' → kind=rewind", () => {
    assert.equal(
      extractIntent("nchinda, what was I reading 40 minutes ago").kind,
      "rewind",
    );
  });

  test("'summarize my inbox' → still kind=task", () => {
    assert.equal(extractIntent("summarize my inbox").kind, "task");
  });
});

describe("VoiceOrchestrator — rewind branch", () => {
  test("rewind transcript routes to handler, speaks top-1 label, surfaces top-5", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-rewind-voice-"));
    const auditPath = join(tmpDir, "audit.ndjson");
    const audit = new AuditLog(auditPath);

    try {
      const sm = new AudioStateMachine();
      const wake = new WakeWordDetector({ onWake: () => {} });
      const stt = new SpeechToText({});
      const tts = new TextToSpeech({});
      const bus = createEventBus();

      // Pre-arm TTS so speak() settles immediately when the test drives it.
      tts._armTestPromise();
      tts._resolveSpeak();

      const scriptedResults: RewindResult[] = [
        {
          id: "hit-1",
          captured_at: new Date(Date.now() - 40 * 60_000).toISOString(),
          label: "Hacker News: transformer paper",
          active_app: "Safari",
          window_title: "Hacker News",
          similarity: 0.92,
          ocr_excerpt: "… attention is all you need …",
          webp_path: "/tmp/hit-1.webp",
        },
        {
          id: "hit-2",
          captured_at: new Date(Date.now() - 45 * 60_000).toISOString(),
          label: "A related post",
          active_app: "Safari",
          window_title: "Medium",
          similarity: 0.81,
          webp_path: "/tmp/hit-2.webp",
        },
      ];

      const queries: string[] = [];
      const handler: RewindHandler = {
        async query(t) {
          queries.push(t);
          return scriptedResults;
        },
      };

      const surfaced: RewindResult[][] = [];
      const surface: RewindSurface = {
        present(results) {
          surfaced.push(results);
        },
      };

      // Capture the text TTS was asked to speak.
      const spoken: string[] = [];
      const origSpeak = tts.speak.bind(tts);
      tts.speak = async (text: string) => {
        spoken.push(text);
        return origSpeak(text);
      };

      let onTaskCalled = 0;
      const orchestrator = new VoiceOrchestrator({
        wakeWord: wake,
        stt,
        tts,
        stateMachine: sm,
        bus,
        onTask: async () => {
          onTaskCalled++;
          return "should not happen";
        },
        audit,
        rewindHandler: handler,
        rewindSurface: surface,
      });

      stt._resolveWith("what was that article I was reading 40 minutes ago");
      sm.transition("listening");
      // @ts-expect-error private test seam
      await orchestrator["processVoiceInteraction"](
        // @ts-expect-error private
        orchestrator["generation"],
      );

      assert.equal(onTaskCalled, 0, "rewind must skip onTask");
      assert.equal(queries.length, 1, "handler queried once");
      assert.ok(
        queries[0]!.toLowerCase().includes("article"),
        `handler saw the transcript keywords, got: ${queries[0]}`,
      );
      assert.equal(surfaced.length, 1, "surface presented once");
      assert.deepEqual(surfaced[0], scriptedResults);

      assert.equal(spoken.length, 1, "spoke exactly one reply");
      assert.ok(
        spoken[0]!.includes("Hacker News: transformer paper"),
        `reply mentions the top label, got: ${spoken[0]}`,
      );

      // Audit line records the routing decision + hit count.
      const lines = readFileSync(auditPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { action: string; detail: string });
      const rewind = lines.find(
        (l) => l.action === "voice_intent" && l.detail.includes("intent=rewind"),
      );
      assert.ok(rewind, "voice_intent rewind line written");
      assert.ok(rewind!.detail.includes("hits=2"));

      assert.equal(sm.getState(), "idle");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("rewind transcript without a handler falls through to onTask (backward compat)", async () => {
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = new TextToSpeech({});
    const bus = createEventBus();

    tts._armTestPromise();
    tts._resolveSpeak();

    let onTaskCalled = 0;
    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async () => {
        onTaskCalled++;
        return "ok";
      },
      // No rewindHandler wired.
    });

    stt._resolveWith("what was I reading earlier");
    sm.transition("listening");
    // @ts-expect-error private test seam
    await orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );

    assert.equal(
      onTaskCalled,
      1,
      "without a handler, rewind phrases still reach onTask",
    );
  });
});
