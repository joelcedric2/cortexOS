/**
 * Tests for DeepgramVoiceStream — the streaming STT module with modes
 * (wake/command/interrupt), echo rejection, and command buffering.
 *
 * We never call start() (which spawns sox + WebSocket). Instead we
 * instantiate with a dummy key and exercise public + internal methods
 * directly via `as any` for private access.
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { DeepgramVoiceStream } from "../src/voice/deepgram-stream.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a fake MessageEvent-like object and feed it to handleMessage. */
function simulateMessage(stream: any, msg: object): void {
  stream.handleMessage({ data: JSON.stringify(msg) });
}

/** Build a Deepgram Results message with a transcript. */
function resultsMsg(
  transcript: string,
  opts: {
    is_final?: boolean;
    speech_final?: boolean;
    start?: number;
    duration?: number;
  } = {},
): object {
  return {
    type: "Results",
    channel: { alternatives: [{ transcript }] },
    is_final: opts.is_final ?? false,
    speech_final: opts.speech_final ?? false,
    start: opts.start,
    duration: opts.duration,
  };
}

// ── Constructor ──────────────────────────────────────────────────────

describe("DeepgramVoiceStream — constructor", () => {
  test("defaults wake words to cortex and nchinda", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    const words: string[] = (stream as any).wakeWords;
    assert.deepEqual(words, ["cortex", "nchinda"]);
  });

  test("accepts custom wake words", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      wakeWords: ["jarvis", "Friday"],
      onWake: () => {},
      onTranscript: () => {},
    });
    const words: string[] = (stream as any).wakeWords;
    assert.deepEqual(words, ["jarvis", "friday"]);
  });
});

// ── isRunning ────────────────────────────────────────────────────────

describe("DeepgramVoiceStream — isRunning", () => {
  test("returns false before start", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    assert.equal(stream.isRunning(), false);
  });

  test("tracks running state", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    // Manually flip the internal flag (we cannot call start without real infra)
    (stream as any).running = true;
    assert.equal(stream.isRunning(), true);
  });
});

// ── setMode ──────────────────────────────────────────────────────────

describe("DeepgramVoiceStream — setMode", () => {
  test("switching to wake clears wakeFired", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    (stream as any).wakeFired = true;
    stream.setMode("wake");
    assert.equal((stream as any).wakeFired, false);
  });

  test("switching to command clears buffer and partial", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    (stream as any).commandBuffer = ["leftover"];
    (stream as any).lastPartial = "something";
    stream.setMode("command");
    assert.deepEqual((stream as any).commandBuffer, []);
    assert.equal((stream as any).lastPartial, "");
  });

  test("switching to interrupt does not clear wake or command state", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    (stream as any).wakeFired = true;
    (stream as any).commandBuffer = ["something"];
    stream.setMode("interrupt");
    // wakeFired is NOT reset by interrupt
    assert.equal((stream as any).wakeFired, true);
    assert.deepEqual((stream as any).commandBuffer, ["something"]);
  });

  test("getMode reflects current mode", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    assert.equal(stream.getMode(), "wake");
    stream.setMode("command");
    assert.equal(stream.getMode(), "command");
    stream.setMode("interrupt");
    assert.equal(stream.getMode(), "interrupt");
  });
});

// ── TTS timestamp tracking ───────────────────────────────────────────

describe("DeepgramVoiceStream — markTtsStarted / markTtsEnded", () => {
  test("markTtsStarted sets ttsStartedAtMs", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    assert.equal((stream as any).ttsStartedAtMs, 0);
    stream.markTtsStarted();
    assert.ok((stream as any).ttsStartedAtMs > 0);
  });

  test("markTtsEnded sets ttsEndedAtMs and ttsEndedAt", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    stream.markTtsEnded();
    assert.ok((stream as any).ttsEndedAtMs > 0);
    assert.ok((stream as any).ttsEndedAt > 0);
  });
});

// ── setEchoText ──────────────────────────────────────────────────────

describe("DeepgramVoiceStream — setEchoText", () => {
  test("normalizes and stores echo text", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    stream.setEchoText("Welcome, sir! I'm online.");
    // Should be lowercased, punctuation stripped
    assert.equal((stream as any).echoBuffer, "welcome sir im online");
  });

  test("sets ttsEndedAt for expiry window", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    const before = Date.now();
    stream.setEchoText("test");
    assert.ok((stream as any).ttsEndedAt >= before);
  });
});

// ── Wake word detection ──────────────────────────────────────────────

