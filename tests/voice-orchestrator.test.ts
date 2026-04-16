import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AudioStateMachine } from "../src/voice/audio-state.js";
import { WakeWordDetector, SpeechToText, TextToSpeech } from "../src/voice/_a-stub.js";
import { GlobalHotkey } from "../src/voice/hotkey.js";
import { VoiceOrchestrator } from "../src/voice/voice-orchestrator.js";
import { createEventBus, type AgentEvent } from "../src/ipc/event-bus.js";

/** Helper: create a full mock voice stack. */
function createStack(onTask?: (t: string) => Promise<string>) {
  const sm = new AudioStateMachine();
  const wakeWord = new WakeWordDetector();
  const stt = new SpeechToText();
  const tts = new TextToSpeech();
  const bus = createEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));

  const taskFn = onTask ?? (async (t: string) => `Reply to: ${t}`);

  const orchestrator = new VoiceOrchestrator({
    wakeWord,
    stt,
    tts,
    stateMachine: sm,
    bus,
    onTask: taskFn,
  });

  return { sm, wakeWord, stt, tts, bus, events, orchestrator };
}

describe("VoiceOrchestrator", () => {
  test("full happy path: wake -> listen -> transcript -> think -> speak -> idle", async () => {
    const { sm, wakeWord, stt, tts, orchestrator, events } = createStack();
    await orchestrator.start();

    // Wait for idle after a full cycle.
    const flowDone = new Promise<void>((resolve) => {
      sm.onStateChange((e) => {
        if (e.state === "idle" && events.length > 1) {
          resolve();
        }
      });
    });

    // Trigger wake.
    wakeWord._simulateWake();

    // Give the orchestrator a tick to start recording.
    await new Promise((r) => setTimeout(r, 10));

    // Resolve STT with a transcript.
    stt._resolveWith("schedule a meeting tomorrow");

    // Give thinking + onTask a tick.
    await new Promise((r) => setTimeout(r, 10));

    // Resolve TTS speak.
    tts._resolveSpeak();

    // Wait for the flow to complete.
    await flowDone;

    assert.equal(sm.getState(), "idle");

    // Check bus events.
    const wakeEvent = events.find(
      (e) => e.kind === "plan_emitted" && (e.payload as Record<string, unknown>).phase === "VOICE_WAKE",
    );
    assert.ok(wakeEvent, "Expected VOICE_WAKE bus event");

    const taskEvent = events.find(
      (e) => e.kind === "plan_emitted" && (e.payload as Record<string, unknown>).phase === "VOICE_TASK",
    );
    assert.ok(taskEvent, "Expected VOICE_TASK bus event");

    orchestrator.stop();
  });

  test("interruption: wake during speak -> tts.stop called, re-enters listening", async () => {
    const { sm, wakeWord, stt, tts, orchestrator } = createStack();
    await orchestrator.start();

    // Start the first flow.
    wakeWord._simulateWake();
    await new Promise((r) => setTimeout(r, 10));
    stt._resolveWith("hello");
    await new Promise((r) => setTimeout(r, 10));

    // Now state should be 'speaking' (TTS hasn't resolved yet).
    assert.equal(sm.getState(), "speaking");
    assert.equal(tts.isSpeaking(), true);

    // Interrupt with another wake-word.
    wakeWord._simulateWake();
    await new Promise((r) => setTimeout(r, 10));

    // TTS should have been stopped.
    assert.equal(tts.isSpeaking(), false);
    // State should be 'listening' (new interaction started).
    assert.equal(sm.getState(), "listening");

    // Complete the second interaction.
    stt._resolveWith("what time is it");
    await new Promise((r) => setTimeout(r, 10));
    tts._resolveSpeak();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sm.getState(), "idle");
    orchestrator.stop();
  });

  test("error recovery: onTask throws -> state goes error -> idle", async () => {
    const { sm, wakeWord, stt, orchestrator } = createStack(async () => {
      throw new Error("API failure");
    });
    await orchestrator.start();

    const recoveredToIdle = new Promise<void>((resolve) => {
      let sawError = false;
      sm.onStateChange((e) => {
        if (e.state === "error") sawError = true;
        if (e.state === "idle" && sawError) resolve();
      });
    });

    wakeWord._simulateWake();
    await new Promise((r) => setTimeout(r, 10));
    stt._resolveWith("fail task");

    // Wait for error recovery (2s delay + some margin).
    await recoveredToIdle;

    assert.equal(sm.getState(), "idle");
    orchestrator.stop();
  });

  test("empty transcript returns to idle without calling onTask", async () => {
    let taskCalled = false;
    const { sm, wakeWord, stt, orchestrator } = createStack(async () => {
      taskCalled = true;
      return "should not happen";
    });
    await orchestrator.start();

    const backToIdle = new Promise<void>((resolve) => {
      sm.onStateChange((e) => {
        if (e.state === "idle") resolve();
      });
    });

    wakeWord._simulateWake();
    await new Promise((r) => setTimeout(r, 10));
    stt._resolveWith("   "); // whitespace-only

    await backToIdle;
    assert.equal(taskCalled, false);
    assert.equal(sm.getState(), "idle");
    orchestrator.stop();
  });

  test("hotkey triggers wake flow", async () => {
    const { sm, wakeWord, stt, tts, orchestrator } = createStack();
    const hotkey = new GlobalHotkey({
      onPress: () => wakeWord._simulateWake(),
    });

    const orch = new VoiceOrchestrator({
      wakeWord,
      stt,
      tts,
      stateMachine: sm,
      bus: createEventBus(),
      onTask: async (t) => `Echo: ${t}`,
      hotkey,
    });

    await orch.start();
    assert.equal(hotkey.isRegistered(), true);

    // Press the hotkey.
    hotkey.simulatePress();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sm.getState(), "listening");

    stt._resolveWith("hotkey test");
    await new Promise((r) => setTimeout(r, 10));
    tts._resolveSpeak();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sm.getState(), "idle");
    orch.stop();

    // Clean up original orchestrator too.
    orchestrator.stop();
  });

  test("stop prevents further processing", async () => {
    const { sm, wakeWord, orchestrator } = createStack();
    await orchestrator.start();
    orchestrator.stop();

    // Wake-word fire should be ignored after stop.
    wakeWord._simulateWake();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sm.getState(), "idle"); // unchanged
  });
});
