import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TextToSpeech, DEFAULT_VOICE } from "../src/voice/tts.js";

describe("TextToSpeech (Edge TTS)", () => {
  test("starts not speaking", () => {
    const tts = new TextToSpeech();
    assert.equal(tts.isSpeaking(), false);
  });

  test("default voice is Andrew (warm, confident)", () => {
    assert.equal(DEFAULT_VOICE, "en-US-AndrewMultilingualNeural");
  });

  test("speak with empty text is a no-op", async () => {
    let started = false;
    const tts = new TextToSpeech({ onSpeakStart: () => { started = true; } });
    await tts.speak("   ");
    assert.equal(started, false);
  });

  test("onSpeakStart and onSpeakEnd callbacks fire", async () => {
    const events: string[] = [];
    const tts = new TextToSpeech({
      onSpeakStart: () => events.push("start"),
      onSpeakEnd: () => events.push("end"),
    });
    // Override private method to skip real edge-tts
    // @ts-expect-error accessing private for test
    tts.speakEdge = async () => {};
    await tts.speak("hello");
    assert.deepEqual(events, ["start", "end"]);
    assert.equal(tts.isSpeaking(), false);
  });

  test("throws when speak called while already speaking", async () => {
    const tts = new TextToSpeech();
    // @ts-expect-error accessing private for test
    tts.speakEdge = () => new Promise(() => {}); // never resolves
    const p = tts.speak("hello");
    await assert.rejects(
      () => tts.speak("world"),
      /Already speaking/,
    );
    tts.stop();
    void p.catch(() => {});
  });

  test("stop sets abort signal", async () => {
    const tts = new TextToSpeech();
    let wasAborted = false;
    // @ts-expect-error accessing private for test
    tts.speakEdge = async () => {
      // @ts-expect-error accessing private for test
      const ac: AbortController | null = tts.abortController;
      if (ac) {
        setTimeout(() => tts.stop(), 5);
        await new Promise<void>((resolve) => {
          ac.signal.addEventListener("abort", () => {
            wasAborted = true;
            resolve();
          });
        });
      }
    };
    await tts.speak("hello");
    assert.equal(wasAborted, true);
    assert.equal(tts.isSpeaking(), false);
  });

  test("_resolveSpeak test hook works", async () => {
    const tts = new TextToSpeech();
    tts._armTestPromise();
    const p = tts.speak("hello");
    assert.equal(tts.isSpeaking(), true);
    tts._resolveSpeak();
    await p;
    assert.equal(tts.isSpeaking(), false);
  });

  test("custom voice is respected", () => {
    const tts = new TextToSpeech({ voice: "en-US-AriaNeural" });
    // @ts-expect-error accessing private for test
    assert.equal(tts.voice, "en-US-AriaNeural");
  });
});