describe("DeepgramVoiceStream — wake word detection", () => {
  let wakeFired: boolean;
  let stream: DeepgramVoiceStream;

  beforeEach(() => {
    wakeFired = false;
    stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { wakeFired = true; },
      onTranscript: () => {},
    });
    // Bypass the 200ms debounce after mode change
    (stream as any).modeChangedAt = 0;
  });

  test("transcript containing 'cortex' fires onWake", () => {
    simulateMessage(stream, resultsMsg("Hey Cortex, what time is it"));
    assert.equal(wakeFired, true);
  });

  test("transcript containing 'nchinda' fires onWake", () => {
    simulateMessage(stream, resultsMsg("Nchinda tell me the weather"));
    assert.equal(wakeFired, true);
  });

  test("transcript without wake word does NOT fire onWake", () => {
    simulateMessage(stream, resultsMsg("hello world good morning"));
    assert.equal(wakeFired, false);
  });

  test("wake debounce: second 'cortex' transcript does NOT re-fire", () => {
    let count = 0;
    const s = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { count++; },
      onTranscript: () => {},
    });
    (s as any).modeChangedAt = 0;

    simulateMessage(s, resultsMsg("cortex"));
    simulateMessage(s, resultsMsg("cortex again"));
    assert.equal(count, 1);
  });

  test("wake debounce resets when mode changes back to wake", () => {
    let count = 0;
    const s = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { count++; },
      onTranscript: () => {},
    });
    (s as any).modeChangedAt = 0;

    simulateMessage(s, resultsMsg("cortex"));
    assert.equal(count, 1);

    // Switch away and back
    s.setMode("command");
    s.setMode("wake");
    (s as any).modeChangedAt = 0;

    simulateMessage(s, resultsMsg("cortex"));
    assert.equal(count, 2);
  });

  test("non-Results message type is ignored", () => {
    simulateMessage(stream, { type: "SpeechStarted" });
    assert.equal(wakeFired, false);
  });

  test("empty transcript is ignored", () => {
    simulateMessage(stream, {
      type: "Results",
      channel: { alternatives: [{ transcript: "   " }] },
    });
    assert.equal(wakeFired, false);
  });
});

// ── Interrupt mode ───────────────────────────────────────────────────

describe("DeepgramVoiceStream — interrupt mode", () => {
  test("'cortex' triggers wake in interrupt mode", () => {
    let woke = false;
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { woke = true; },
      onTranscript: () => {},
    });
    stream.setMode("interrupt");
    (stream as any).modeChangedAt = 0;

    simulateMessage(stream, resultsMsg("cortex"));
    assert.equal(woke, true);
  });

  test("'stop' triggers wake in interrupt mode", () => {
    let woke = false;
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { woke = true; },
      onTranscript: () => {},
    });
    stream.setMode("interrupt");
    (stream as any).modeChangedAt = 0;

    simulateMessage(stream, resultsMsg("stop"));
    assert.equal(woke, true);
  });

  test("'nchinda' does NOT trigger in interrupt mode (self-interrupt bug fix)", () => {
    let woke = false;
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { woke = true; },
      onTranscript: () => {},
    });
    stream.setMode("interrupt");
    (stream as any).modeChangedAt = 0;

    simulateMessage(stream, resultsMsg("I'm Nchinda your assistant"));
    assert.equal(woke, false);
  });

  test("'cancel' and 'never mind' trigger in interrupt mode", () => {
    let count = 0;
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { count++; },
      onTranscript: () => {},
    });
    stream.setMode("interrupt");
    (stream as any).modeChangedAt = 0;

    simulateMessage(stream, resultsMsg("cancel that"));
    assert.equal(count, 1);

    // Reset for next check
    (stream as any).wakeFired = false;
    simulateMessage(stream, resultsMsg("never mind"));
    assert.equal(count, 2);
  });
});

// ── Command mode ─────────────────────────────────────────────────────

describe("DeepgramVoiceStream — command mode", () => {
  test("is_final transcripts accumulate in buffer", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    stream.setMode("command");

    simulateMessage(stream, resultsMsg("schedule a", { is_final: true }));
    simulateMessage(stream, resultsMsg("meeting tomorrow", { is_final: true }));

    assert.deepEqual((stream as any).commandBuffer, [
      "schedule a",
      "meeting tomorrow",
    ]);
  });

  test("speech_final fires onTranscript with concatenated buffer", () => {
    let result = "";
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: (text) => { result = text; },
    });
    stream.setMode("command");

    simulateMessage(stream, resultsMsg("schedule a", { is_final: true }));
    simulateMessage(stream, resultsMsg("meeting tomorrow", { is_final: true, speech_final: true }));

    assert.equal(result, "schedule a meeting tomorrow");
  });

  test("speech_final clears buffer after firing", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    stream.setMode("command");

    simulateMessage(stream, resultsMsg("hello", { is_final: true, speech_final: true }));
    assert.deepEqual((stream as any).commandBuffer, []);
    assert.equal((stream as any).lastPartial, "");
  });

  test("3s silence fallback fires onTranscript", async () => {
    let result = "";
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: (text) => { result = text; },
    });
    stream.setMode("command");

    // Send a final without speech_final — starts the 3s timer
    simulateMessage(stream, resultsMsg("open safari", { is_final: true }));
    assert.equal(result, "", "should not fire immediately");

    // Wait for the 3s silence timer to fire
    await new Promise((r) => setTimeout(r, 3200));
    assert.equal(result, "open safari");
  });

  test("fallback uses lastPartial when buffer is empty", async () => {
    let result = "";
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: (text) => { result = text; },
    });
    stream.setMode("command");

    // Send a non-final (partial only) — no buffer entry, but lastPartial set
    simulateMessage(stream, resultsMsg("what is the weather"));
    assert.equal((stream as any).lastPartial, "what is the weather");

    // Wait for fallback
    await new Promise((r) => setTimeout(r, 3200));
    assert.equal(result, "what is the weather");
  });

  test("onPartial callback fires for every transcript", () => {
    const partials: string[] = [];
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
      onPartial: (text) => { partials.push(text); },
    });
    stream.setMode("command");

    simulateMessage(stream, resultsMsg("hello"));
    simulateMessage(stream, resultsMsg("hello world"));
    assert.deepEqual(partials, ["hello", "hello world"]);
  });
});

