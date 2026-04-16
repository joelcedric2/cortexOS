/**
 * Phase 9 — voice × camera integration.
 *
 * End-to-end wiring: a STT transcript of "what am I looking at" runs the
 * intent extractor, lands on the `camera-query` branch in
 * VoiceOrchestrator, invokes `onCameraQuery` (nchindaLook), and speaks
 * the returned description via TTS — without touching the normal
 * `onTask` path.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AudioStateMachine } from "../src/voice/audio-state.js";
import { WakeWordDetector } from "../src/voice/wake-word.js";
import { SpeechToText } from "../src/voice/stt.js";
import { TextToSpeech } from "../src/voice/tts.js";
import { VoiceOrchestrator } from "../src/voice/voice-orchestrator.js";
import { createEventBus, type AgentEvent } from "../src/ipc/event-bus.js";
import { AuditLog } from "../src/proactivity/audit.js";
import { extractIntent } from "../src/voice/intent-extractor.js";
import type {
  NchindaLookInput,
  NchindaLookResult,
} from "../src/mcp/nchinda-look.js";

describe("extractIntent — camera-query routing", () => {
  it("routes 'what am I looking at' to camera-query", () => {
    const r = extractIntent("what am I looking at");
    assert.equal(r.kind, "camera-query");
    assert.equal(r.confidence, 1);
    assert.equal(r.payload?.question, "what am I looking at");
  });

  it("routes 'what do you see' to camera-query", () => {
    const r = extractIntent("What do you see?");
    assert.equal(r.kind, "camera-query");
    assert.equal(r.confidence, 1);
  });

  it("routes 'look at this' to camera-query", () => {
    const r = extractIntent("look at this");
    assert.equal(r.kind, "camera-query");
  });

  it("routes 'look at that' to camera-query", () => {
    const r = extractIntent("look at that");
    assert.equal(r.kind, "camera-query");
  });

  it("routes 'is this safe to eat?' to camera-query", () => {
    const r = extractIntent("is this safe to eat?");
    assert.equal(r.kind, "camera-query");
    // Question form preserves the punctuation so downstream vision can
    // interpret it as a question.
    assert.match(r.payload?.question ?? "", /\?$/);
  });

  it("routes 'is that a bird?' to camera-query", () => {
    const r = extractIntent("is that a bird?");
    assert.equal(r.kind, "camera-query");
  });

  it("does NOT route 'is this' without a question mark", () => {
    const r = extractIntent("is this working");
    assert.equal(r.kind, "task");
  });

  it("does NOT route embedded 'what do you see' inside a task", () => {
    const r = extractIntent("tell me what do you see when you open the app");
    assert.equal(r.kind, "task");
  });
});

describe("VoiceOrchestrator × camera-query", () => {
  let tmpDir: string;
  let auditPath: string;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cortex-voice-cam-"));
    auditPath = join(tmpDir, "audit.ndjson");
    audit = new AuditLog(auditPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("'what am I looking at' → onCameraQuery invoked, TTS speaks description, onTask never called", async () => {
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = new TextToSpeech({});
    const bus = createEventBus();
    const events: AgentEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));

    let onTaskCalled = 0;
    let onCameraQueryCalled = 0;
    let seenQuestion: string | undefined;

    const onCameraQuery = async (
      input: NchindaLookInput,
    ): Promise<NchindaLookResult> => {
      onCameraQueryCalled++;
      seenQuestion = input.question;
      return {
        description: "A wooden desk with a laptop and a coffee mug.",
        ocr_text: undefined,
        frame: {
          id: "cam-1",
          path: "/tmp/cam-1.jpg",
          ts: new Date().toISOString(),
        },
      };
    };

    // Arm TTS so speak() is observable; track what it spoke.
    const spoken: string[] = [];
    const origSpeak = tts.speak.bind(tts);
    tts.speak = async (text: string) => {
      spoken.push(text);
      tts._armTestPromise();
      tts._resolveSpeak();
      return origSpeak(text);
    };

    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async (t) => {
        onTaskCalled++;
        return `echo: ${t}`;
      },
      onCameraQuery,
      audit,
    });

    stt._resolveWith("what am I looking at");
    sm.transition("listening");
    // @ts-expect-error private test seam
    await orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );

    assert.equal(onCameraQueryCalled, 1, "onCameraQuery fired exactly once");
    assert.equal(onTaskCalled, 0, "onTask must NOT be called for camera-query");
    assert.ok(
      seenQuestion && /looking at/i.test(seenQuestion),
      `question forwarded: ${seenQuestion}`,
    );
    assert.equal(spoken.length, 1);
    assert.match(spoken[0]!, /wooden desk|laptop|coffee mug/i);
    assert.equal(sm.getState(), "idle");

    // Bus event emitted.
    const cameraEvent = events.find(
      (e) =>
        e.kind === "plan_emitted" &&
        (e.payload as Record<string, unknown>).phase === "VOICE_CAMERA",
    );
    assert.ok(cameraEvent, "VOICE_CAMERA bus event emitted");

    // Audit line recorded.
    const lines = readFileSync(auditPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { action: string; detail: string });
    const voiceLine = lines.find((l) => l.action === "voice_intent");
    assert.ok(voiceLine);
    assert.match(voiceLine!.detail, /intent=camera-query/);
  });

  it("speaks a graceful error when onCameraQuery throws", async () => {
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = new TextToSpeech({});
    const bus = createEventBus();

    const spoken: string[] = [];
    const origSpeak = tts.speak.bind(tts);
    tts.speak = async (text: string) => {
      spoken.push(text);
      tts._armTestPromise();
      tts._resolveSpeak();
      return origSpeak(text);
    };

    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async () => "irrelevant",
      onCameraQuery: async () => {
        throw new Error("camera permission denied");
      },
      audit,
    });

    stt._resolveWith("is that a bird?");
    sm.transition("listening");
    // @ts-expect-error private test seam
    await orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );

    assert.equal(spoken.length, 1);
    assert.match(spoken[0]!, /couldn't see|camera permissions/i);
    assert.equal(sm.getState(), "idle");
  });

  it("camera-query falls through to onTask when no onCameraQuery is wired (backward compat)", async () => {
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = new TextToSpeech({});
    const bus = createEventBus();

    const spoken: string[] = [];
    const origSpeak = tts.speak.bind(tts);
    tts.speak = async (text: string) => {
      spoken.push(text);
      tts._armTestPromise();
      tts._resolveSpeak();
      return origSpeak(text);
    };

    let onTaskCalled = 0;
    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async (t) => {
        onTaskCalled++;
        return `task-reply for ${t}`;
      },
      // No onCameraQuery.
    });

    stt._resolveWith("what do you see");
    sm.transition("listening");
    // @ts-expect-error private test seam
    await orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );

    assert.equal(onTaskCalled, 1, "falls through to onTask");
    assert.equal(spoken.length, 1);
    assert.match(spoken[0]!, /task-reply/);
  });
});
