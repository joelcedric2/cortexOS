import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { TextToSpeech } from '../src/voice/tts.js';

// We mock child_process.execFile at the module boundary
// by testing the public API with known engine selection.

describe('TextToSpeech', () => {
  beforeEach(() => {
    // Clear any env vars that might affect engine selection
    delete process.env['ELEVENLABS_API_KEY'];
  });

  test('starts not speaking', () => {
    const tts = new TextToSpeech({ engine: 'macos-say' });
    assert.equal(tts.isSpeaking(), false);
  });

  test('speak with empty text is a no-op', async () => {
    let started = false;
    const tts = new TextToSpeech({
      engine: 'macos-say',
      onSpeakStart: () => { started = true; },
    });
    await tts.speak('   ');
    assert.equal(started, false);
  });

  test('onSpeakStart and onSpeakEnd callbacks fire', async () => {
    const events: string[] = [];
    // Use a mock that resolves immediately by overriding the internal method
    const tts = new TextToSpeech({
      engine: 'macos-say',
      onSpeakStart: () => events.push('start'),
      onSpeakEnd: () => events.push('end'),
    });

    // Override the private method to avoid actually calling `say`
    // @ts-expect-error accessing private for test
    tts.speakMacos = async () => {};

    await tts.speak('hello');
    assert.deepEqual(events, ['start', 'end']);
    assert.equal(tts.isSpeaking(), false);
  });

  test('throws when speak called while already speaking', async () => {
    const tts = new TextToSpeech({ engine: 'macos-say' });

    // Make speakMacos hang
    // @ts-expect-error accessing private for test
    tts.speakMacos = () => new Promise(() => {}); // never resolves

    const p = tts.speak('hello');

    await assert.rejects(
      () => tts.speak('world'),
      /Already speaking/,
    );

    // Clean up: stop the hanging promise
    tts.stop();
    // p will never resolve naturally, but that's fine for test
    void p.catch(() => {});
  });

  test('stop sets abort signal', async () => {
    const tts = new TextToSpeech({ engine: 'macos-say' });
    let wasAborted = false;

    // @ts-expect-error accessing private for test
    tts.speakMacos = async () => {
      // @ts-expect-error accessing private for test
      const ac: AbortController | null = tts.abortController;
      if (ac) {
        // Schedule stop on next tick so signal is checked
        setTimeout(() => tts.stop(), 5);
        await new Promise<void>((resolve) => {
          ac.signal.addEventListener('abort', () => {
            wasAborted = true;
            resolve();
          });
        });
      }
    };

    await tts.speak('hello');

    assert.equal(wasAborted, true);
    assert.equal(tts.isSpeaking(), false);
  });

  test('engine auto-selection: elevenlabs when API key set', async () => {
    process.env['ELEVENLABS_API_KEY'] = 'test-key-123';
    const tts = new TextToSpeech({});

    let engineUsed = '';
    // @ts-expect-error accessing private for test
    tts.speakElevenLabs = async () => { engineUsed = 'elevenlabs'; };
    // @ts-expect-error accessing private for test
    tts.speakMacos = async () => { engineUsed = 'macos-say'; };
    // @ts-expect-error accessing private for test
    tts.speakPiper = async () => { engineUsed = 'piper'; };

    await tts.speak('hello');
    assert.equal(engineUsed, 'elevenlabs');

    delete process.env['ELEVENLABS_API_KEY'];
  });

  test('engine auto-selection: macos-say when no key and no piper', async () => {
    const tts = new TextToSpeech({});

    let engineUsed = '';
    // @ts-expect-error accessing private for test
    tts.speakElevenLabs = async () => { engineUsed = 'elevenlabs'; };
    // @ts-expect-error accessing private for test
    tts.speakMacos = async () => { engineUsed = 'macos-say'; };
    // @ts-expect-error accessing private for test
    tts.speakPiper = async () => { engineUsed = 'piper'; };

    await tts.speak('hello');
    // Should fall back to macos-say (piper unlikely installed in CI)
    assert.ok(
      engineUsed === 'macos-say' || engineUsed === 'piper',
      `Expected macos-say or piper, got ${engineUsed}`,
    );
  });

  test('explicit engine selection overrides auto-detection', async () => {
    process.env['ELEVENLABS_API_KEY'] = 'test-key-123';
    const tts = new TextToSpeech({ engine: 'macos-say' });

    let engineUsed = '';
    // @ts-expect-error accessing private for test
    tts.speakElevenLabs = async () => { engineUsed = 'elevenlabs'; };
    // @ts-expect-error accessing private for test
    tts.speakMacos = async () => { engineUsed = 'macos-say'; };

    await tts.speak('hello');
    assert.equal(engineUsed, 'macos-say');

    delete process.env['ELEVENLABS_API_KEY'];
  });

  test('elevenlabs throws without API key', async () => {
    const tts = new TextToSpeech({ engine: 'elevenlabs' });

    await assert.rejects(
      () => tts.speak('hello'),
      /ElevenLabs API key not set/,
    );
  });

  test('onSpeakEnd fires even when speak throws', async () => {
    let ended = false;
    const tts = new TextToSpeech({
      engine: 'elevenlabs',
      onSpeakEnd: () => { ended = true; },
    });

    await assert.rejects(() => tts.speak('hello'));
    assert.equal(ended, true);
    assert.equal(tts.isSpeaking(), false);
  });
});