// ── Text echo rejection ──────────────────────────────────────────────

describe("DeepgramVoiceStream — text echo rejection", () => {
  test("rejects transcript matching TTS output (>50% overlap)", () => {
    let woke = false;
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { woke = true; },
      onTranscript: () => {},
    });
    (stream as any).modeChangedAt = 0;

    stream.setEchoText("Welcome sir I'm online");
    // Deepgram might punctuate differently
    simulateMessage(stream, resultsMsg("Welcome, sir. I'm online"));
    assert.equal(woke, false, "echo transcript should be rejected");
  });

  test("passes real user speech that does not overlap TTS", () => {
    let woke = false;
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { woke = true; },
      onTranscript: () => {},
    });
    (stream as any).modeChangedAt = 0;

    stream.setEchoText("Welcome sir");
    simulateMessage(stream, resultsMsg("cortex what time is it"));
    assert.equal(woke, true, "real speech should pass through");
  });

  test("echo buffer expires after 4s", async () => {
    let woke = false;
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { woke = true; },
      onTranscript: () => {},
    });
    (stream as any).modeChangedAt = 0;

    stream.setEchoText("cortex hello there");
    // Manually backdate ttsEndedAt so it looks like 5s ago
    (stream as any).ttsEndedAt = Date.now() - 5000;

    simulateMessage(stream, resultsMsg("cortex hello there"));
    // The text matches but the window expired — should pass through as wake
    assert.equal(woke, true, "expired echo buffer should not reject");
  });
});

// ── Timestamp echo rejection ─────────────────────────────────────────

describe("DeepgramVoiceStream — timestamp echo rejection", () => {
  test("rejects transcript that overlaps TTS playback window", () => {
    let woke = false;
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { woke = true; },
      onTranscript: () => {},
    });
    (stream as any).modeChangedAt = 0;

    // Simulate: stream opened at T=10000, TTS played from T=12000 to T=14000
    (stream as any).streamEpochMs = 10000;
    (stream as any).ttsStartedAtMs = 12000;
    (stream as any).ttsEndedAtMs = 14000;

    // Audio segment: start=2.5s (=> 12500ms wall), duration=1s (=> ends 13500ms)
    // This overlaps [12000, 14200] (ttsEnded + 200ms)
    simulateMessage(stream, resultsMsg("cortex", { start: 2.5, duration: 1 }));
    assert.equal(woke, false, "timestamp-overlapping transcript should be rejected");
  });

  test("passes transcript after TTS window + 200ms grace", () => {
    let woke = false;
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { woke = true; },
      onTranscript: () => {},
    });
    (stream as any).modeChangedAt = 0;

    // Stream opened at T=10000, TTS played T=12000 to T=14000
    (stream as any).streamEpochMs = 10000;
    (stream as any).ttsStartedAtMs = 12000;
    (stream as any).ttsEndedAtMs = 14000;

    // Audio segment: start=4.3s (=> 14300ms wall), duration=0.5s
    // 14300 > 14200 (ttsEnded + 200ms), so no overlap with TTS start
    // But we also need ttsStartedAtMs < audioEndMs (14800). 12000 < 14800 = true
    // And audioStartMs < ttsWindowEnd: 14300 < 14200 = false
    // So this should NOT overlap.
    simulateMessage(stream, resultsMsg("cortex", { start: 4.3, duration: 0.5 }));
    assert.equal(woke, true, "transcript after TTS window should pass");
  });

  test("no timestamp rejection when ttsStartedAtMs is 0", () => {
    let woke = false;
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => { woke = true; },
      onTranscript: () => {},
    });
    (stream as any).modeChangedAt = 0;
    (stream as any).streamEpochMs = 10000;
    // ttsStartedAtMs defaults to 0 — no TTS has played

    simulateMessage(stream, resultsMsg("cortex", { start: 1, duration: 0.5 }));
    assert.equal(woke, true, "should not reject when no TTS played");
  });
});

// ── Malformed messages ───────────────────────────────────────────────

describe("DeepgramVoiceStream — malformed input", () => {
  test("invalid JSON does not throw", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    // handleMessage should silently return on bad JSON
    assert.doesNotThrow(() => {
      (stream as any).handleMessage({ data: "not-json{{{" });
    });
  });

  test("missing channel/alternatives does not throw", () => {
    const stream = new DeepgramVoiceStream({
      apiKey: "test-key",
      onWake: () => {},
      onTranscript: () => {},
    });
    assert.doesNotThrow(() => {
      simulateMessage(stream, { type: "Results" });
    });
  });
});
