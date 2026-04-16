import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AudioStateMachine } from "../src/voice/audio-state.js";
import { WakeWordDetector } from "../src/voice/wake-word.js";
import { SpeechToText } from "../src/voice/stt.js";
import { TextToSpeech } from "../src/voice/tts.js";
import { VoiceOrchestrator } from "../src/voice/voice-orchestrator.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import type { ConvIntent } from "../src/intent/conversation-intent.js";

/**
 * Primes a TTS with a test promise that we resolve explicitly during the
 * test. This keeps the pipeline deterministic — speak() blocks on the
 * promise instead of shelling out to `say` / `piper`, which would both
 * fail + trigger the 2s error-recovery path in CI.
 */
function primeTts(): TextToSpeech {
  const tts = new TextToSpeech({});
  tts._armTestPromise();
  return tts;
}

function makeStatedIntent(transcript: string): ConvIntent {
  return {
    kind: "stated-intent",
    confidence: 0.85,
    action_candidate: { verb: "order", object: "Thai food" },
    transcript,
    ts: new Date().toISOString(),
    source: "rule",
  };
}

describe("VoiceOrchestrator × Phase 14 conversation-intent", () => {
  it("stated-intent transcript: classify + route called fire-and-forget", async () => {
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = primeTts();
    const bus = createEventBus();

    const calls = { classify: 0, route: 0 };
    let classifyDelayResolved = false;
    let onTaskCompleted = false;
    let onTaskCompletedAt = 0;
    let classifyResolvedAt = 0;

    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async (t) => {
        onTaskCompleted = true;
        onTaskCompletedAt = Date.now();
        return `echo: ${t}`;
      },
      conversationIntent: {
        classify: async (t) => {
          calls.classify++;
          // Simulate a slow (~30ms) Haiku round-trip to assert it does NOT
          // block onTask.
          await new Promise((r) => setTimeout(r, 30));
          classifyDelayResolved = true;
          classifyResolvedAt = Date.now();
          return makeStatedIntent(t);
        },
        route: async () => {
          calls.route++;
        },
      },
    });

    stt._resolveWith("I should order Thai for Maya");
    sm.transition("listening");
    // Kick off the flow (fire-and-forget); TTS will block on the armed test
    // promise until we resolve it below.
    // @ts-expect-error private
    const flow = orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );

    // Give the flow a tick to reach onTask + queue the conv-intent task.
    await new Promise((r) => setTimeout(r, 5));
    // onTask should already have completed (it's synchronous-ish in the
    // test), but the 30ms classify delay should still be in-flight.
    assert.equal(onTaskCompleted, true, "onTask ran before classify");
    assert.equal(
      classifyDelayResolved,
      false,
      "classify should still be in-flight after onTask returns",
    );

    // Unblock TTS so speak() completes + flow transitions to idle.
    tts._resolveSpeak();
    await flow;

    // Flush the fire-and-forget task.
    await orchestrator._flushConversationIntentForTests();

    assert.equal(calls.classify, 1);
    assert.equal(calls.route, 1);
    // Order: onTask finished first, then classify resolved.
    assert.ok(
      classifyResolvedAt >= onTaskCompletedAt,
      "classify must resolve AFTER onTask",
    );
  });

  it("non-stated-intent (idle-chat) is still piped to route — route is the no-op gate", async () => {
    // The orchestrator doesn't know about ConvIntent semantics — it pipes
    // every transcript through. The router (intent-surface) decides whether
    // to act. This test verifies the orchestrator side does NOT pre-filter.
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = primeTts();
    const bus = createEventBus();

    let routed: ConvIntent | undefined;
    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async () => "ok",
      conversationIntent: {
        classify: async (t) => ({
          kind: "idle-chat",
          confidence: 0.6,
          transcript: t,
          ts: new Date().toISOString(),
          source: "rule",
        }),
        route: async (i) => {
          routed = i;
        },
      },
    });

    stt._resolveWith("this is boring");
    sm.transition("listening");
    // @ts-expect-error private
    const flow = orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );
    await new Promise((r) => setTimeout(r, 5));
    tts._resolveSpeak();
    await flow;
    await orchestrator._flushConversationIntentForTests();

    assert.equal(routed?.kind, "idle-chat");
  });

  it("classify throwing does NOT break the main onTask pipeline", async () => {
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = primeTts();
    const bus = createEventBus();

    let onTaskCalled = 0;
    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async () => {
        onTaskCalled++;
        return "fine";
      },
      conversationIntent: {
        classify: async () => {
          throw new Error("llm exploded");
        },
        route: async () => {
          throw new Error("should not be called");
        },
      },
    });

    stt._resolveWith("summarize my inbox");
    sm.transition("listening");
    // @ts-expect-error private
    const flow = orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );
    await new Promise((r) => setTimeout(r, 5));
    tts._resolveSpeak();
    await flow;
    await orchestrator._flushConversationIntentForTests();

    assert.equal(onTaskCalled, 1);
    assert.equal(sm.getState(), "idle");
  });

  it("kill intent still short-circuits BEFORE the conv-intent path runs", async () => {
    // Regression guard: the existing kill path (Phase 8.5) must not be
    // disturbed by the Phase 14 branch.
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = new TextToSpeech({});
    const bus = createEventBus();

    let classifyCalls = 0;
    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async () => "x",
      conversationIntent: {
        classify: async (t) => {
          classifyCalls++;
          return makeStatedIntent(t);
        },
        route: async () => {},
      },
    });

    stt._resolveWith("stop");
    sm.transition("listening");
    // @ts-expect-error private
    await orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );
    await orchestrator._flushConversationIntentForTests();

    // Kill path must NOT dispatch to classify — the transcript never
    // reaches the Phase 14 branch.
    assert.equal(classifyCalls, 0, "kill transcripts bypass conv-intent");
  });

  it("no conversationIntent configured: pipeline works unchanged", async () => {
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = primeTts();
    const bus = createEventBus();

    let onTaskCalled = 0;
    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async () => {
        onTaskCalled++;
        return "x";
      },
    });

    stt._resolveWith("summarize my inbox");
    sm.transition("listening");
    // @ts-expect-error private
    const flow = orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );
    await new Promise((r) => setTimeout(r, 5));
    tts._resolveSpeak();
    await flow;
    await orchestrator._flushConversationIntentForTests();

    assert.equal(onTaskCalled, 1);
  });

  it("router throwing is isolated — onTask still completes", async () => {
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = primeTts();
    const bus = createEventBus();

    let onTaskCalled = 0;
    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async () => {
        onTaskCalled++;
        return "x";
      },
      conversationIntent: {
        classify: async (t) => makeStatedIntent(t),
        route: async () => {
          throw new Error("surface failed: disk full");
        },
      },
    });

    stt._resolveWith("I should send Maya the PDF");
    sm.transition("listening");
    // @ts-expect-error private
    const flow = orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );
    await new Promise((r) => setTimeout(r, 5));
    tts._resolveSpeak();
    await flow;
    await orchestrator._flushConversationIntentForTests();

    assert.equal(onTaskCalled, 1);
  });
});
