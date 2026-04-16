import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechToText } from '../src/voice/stt.js';

describe('SpeechToText', () => {
  test('starts not recording', () => {
    const stt = new SpeechToText({});
    assert.equal(stt.isRecording(), false);
  });

  test('stopRecording returns empty string when not recording', async () => {
    const stt = new SpeechToText({});
    const result = await stt.stopRecording();
    assert.equal(result, '');
  });

  test('throws when startRecording called twice', async () => {
    const stt = new SpeechToText({});

    // Mock startRecording internals to avoid needing sox
    // @ts-expect-error accessing private for test
    stt.recording = true;

    await assert.rejects(
      () => stt.startRecording(),
      /Already recording/,
    );

    // Clean up
    // @ts-expect-error accessing private for test
    stt.recording = false;
  });

  test('transcribe falls back when whisper not installed', async () => {
    const stt = new SpeechToText({});

    // Call transcribe directly with a non-existent wav
    // @ts-expect-error accessing private for test
    const result = await stt.transcribe('/nonexistent/file.wav');

    // Should either say whisper not installed or transcription failed
    assert.ok(
      result.includes('whisper not installed') || result.includes('transcription failed'),
      `Unexpected result: ${result}`,
    );
  });

  test('onFinal callback fires on stopRecording', async () => {
    let finalText: string | null = null;
    const stt = new SpeechToText({
      onFinal: (text) => { finalText = text; },
    });

    // Mock: set recording state and tmpWav, mock transcribe
    // @ts-expect-error accessing private for test
    stt.recording = true;
    // @ts-expect-error accessing private for test
    stt.tmpWav = '/tmp/fake.wav';
    // @ts-expect-error accessing private for test
    stt.transcribe = async () => 'hello world';

    const result = await stt.stopRecording();
    assert.equal(result, 'hello world');
    assert.equal(finalText, 'hello world');
    assert.equal(stt.isRecording(), false);
  });

  test('default model is base.en', () => {
    const stt = new SpeechToText({});
    // @ts-expect-error accessing private for test
    assert.equal(stt.model, 'base.en');
  });

  test('default language is en', () => {
    const stt = new SpeechToText({});
    // @ts-expect-error accessing private for test
    assert.equal(stt.language, 'en');
  });

  test('default timeout is 30000ms', () => {
    const stt = new SpeechToText({});
    // @ts-expect-error accessing private for test
    assert.equal(stt.timeoutMs, 30_000);
  });

  test('custom options are stored', () => {
    const stt = new SpeechToText({
      model: 'large-v2',
      language: 'fr',
      timeoutMs: 60_000,
    });
    // @ts-expect-error accessing private for test
    assert.equal(stt.model, 'large-v2');
    // @ts-expect-error accessing private for test
    assert.equal(stt.language, 'fr');
    // @ts-expect-error accessing private for test
    assert.equal(stt.timeoutMs, 60_000);
  });

  test('stopRecording clears partial timer', async () => {
    const stt = new SpeechToText({
      onPartial: () => {},
    });

    // Simulate recording state with a partial timer
    // @ts-expect-error accessing private for test
    stt.recording = true;
    // @ts-expect-error accessing private for test
    stt.tmpWav = '/tmp/fake.wav';
    // @ts-expect-error accessing private for test
    stt.partialTimer = setInterval(() => {}, 2000);
    // @ts-expect-error accessing private for test
    stt.transcribe = async () => 'test';

    await stt.stopRecording();

    // @ts-expect-error accessing private for test
    assert.equal(stt.partialTimer, null);
  });

  test('isRecording reflects state after mock start/stop', async () => {
    const stt = new SpeechToText({});

    assert.equal(stt.isRecording(), false);

    // @ts-expect-error accessing private for test
    stt.recording = true;
    assert.equal(stt.isRecording(), true);

    // @ts-expect-error accessing private for test
    stt.tmpWav = '/tmp/fake.wav';
    // @ts-expect-error accessing private for test
    stt.transcribe = async () => '';

    await stt.stopRecording();
    assert.equal(stt.isRecording(), false);
  });
});
