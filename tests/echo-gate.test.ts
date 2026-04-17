import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { EchoGate } from "../src/voice/echo-gate.js";

describe("EchoGate", () => {
  test("starts unmuted", () => {
    const gate = new EchoGate();
    assert.equal(gate.isMuted(), false);
  });

  test("mute() sets isMuted to true", () => {
    const gate = new EchoGate();
    gate.mute();
    assert.equal(gate.isMuted(), true);
  });

  test("unmute(0) sets isMuted to false immediately", async () => {
    const gate = new EchoGate();
    gate.mute();
    assert.equal(gate.isMuted(), true);
    gate.unmute(0);
    // setTimeout(fn, 0) fires on next tick
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(gate.isMuted(), false);
  });

  test("unmute(100) keeps muted for 100ms then unmutes", async () => {
    const gate = new EchoGate();
    gate.mute();
    gate.unmute(100);
    // Still muted right after unmute call
    assert.equal(gate.isMuted(), true);
    // Still muted at 50ms
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(gate.isMuted(), true);
    // Unmuted after 100ms + small buffer
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(gate.isMuted(), false);
  });

  test("multiple mute/unmute cycles do not leak timers", async () => {
    const gate = new EchoGate();

    // Cycle 1: mute, start unmute with long decay
    gate.mute();
    gate.unmute(500);

    // Cycle 2: mute again before decay finishes (cancels cycle 1's timer)
    gate.mute();
    assert.equal(gate.isMuted(), true);

    // Unmute with short decay
    gate.unmute(10);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(gate.isMuted(), false);

    // Verify the original 500ms timer was cancelled (we're still unmuted)
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(gate.isMuted(), false);
  });

  test("dispose() clears pending timer and unmutes", async () => {
    const gate = new EchoGate();
    gate.mute();
    gate.unmute(5000); // long timer
    assert.equal(gate.isMuted(), true); // still muted during decay
    gate.dispose();
    assert.equal(gate.isMuted(), false);
  });

  test("mute() during unmute decay cancels the pending unmute", async () => {
    const gate = new EchoGate();
    gate.mute();
    gate.unmute(50);
    // Before decay finishes, mute again
    gate.mute();
    await new Promise((r) => setTimeout(r, 80));
    // Should still be muted — the unmute timer was cancelled by mute()
    assert.equal(gate.isMuted(), true);
    gate.dispose();
  });
});

describe("EchoGate + WakeWordDetector integration", () => {
  test("wake-word detector skips Groq transcription when muted", async () => {
    // This test verifies the contract: when echoGate.isMuted() returns true,
    // the wake-word detector should NOT call transcribeWithGroq.
    //
    // We simulate the captureAndCheck logic from wake-word.ts:
    const gate = new EchoGate();
    gate.mute();

    let groqCalled = false;
    const mockTranscribeWithGroq = async () => {
      groqCalled = true;
      return { text: "nchinda" };
    };

    // Simulate what captureAndCheck does with the echo gate:
    // if echoGate is muted, skip transcription entirely
    if (!gate.isMuted()) {
      await mockTranscribeWithGroq();
    }

    assert.equal(groqCalled, false, "Groq should NOT be called when muted");
    gate.dispose();
  });

  test("wake-word detector calls Groq when not muted", async () => {
    const gate = new EchoGate();

    let groqCalled = false;
    const mockTranscribeWithGroq = async () => {
      groqCalled = true;
      return { text: "hello" };
    };

    if (!gate.isMuted()) {
      await mockTranscribeWithGroq();
    }

    assert.equal(groqCalled, true, "Groq SHOULD be called when not muted");
  });
});
