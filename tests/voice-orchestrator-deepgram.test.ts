/**
 * Tests for VoiceOrchestrator's Deepgram integration — deliverTranscript,
 * triggerWake, and speakWithEchoGate wiring to the Deepgram stream.
 *
 * Uses mock-first London School TDD: all dependencies are stubs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { VoiceOrchestrator } from "../src/voice/voice-orchestrator.js";
import { createEventBus } from "../src/ipc/event-bus.js";

// ── Mock factories ───────────────────────────────────────────────────

function createMockStateMachine() {
  let state = "idle";
  return {
    getState: () => state,
    transition: (s: string) => { state = s; },
    onStateChange: () => {},
  };
}

function createMockWakeWord() {
  let onWake = () => {};
  return {
    setOnWake: (fn: () => void) => { onWake = fn; },
    start: async () => {},
    stop: () => {},
    isListening: () => false,
    _simulateWake: () => onWake(),
    keyword: "cortex",
  };
}

function createMockStt() {
  return {
    startRecording: async () => {},
    stopRecording: async () => "",
    isRecording: () => false,
  };
}

function createMockTts() {
  let speakResolve: (() => void) | null = null;
  return {
    speak: async (_text: string) => {
      // Resolve immediately for test speed
      return new Promise<void>((resolve) => {
        speakResolve = resolve;
        // Auto-resolve after a tick so tests don't hang
        setTimeout(resolve, 5);
      });
    },
    stop: () => {},
    isSpeaking: () => false,
    _resolveSpeak: () => { speakResolve?.(); },
  };
}

function createMockDeepgram() {
  const calls: string[] = [];
  let currentMode = "wake";
  let echoText = "";
  let ttsStartedCalled = false;
  let ttsEndedCalled = false;

  return {
    start: async () => { calls.push("start"); },
    stop: () => { calls.push("stop"); },
    setMode: (mode: string) => { currentMode = mode; calls.push(`setMode:${mode}`); },
    getMode: () => currentMode,
    setEchoText: (text: string) => { echoText = text; calls.push(`setEchoText:${text}`); },
    markTtsStarted: () => { ttsStartedCalled = true; calls.push("markTtsStarted"); },
    markTtsEnded: () => { ttsEndedCalled = true; calls.push("markTtsEnded"); },
    isRunning: () => true,
    // Test accessors
    _calls: calls,
    _getMode: () => currentMode,
    _getEchoText: () => echoText,
    _ttsStartedCalled: () => ttsStartedCalled,
    _ttsEndedCalled: () => ttsEndedCalled,
  };
}

function createOrchestratorWithDeepgram(overrides: Record<string, unknown> = {}) {
  const sm = createMockStateMachine();
  const wakeWord = createMockWakeWord();
  const stt = createMockStt();
  const tts = createMockTts();
  const bus = createEventBus();
  const deepgram = createMockDeepgram();

  const orchestrator = new VoiceOrchestrator({
    wakeWord: wakeWord as any,
    stt: stt as any,
    tts: tts as any,
    deepgram: deepgram as any,
    stateMachine: sm as any,
    bus,
    onTask: async (t: string) => `Reply to: ${t}`,
    ...overrides,
  });

  return { orchestrator, sm, wakeWord, stt, tts, bus, deepgram };
}

// ── deliverTranscript ────────────────────────────────────────────────

describe("VoiceOrchestrator — deliverTranscript", () => {
  test("resolves pending dgTranscriptResolve promise", async () => {
    const { orchestrator } = createOrchestratorWithDeepgram();

    // Manually set up the internal promise like processVoiceInteraction does
    let resolved = false;
    let resolvedText = "";
    const promise = new Promise<string>((resolve) => {
      (orchestrator as any).dgTranscriptResolve = resolve;
    }).then((text) => {
      resolved = true;
      resolvedText = text;
    });

    orchestrator.deliverTranscript("hello world");
    await promise;

    assert.equal(resolved, true);
    assert.equal(resolvedText, "hello world");
    // Should clear the resolver after use
    assert.equal((orchestrator as any).dgTranscriptResolve, null);
  });

  test("no-ops when no pending promise", () => {
    const { orchestrator } = createOrchestratorWithDeepgram();
    // Should not throw
    assert.doesNotThrow(() => {
      orchestrator.deliverTranscript("stray transcript");
    });
  });
});

// ── triggerWake ──────────────────────────────────────────────────────

describe("VoiceOrchestrator — triggerWake", () => {
  test("calls handleWake which transitions state", async () => {
    const { orchestrator, sm, deepgram } = createOrchestratorWithDeepgram();
    (orchestrator as any).running = true;

    orchestrator.triggerWake();

    // handleWake sets deepgram to interrupt mode
    assert.ok(
      deepgram._calls.includes("setMode:interrupt"),
      "triggerWake should set deepgram to interrupt mode",
    );
  });

  test("triggerWake is a no-op when not running", () => {
    const { orchestrator, deepgram } = createOrchestratorWithDeepgram();
    // running defaults to false (not started)

    orchestrator.triggerWake();
    // Should not have called setMode since handleWake returns early
    assert.equal(
      deepgram._calls.filter((c: string) => c.startsWith("setMode")).length,
      0,
      "should not call setMode when not running",
    );
  });
});

// ── speakWithEchoGate Deepgram integration ───────────────────────────

describe("VoiceOrchestrator — speakWithEchoGate Deepgram calls", () => {
  test("sets interrupt mode before TTS", async () => {
    const { orchestrator, deepgram } = createOrchestratorWithDeepgram();

    // Call the private method directly
    await (orchestrator as any).speakWithEchoGate("Hello there");

    assert.ok(
      deepgram._calls.includes("setMode:interrupt"),
      "should set interrupt mode before speaking",
    );
  });

  test("calls setEchoText with the spoken text", async () => {
    const { orchestrator, deepgram } = createOrchestratorWithDeepgram();

    await (orchestrator as any).speakWithEchoGate("Good morning");

    assert.ok(
      deepgram._calls.includes("setEchoText:Good morning"),
      "should set echo text for rejection",
    );
  });

  test("calls markTtsStarted before TTS and markTtsEnded after", async () => {
    const { orchestrator, deepgram } = createOrchestratorWithDeepgram();

    await (orchestrator as any).speakWithEchoGate("Test");

    const startIdx = deepgram._calls.indexOf("markTtsStarted");
    const endIdx = deepgram._calls.indexOf("markTtsEnded");

    assert.ok(startIdx >= 0, "markTtsStarted should be called");
    assert.ok(endIdx >= 0, "markTtsEnded should be called");
    assert.ok(startIdx < endIdx, "markTtsStarted should come before markTtsEnded");
  });

  test("markTtsEnded is called even if TTS throws", async () => {
    const tts = {
      speak: async () => { throw new Error("TTS failed"); },
      stop: () => {},
      isSpeaking: () => false,
    };
    const { orchestrator, deepgram } = createOrchestratorWithDeepgram({ tts });

    try {
      await (orchestrator as any).speakWithEchoGate("Broken");
    } catch {
      // Expected
    }

    assert.ok(
      deepgram._ttsEndedCalled(),
      "markTtsEnded should be called in finally block even on TTS error",
    );
  });
});

// ── start() with Deepgram ────────────────────────────────────────────

describe("VoiceOrchestrator — start with Deepgram", () => {
  test("start() calls deepgram.start() instead of wakeWord.start()", async () => {
    const { orchestrator, deepgram } = createOrchestratorWithDeepgram();
    await orchestrator.start();

    assert.ok(
      deepgram._calls.includes("start"),
      "should call deepgram.start()",
    );

    orchestrator.stop();
  });

  test("stop() calls deepgram.stop()", async () => {
    const { orchestrator, deepgram } = createOrchestratorWithDeepgram();
    await orchestrator.start();
    orchestrator.stop();

    assert.ok(
      deepgram._calls.includes("stop"),
      "should call deepgram.stop()",
    );
  });
});

// ── EchoGate + Deepgram combined ─────────────────────────────────────

describe("VoiceOrchestrator — echoGate + Deepgram combined", () => {
  test("speakWithEchoGate mutes echoGate and sets deepgram echo text", async () => {
    let muted = false;
    let unmuted = false;
    const echoGate = {
      mute: () => { muted = true; },
      unmute: () => { unmuted = true; },
      isMuted: () => muted,
      dispose: () => {},
    };

    const { orchestrator, deepgram } = createOrchestratorWithDeepgram({
      echoGate,
    });

    await (orchestrator as any).speakWithEchoGate("Combined test");

    assert.equal(muted, true, "echoGate.mute() should be called");
    assert.equal(unmuted, true, "echoGate.unmute() should be called after TTS");
    assert.ok(
      deepgram._calls.includes("setEchoText:Combined test"),
      "deepgram echo text should be set",
    );
  });
});
